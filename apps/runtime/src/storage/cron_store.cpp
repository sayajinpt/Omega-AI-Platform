#include "omega/runtime/storage/cron_store.hpp"

#include "omega/runtime/chat/chat_service.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <httplib.h>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

CronStore::CronStore(ProfileContext& profile) : profile_(profile) {}

std::string CronStore::file_path() const {
  return (fs::path(profile_.profile_home()) / "cron-jobs.json").string();
}

int64_t CronStore::now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

json CronStore::load_all() {
  const fs::path path = file_path();
  if (!fs::exists(path)) return json::array();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_array() ? root : json::array();
  } catch (...) {
    return json::array();
  }
}

void CronStore::persist(const json& jobs) {
  const fs::path path = file_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << jobs.dump(2);
}

int64_t CronStore::compute_next_run(const json& freq, int64_t from_ms) {
  if (!freq.is_object() || !freq.contains("kind")) return from_ms + 60'000;
  const std::string kind = freq["kind"].get<std::string>();
  if (kind == "minutes") {
    const int every = std::max(1, freq.value("every", 1));
    return from_ms + static_cast<int64_t>(every) * 60'000;
  }
  std::time_t t = static_cast<std::time_t>(from_ms / 1000);
  std::tm local{};
#ifdef _WIN32
  localtime_s(&local, &t);
#else
  localtime_r(&t, &local);
#endif
  if (kind == "hourly") {
    local.tm_min = freq.value("minute", 0);
    local.tm_sec = 0;
    std::time_t next = std::mktime(&local);
    if (static_cast<int64_t>(next) * 1000 <= from_ms) {
      local.tm_hour += 1;
      next = std::mktime(&local);
    }
    return static_cast<int64_t>(next) * 1000;
  }
  if (kind == "daily") {
    local.tm_hour = freq.value("hour", 0);
    local.tm_min = freq.value("minute", 0);
    local.tm_sec = 0;
    std::time_t next = std::mktime(&local);
    if (static_cast<int64_t>(next) * 1000 <= from_ms) {
      local.tm_mday += 1;
      next = std::mktime(&local);
    }
    return static_cast<int64_t>(next) * 1000;
  }
  if (kind == "weekly") {
    local.tm_hour = freq.value("hour", 0);
    local.tm_min = freq.value("minute", 0);
    local.tm_sec = 0;
    const int dow = freq.value("dayOfWeek", 0);
    const int diff = (dow - local.tm_wday + 7) % 7;
    local.tm_mday += diff;
    std::time_t next = std::mktime(&local);
    if (static_cast<int64_t>(next) * 1000 <= from_ms) {
      local.tm_mday += 7;
      next = std::mktime(&local);
    }
    return static_cast<int64_t>(next) * 1000;
  }
  if (kind == "custom") {
    const std::string expr = freq.value("cron", "");
    if (expr.size() > 3 && expr.substr(0, 2) == "*/") {
      const int n = std::stoi(expr.substr(2));
      if (n > 0) return from_ms + static_cast<int64_t>(n) * 60'000;
    }
  }
  return from_ms + 60'000;
}

json CronStore::list() { return load_all(); }

json CronStore::save(const json& input) {
  if (!input.is_object()) throw std::runtime_error("job must be an object");
  json jobs = load_all();
  const int64_t now = now_ms();
  const std::string id =
      input.contains("id") && input["id"].is_string() ? input["id"].get<std::string>()
                                                      : random_uuid();
  json job = input;
  job["id"] = id;
  if (!job.contains("createdAt")) job["createdAt"] = now;
  if (!job.contains("nextRunAt") && job.contains("frequency")) {
    job["nextRunAt"] = compute_next_run(job["frequency"], now);
  }
  bool found = false;
  for (auto& j : jobs) {
    if (j.value("id", "") == id) {
      j = job;
      found = true;
      break;
    }
  }
  if (!found) jobs.push_back(job);
  persist(jobs);
  return job;
}

void CronStore::remove(const std::string& id) {
  json jobs = load_all();
  json next = json::array();
  for (const auto& j : jobs) {
    if (j.value("id", "") != id) next.push_back(j);
  }
  persist(next);
}

json CronStore::pause(const std::string& id, bool paused) {
  json jobs = load_all();
  for (auto& j : jobs) {
    if (j.value("id", "") == id) {
      j["enabled"] = !paused;
      persist(jobs);
      return j;
    }
  }
  throw std::runtime_error("cron job not found: " + id);
}

void CronStore::deliver(const json& job, const std::string& text, MemoryStore& memory) {
  if (!job.contains("delivery") || !job["delivery"].is_array()) return;
  const std::string job_name = job.value("name", "cron");
  for (const auto& target : job["delivery"]) {
    if (!target.is_object()) continue;
    const std::string kind = target.value("kind", "");
    if (kind == "memory") {
      try {
        const std::string content = "[cron:" + job_name + "] " + text.substr(0, 4000);
        memory.add("fact", content);
      } catch (...) {
      }
    } else if (kind == "webhook") {
      const std::string url = target.value("url", "");
      if (url.empty()) continue;
      try {
        httplib::Client cli(url);
        cli.set_connection_timeout(10, 0);
        cli.set_read_timeout(15, 0);
        const json payload{{"job", job_name}, {"result", text}, {"at", now_ms()}};
        cli.Post("/", payload.dump(), "application/json");
      } catch (...) {
      }
    }
  }
}

void CronStore::execute_job(json& job, ChatService& chat, MemoryStore& memory) {
  json chat_req{{"model", job.value("modelId", "")},
                {"messages", json::array({json{{"role", "user"}, {"content", job.value("prompt", "")}}})},
                {"sampling", json{{"temperature", 0.4}, {"max_tokens", 1024}}},
                {"agentMode", job.value("agentMode", false)}};
  const json result = chat.send(chat_req);
  const std::string text = result.value("text", "");
  job["lastStatus"] = "ok";
  job["lastError"] = nullptr;
  deliver(job, text, memory);
}

json CronStore::run_now(const std::string& id, ChatService& chat, MemoryStore& memory) {
  json jobs = load_all();
  json* job_ptr = nullptr;
  for (auto& j : jobs) {
    if (j.value("id", "") == id) {
      job_ptr = &j;
      break;
    }
  }
  if (!job_ptr) throw std::runtime_error("cron job not found: " + id);
  json& job = *job_ptr;

  try {
    execute_job(job, chat, memory);
  } catch (const std::exception& e) {
    job["lastStatus"] = "error";
    job["lastError"] = e.what();
    persist(jobs);
    throw;
  }

  const int64_t now = now_ms();
  job["lastRunAt"] = now;
  if (job.contains("frequency")) job["nextRunAt"] = compute_next_run(job["frequency"], now + 1000);
  persist(jobs);
  return job;
}

void CronStore::tick(ChatService& chat, MemoryStore& memory) {
  json jobs = load_all();
  const int64_t now = now_ms();
  bool mutated = false;
  for (auto& job : jobs) {
    if (!job.value("enabled", true)) continue;
    if (job.value("nextRunAt", static_cast<int64_t>(0)) > now) continue;
    try {
      execute_job(job, chat, memory);
    } catch (const std::exception& e) {
      job["lastStatus"] = "error";
      job["lastError"] = e.what();
    }
    job["lastRunAt"] = now;
    if (job.contains("frequency")) {
      job["nextRunAt"] = compute_next_run(job["frequency"], now + 1000);
    }
    mutated = true;
  }
  if (mutated) persist(jobs);
}

}  // namespace omega::runtime

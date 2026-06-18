#include "omega/runtime/storage/kanban_store.hpp"

#include "omega/runtime/chat/chat_service.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

KanbanStore::KanbanStore(ProfileContext& profile) : profile_(profile) {}

std::string KanbanStore::file_path() const {
  return (fs::path(profile_.profile_home()) / "kanban.json").string();
}

int64_t KanbanStore::now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

int KanbanStore::priority_rank(const std::string& p) {
  if (p == "urgent") return 3;
  if (p == "high") return 2;
  if (p == "normal") return 1;
  if (p == "low") return 0;
  return 1;
}

json KanbanStore::load_all() {
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

void KanbanStore::persist(const json& tasks) {
  const fs::path path = file_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << tasks.dump(2);
}

json KanbanStore::list() {
  json tasks = load_all();
  std::sort(tasks.begin(), tasks.end(), [](const json& a, const json& b) {
    const int ra = priority_rank(a.value("priority", "normal"));
    const int rb = priority_rank(b.value("priority", "normal"));
    if (ra != rb) return ra > rb;
    return a.value("createdAt", 0) < b.value("createdAt", 0);
  });
  return tasks;
}

json KanbanStore::save(const json& input) {
  if (!input.contains("title") || !input["title"].is_string())
    throw std::runtime_error("title required");
  json tasks = load_all();
  const int64_t now = now_ms();
  const std::string id =
      input.contains("id") && input["id"].is_string() ? input["id"].get<std::string>()
                                                      : random_uuid();
  json existing;
  for (const auto& t : tasks) {
    if (t.value("id", "") == id) {
      existing = t;
      break;
    }
  }
  json task = input;
  task["id"] = id;
  task["updatedAt"] = now;
  if (!task.contains("createdAt")) task["createdAt"] = existing.value("createdAt", now);
  if (!task.contains("status")) task["status"] = existing.value("status", "backlog");
  if (!task.contains("priority")) task["priority"] = existing.value("priority", "normal");
  if (!task.contains("assignee")) task["assignee"] = existing.value("assignee", "agent");
  if (!task.contains("body")) task["body"] = existing.value("body", "");
  if (!task.contains("skills")) task["skills"] = existing.value("skills", json::array());
  bool found = false;
  for (auto& t : tasks) {
    if (t.value("id", "") == id) {
      t = task;
      found = true;
      break;
    }
  }
  if (!found) tasks.push_back(task);
  persist(tasks);
  return task;
}

json KanbanStore::move(const std::string& id, const std::string& status) {
  json tasks = load_all();
  for (auto& t : tasks) {
    if (t.value("id", "") == id) {
      t["status"] = status;
      t["updatedAt"] = now_ms();
      persist(tasks);
      return t;
    }
  }
  throw std::runtime_error("task not found: " + id);
}

void KanbanStore::remove(const std::string& id) {
  json tasks = load_all();
  json next = json::array();
  for (const auto& t : tasks) {
    if (t.value("id", "") != id) next.push_back(t);
  }
  persist(next);
}

json KanbanStore::dispatch(const std::string& id, ChatService& chat,
                           const std::string& default_model) {
  if (dispatching_.exchange(true)) return json{{"error", "dispatch already in progress"}};

  json out;
  try {
    json tasks = load_all();
    json* target = nullptr;
    if (!id.empty()) {
      for (auto& t : tasks) {
        if (t.value("id", "") == id) {
          target = &t;
          break;
        }
      }
    } else {
      int best_rank = -1;
      for (auto& t : tasks) {
        if (t.value("status", "") != "ready") continue;
        if (t.value("assignee", "") != "agent") continue;
        const int rank = priority_rank(t.value("priority", "normal"));
        if (rank > best_rank) {
          best_rank = rank;
          target = &t;
        }
      }
    }
    if (!target) {
      dispatching_.store(false);
      return json(nullptr);
    }

    json& task = *target;
    const std::string model =
        task.contains("modelId") && task["modelId"].is_string() &&
                !task["modelId"].get<std::string>().empty()
            ? task["modelId"].get<std::string>()
            : default_model;
    if (model.empty()) {
      task["error"] = "no model set for task or default";
      task["status"] = "blocked";
      task["updatedAt"] = now_ms();
      persist(tasks);
      out = task;
      dispatching_.store(false);
      return out;
    }

    task["status"] = "doing";
    task["runStartedAt"] = now_ms();
    task.erase("error");
    persist(tasks);

    std::string prompt = "# Task\n" + task.value("title", "") + "\n\n" + task.value("body", "") +
                         "\n\nProduce a concrete result or report.";
    if (task.contains("skills") && task["skills"].is_array() && !task["skills"].empty()) {
      prompt = "Use skills as needed.\n\n" + prompt;
    }

    try {
      const json chat_result =
          chat.send(json{{"model", model},
                         {"messages", json::array({json{{"role", "user"}, {"content", prompt}}})},
                         {"sampling", json{{"temperature", 0.4}, {"max_tokens", 2048}}},
                         {"agentMode", true}});
      const std::string text = chat_result.value("text", "");
      task["result"] = text;
      task["status"] = "done";
      task["runEndedAt"] = now_ms();
    } catch (const std::exception& e) {
      task["error"] = e.what();
      task["status"] = "blocked";
      task["runEndedAt"] = now_ms();
    }
    task["updatedAt"] = now_ms();
    persist(tasks);
    out = task;
  } catch (...) {
    dispatching_.store(false);
    throw;
  }
  dispatching_.store(false);
  return out;
}

}  // namespace omega::runtime

#include "omega/runtime/storage/finetune_store.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

FinetuneStore::FinetuneStore(ProfileContext& profile) : profile_(profile) {}

std::string FinetuneStore::store_path() const {
  const fs::path dir = fs::path(profile_.profile_home()) / "finetune";
  fs::create_directories(dir);
  return (dir / "jobs.json").string();
}

json FinetuneStore::load_all() const {
  const fs::path path = store_path();
  if (!fs::exists(path)) return json::array();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_array() ? root : json::array();
  } catch (...) {
    return json::array();
  }
}

void FinetuneStore::persist(const json& rows) const {
  std::ofstream out(store_path());
  out << rows.dump(2);
}

json FinetuneStore::list() const { return load_all(); }

std::optional<json> FinetuneStore::get(const std::string& id) const {
  for (const auto& row : load_all()) {
    if (row.value("id", "") == id) return row;
  }
  return std::nullopt;
}

json FinetuneStore::create(const json& input) {
  const std::string id = random_uuid();
  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count();
  json job = input.is_object() ? input : json::object();
  job["id"] = id;
  job["status"] = job.value("status", "preparing");
  job["createdAt"] = now;
  job["updatedAt"] = now;
  if (!job.contains("log")) job["log"] = json::array();
  json rows = load_all();
  rows.push_back(job);
  persist(rows);
  return job;
}

json FinetuneStore::update(const std::string& id, const json& patch) {
  json rows = load_all();
  for (auto& row : rows) {
    if (row.value("id", "") != id) continue;
    if (patch.is_object()) {
      for (auto it = patch.begin(); it != patch.end(); ++it) row[it.key()] = it.value();
    }
    row["updatedAt"] = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    persist(rows);
    return row;
  }
  throw std::runtime_error("job not found: " + id);
}

void FinetuneStore::remove(const std::string& id) {
  json rows = load_all();
  json next = json::array();
  for (const auto& row : rows) {
    if (row.value("id", "") != id) next.push_back(row);
  }
  persist(next);
}

}  // namespace omega::runtime

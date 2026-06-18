#include "omega/runtime/storage/workflow_store.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

WorkflowStore::WorkflowStore(std::string omega_home)
    : file_path_((fs::path(omega_home) / "workflows.json").string()) {}

int64_t WorkflowStore::now_ms() const {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

void WorkflowStore::ensure_loaded() {
  if (loaded_) return;
  loaded_ = true;
  cache_.clear();
  if (!fs::exists(file_path_)) return;
  try {
    std::ifstream in(file_path_);
    json root = json::parse(in);
    if (!root.is_array()) return;
    for (const auto& row : root) cache_.push_back(row);
  } catch (...) {
    cache_.clear();
  }
}

void WorkflowStore::persist() {
  fs::create_directories(fs::path(file_path_).parent_path());
  json arr = json::array();
  for (const auto& w : cache_) arr.push_back(w);
  std::ofstream out(file_path_);
  out << arr.dump(2);
}

json WorkflowStore::list() {
  ensure_loaded();
  json arr = json::array();
  for (const auto& w : cache_) arr.push_back(w);
  return arr;
}

json WorkflowStore::get(const std::string& id) {
  ensure_loaded();
  for (const auto& w : cache_) {
    if (w.value("id", "") == id) return w;
  }
  throw std::runtime_error("workflow not found: " + id);
}

json WorkflowStore::save(const json& input) {
  ensure_loaded();
  if (!input.is_object()) throw std::runtime_error("workflow must be an object");

  const std::string id = input.contains("id") && input["id"].is_string()
                             ? input["id"].get<std::string>()
                             : random_uuid();
  json wf = input;
  wf["id"] = id;
  wf["updatedAt"] = now_ms();

  bool found = false;
  for (auto& w : cache_) {
    if (w.value("id", "") == id) {
      w = wf;
      found = true;
      break;
    }
  }
  if (!found) cache_.push_back(wf);
  persist();
  return wf;
}

void WorkflowStore::remove(const std::string& id) {
  ensure_loaded();
  std::vector<json> next;
  next.reserve(cache_.size());
  for (const auto& w : cache_) {
    if (w.value("id", "") != id) next.push_back(w);
  }
  cache_ = std::move(next);
  persist();
}

}  // namespace omega::runtime

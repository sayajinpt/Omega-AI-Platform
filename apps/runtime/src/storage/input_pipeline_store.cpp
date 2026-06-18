#include "omega/runtime/storage/input_pipeline_store.hpp"

#include "omega/runtime/paths.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

constexpr const char* kDefaultChatId = "omega-default-chat";
constexpr const char* kDefaultContentId = "omega-default-content";

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

bool is_reserved_default_id(const std::string& id) {
  return id == kDefaultChatId || id == kDefaultContentId;
}

bool row_is_builtin(const json& row) {
  if (row.value("builtin", false)) return true;
  const std::string id = row.value("id", "");
  if (is_reserved_default_id(id)) return true;
  const std::string name = row.value("name", "");
  return name == "Chat (default)" || name == "Content Studio (default)";
}

json default_chat_pipeline() {
  const std::string input_id = "user-input";
  const std::string orch_id = "chat-orch";
  return json{{"id", kDefaultChatId},
              {"name", "Chat (default)"},
              {"description", "User input → universal agent tool loop (all model families)"},
              {"scope", "chat"},
              {"builtin", true},
              {"nodes",
               json::array({json{{"id", input_id}, {"kind", "user_input"}, {"label", "User input"}},
                            json{{"id", orch_id},
                                 {"kind", "chat_orchestrator"},
                                 {"label", "Chat orchestrator"}}})},
              {"edges", json::array({json{{"from", input_id}, {"to", orch_id}}})},
              {"updatedAt", now_ms()}};
}

json default_content_pipeline() {
  const std::string input_id = "user-input";
  const std::string orch_id = "chat-orch";
  return json{{"id", kDefaultContentId},
              {"name", "Content Studio (default)"},
              {"description", "User input → orchestrator → TTS / image models"},
              {"scope", "content"},
              {"builtin", true},
              {"nodes",
               json::array({json{{"id", input_id}, {"kind", "user_input"}, {"label", "User input"}},
                            json{{"id", orch_id},
                                 {"kind", "chat_orchestrator"},
                                 {"label", "Chat orchestrator"}},
                            json{{"id", "tts"}, {"kind", "tts_model"}, {"label", "TTS model"}},
                            json{{"id", "image"}, {"kind", "image_model"}, {"label", "Image model"}}})},
              {"edges",
               json::array({json{{"from", input_id}, {"to", orch_id}},
                            json{{"from", orch_id}, {"to", "tts"}},
                            json{{"from", orch_id}, {"to", "image"}}})},
              {"updatedAt", now_ms()}};
}

}  // namespace

InputPipelineStore::InputPipelineStore(ConfigStore& config) : config_(config) {}

std::string InputPipelineStore::file_path() const {
  return (fs::path(omega_home()) / "input-pipelines.json").string();
}

json InputPipelineStore::seed_defaults() {
  return json::array({default_chat_pipeline(), default_content_pipeline()});
}

void InputPipelineStore::ensure_builtin_defaults() {
  bool has_chat = false;
  bool has_content = false;
  for (const auto& row : cache_) {
    if (!row_is_builtin(row)) continue;
    const std::string scope = row.value("scope", "");
    if (scope == "chat") has_chat = true;
    if (scope == "content") has_content = true;
  }
  if (!has_chat) cache_.push_back(default_chat_pipeline());
  if (!has_content) cache_.push_back(default_content_pipeline());
  for (auto& row : cache_) {
    if (row_is_builtin(row)) row["builtin"] = true;
  }
}

void InputPipelineStore::ensure_loaded() {
  if (loaded_) return;
  loaded_ = true;
  const fs::path path = file_path();
  if (!fs::exists(path)) {
    cache_ = seed_defaults();
  } else {
    try {
      std::ifstream in(path);
      json root = json::parse(in);
      cache_ = root.is_array() && !root.empty() ? root : seed_defaults();
    } catch (...) {
      cache_ = seed_defaults();
    }
  }
  ensure_builtin_defaults();
  persist();
}

void InputPipelineStore::persist() {
  const fs::path path = file_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << cache_.dump(2);
}

json InputPipelineStore::list() {
  ensure_loaded();
  return cache_;
}

json InputPipelineStore::get(const std::string& id) {
  ensure_loaded();
  for (const auto& row : cache_) {
    if (row.value("id", "") == id) return row;
  }
  throw std::runtime_error("input pipeline not found: " + id);
}

json InputPipelineStore::save(const json& input) {
  ensure_loaded();
  if (!input.is_object()) throw std::runtime_error("pipeline must be an object");
  std::string id = input.value("id", "");
  if (id.empty()) id = random_uuid();
  json row = input;
  row["id"] = id;
  row["updatedAt"] = now_ms();
  bool found = false;
  for (auto& r : cache_) {
    if (r.value("id", "") == id) {
      if (row_is_builtin(r)) row["builtin"] = true;
      r = row;
      found = true;
      break;
    }
  }
  if (!found) {
    if (is_reserved_default_id(id)) row["id"] = random_uuid();
    cache_.push_back(row);
  }
  persist();
  return row;
}

void InputPipelineStore::remove(const std::string& id) {
  ensure_loaded();
  if (id.empty()) throw std::runtime_error("id required");
  for (const auto& r : cache_) {
    if (r.value("id", "") == id && row_is_builtin(r)) {
      throw std::runtime_error("built-in default pipelines cannot be deleted");
    }
  }
  json next = json::array();
  for (const auto& r : cache_) {
    if (r.value("id", "") != id) next.push_back(r);
  }
  cache_ = std::move(next);
  ensure_builtin_defaults();
  persist();
}

json InputPipelineStore::set_active(const std::string& scope, const std::string& id) {
  const json row = get(id);
  json patch = json::object();
  if (scope == "chat") patch["activeChatPipelineId"] = id;
  else if (scope == "content") patch["activeContentPipelineId"] = id;
  if (!patch.empty()) config_.save_patch(patch);
  return row;
}

json InputPipelineStore::active_for_scope(const std::string& scope) {
  ensure_loaded();
  const json cfg = config_.load();
  const std::string id = scope == "content"   ? cfg.value("activeContentPipelineId", "")
                         : scope == "chat"    ? cfg.value("activeChatPipelineId", "")
                                              : "";
  if (!id.empty()) {
    for (const auto& row : cache_) {
      if (row.value("id", "") == id) return row;
    }
  }
  for (const auto& row : cache_) {
    if (row.value("scope", "") == scope) return row;
  }
  if (!cache_.empty()) return cache_[0];
  cache_ = seed_defaults();
  persist();
  return cache_[0];
}

json InputPipelineStore::resolve_path(const json& pipeline) {
  // Walk user_input → … → chat_orchestrator. Any proxy_model nodes before the orchestrator
  // disable LLM orchestrator (chat uses standard agent mode on proxy-transformed input).
  json out{{"pipeline", pipeline}, {"orchestratorActive", false}, {"proxyNodes", json::array()}};
  if (!pipeline.contains("nodes") || !pipeline["nodes"].is_array()) return out;

  std::string input_id;
  for (const auto& n : pipeline["nodes"]) {
    if (n.value("kind", "") == "user_input") {
      input_id = n.value("id", "");
      break;
    }
  }
  if (input_id.empty()) return out;

  std::string cursor;
  if (pipeline.contains("edges") && pipeline["edges"].is_array()) {
    for (const auto& e : pipeline["edges"]) {
      if (e.value("from", "") == input_id) {
        cursor = e.value("to", "");
        break;
      }
    }
  }

  json proxy_nodes = json::array();
  while (!cursor.empty()) {
    json node;
    for (const auto& n : pipeline["nodes"]) {
      if (n.value("id", "") == cursor) {
        node = n;
        break;
      }
    }
    if (node.is_null()) break;
    const std::string kind = node.value("kind", "");
    if (kind == "proxy_model") {
      proxy_nodes.push_back(node);
      cursor.clear();
      if (pipeline.contains("edges") && pipeline["edges"].is_array()) {
        for (const auto& e : pipeline["edges"]) {
          if (e.value("from", "") == node.value("id", "")) {
            cursor = e.value("to", "");
            break;
          }
        }
      }
      continue;
    }
    if (kind == "chat_orchestrator") {
      out["orchestratorNode"] = node;
      out["orchestratorActive"] = proxy_nodes.empty();
      break;
    }
    break;
  }
  out["proxyNodes"] = proxy_nodes;
  return out;
}

}  // namespace omega::runtime

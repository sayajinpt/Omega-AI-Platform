#pragma once

#include "omega/runtime/storage/database.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class MemoryStore {
 public:
  explicit MemoryStore(Database& db);

  nlohmann::json list(int limit = 500);
  nlohmann::json add(const std::string& kind, const std::string& content,
                     const std::string& session_id = "");
  void remove(const std::string& id);
  nlohmann::json search(const std::string& query, int limit = 8);
  nlohmann::json list_decisions(const std::string& run_id = "");
  nlohmann::json export_bundle(const std::string& profile_id = "default");
  nlohmann::json import_bundle(const nlohmann::json& bundle, const std::string& mode = "merge");
  nlohmann::json run_janitor(int max_entries = 500, int max_age_days = 0);

 private:
  nlohmann::json row_to_entry(sqlite3_stmt* stmt) const;
  std::string escape_fts_or_query(const std::string& query) const;
  int64_t now_ms() const;

  Database& db_;
};

}  // namespace omega::runtime

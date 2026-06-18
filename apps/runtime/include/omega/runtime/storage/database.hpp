#pragma once

#include <nlohmann/json.hpp>
#include <sqlite3.h>

#include <memory>
#include <mutex>
#include <string>

namespace omega::runtime {

struct DatabaseHealth {
  std::string path;
  std::string journal_mode;
  int memory_rows = 0;
  int session_rows = 0;
  int vector_rows = 0;
  int rag_chunk_rows = 0;
};

/** Shared SQLite connection to ~/.omega/memory.db (matches Electron memory store). */
class Database {
 public:
  explicit Database(std::string omega_home);
  ~Database();

  Database(const Database&) = delete;
  Database& operator=(const Database&) = delete;

  sqlite3* handle() const { return db_; }
  const std::string& path() const { return path_; }
  /** Serialize all access — one sqlite3 connection is not thread-safe. */
  std::recursive_mutex& mutex() const { return mu_; }

  nlohmann::json health_json() const;
  int table_count(const char* table) const;

 private:
  void ensure_schema();
  void exec_sql(const char* sql);

  std::string path_;
  sqlite3* db_ = nullptr;
  mutable std::recursive_mutex mu_;
};

}  // namespace omega::runtime

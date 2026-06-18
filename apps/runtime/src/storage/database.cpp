#include "omega/runtime/storage/database.hpp"

#include <filesystem>
#include <stdexcept>

namespace fs = std::filesystem;

namespace omega::runtime {

namespace {

void check_sqlite(int rc, sqlite3* db, const char* ctx) {
  if (rc == SQLITE_OK || rc == SQLITE_DONE || rc == SQLITE_ROW) return;
  const char* msg = db ? sqlite3_errmsg(db) : "sqlite error";
  throw std::runtime_error(std::string(ctx) + ": " + msg);
}

}  // namespace

Database::Database(std::string omega_home) {
  fs::create_directories(omega_home);
  path_ = (fs::path(omega_home) / "memory.db").string();
  check_sqlite(sqlite3_open(path_.c_str(), &db_), db_, "open memory.db");
  sqlite3_busy_timeout(db_, 5000);
  exec_sql("PRAGMA journal_mode = WAL");
  exec_sql("PRAGMA synchronous = NORMAL");
  exec_sql("PRAGMA foreign_keys = ON");
  ensure_schema();
}

Database::~Database() {
  if (db_) {
    sqlite3_close(db_);
    db_ = nullptr;
  }
}

void Database::exec_sql(const char* sql) {
  char* err = nullptr;
  const int rc = sqlite3_exec(db_, sql, nullptr, nullptr, &err);
  if (rc != SQLITE_OK) {
    std::string msg = err ? err : "exec failed";
    sqlite3_free(err);
    throw std::runtime_error(msg);
  }
}

void Database::ensure_schema() {
  exec_sql(R"(
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      embedding BLOB,
      session_id TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED, content, tokenize='porter'
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      parent_id TEXT,
      label TEXT NOT NULL,
      detail TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model_id TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      token_estimate INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      extras TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
      session_id UNINDEXED, title, body, tokenize='porter'
    );
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      chunk_idx INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rag_vectors (
      chunk_id TEXT PRIMARY KEY,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rag_source ON rag_chunks(source);
  )");

  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, "PRAGMA table_info(messages)", -1, &stmt, nullptr) == SQLITE_OK) {
    bool has_extras = false;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
      const char* name = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
      if (name && std::string(name) == "extras") has_extras = true;
    }
    sqlite3_finalize(stmt);
    if (!has_extras) exec_sql("ALTER TABLE messages ADD COLUMN extras TEXT");
  }
}

int Database::table_count(const char* table) const {
  std::lock_guard lock(mu_);
  const std::string sql = std::string("SELECT COUNT(*) FROM ") + table;
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_, sql.c_str(), -1, &stmt, nullptr) != SQLITE_OK) return 0;
  int count = 0;
  if (sqlite3_step(stmt) == SQLITE_ROW) count = sqlite3_column_int(stmt, 0);
  sqlite3_finalize(stmt);
  return count;
}

nlohmann::json Database::health_json() const {
  std::lock_guard lock(mu_);
  sqlite3_stmt* stmt = nullptr;
  std::string journal = "unknown";
  if (sqlite3_prepare_v2(db_, "PRAGMA journal_mode", -1, &stmt, nullptr) == SQLITE_OK) {
    if (sqlite3_step(stmt) == SQLITE_ROW) {
      const char* j = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
      if (j) journal = j;
    }
    sqlite3_finalize(stmt);
  }
  return nlohmann::json{{"path", path_},
                        {"journal_mode", journal},
                        {"memory_rows", table_count("memory")},
                        {"session_rows", table_count("sessions")},
                        {"vector_rows", table_count("rag_vectors")},
                        {"rag_chunk_rows", table_count("rag_chunks")}};
}

}  // namespace omega::runtime

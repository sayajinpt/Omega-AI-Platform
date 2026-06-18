#include "omega/runtime/storage/memory_store.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <stdexcept>

namespace omega::runtime {

MemoryStore::MemoryStore(Database& db) : db_(db) {}

int64_t MemoryStore::now_ms() const {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

nlohmann::json MemoryStore::row_to_entry(sqlite3_stmt* stmt) const {
  nlohmann::json e{{"id", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0))},
                   {"kind", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1))},
                   {"content", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2))},
                   {"createdAt", sqlite3_column_int64(stmt, 3)}};
  if (sqlite3_column_type(stmt, 4) != SQLITE_NULL) {
    const char* sid = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 4));
    if (sid && *sid) e["sessionId"] = sid;
  }
  return e;
}

std::string MemoryStore::escape_fts_or_query(const std::string& query) const {
  std::string out;
  std::string word;
  int terms = 0;
  for (char c : query + ' ') {
    if (std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-') {
      word.push_back(c);
    } else if (!word.empty()) {
      if (word.size() >= 2 && terms < 6) {
        if (!out.empty()) out += " OR ";
        out += '"';
        for (char w : word) {
          if (w == '"') out += "\"\"";
          else out.push_back(w);
        }
        out += '"';
        ++terms;
      }
      word.clear();
    }
  }
  return out;
}

nlohmann::json MemoryStore::list(int limit) {
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT id, kind, content, created_at, session_id FROM memory ORDER BY "
                     "created_at DESC LIMIT ?",
                     -1, &stmt, nullptr);
  sqlite3_bind_int(stmt, 1, limit);
  nlohmann::json rows = nlohmann::json::array();
  while (sqlite3_step(stmt) == SQLITE_ROW) rows.push_back(row_to_entry(stmt));
  sqlite3_finalize(stmt);
  return rows;
}

nlohmann::json MemoryStore::add(const std::string& kind, const std::string& content,
                                const std::string& session_id) {
  const std::string id = random_uuid();
  const int64_t now = now_ms();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "INSERT INTO memory (id, kind, content, created_at, session_id) VALUES (?, ?, "
                     "?, ?, ?)",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, kind.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, content.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 4, now);
  if (session_id.empty()) sqlite3_bind_null(stmt, 5);
  else sqlite3_bind_text(stmt, 5, session_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(stmt);
  sqlite3_finalize(stmt);

  sqlite3_stmt* fts = nullptr;
  sqlite3_prepare_v2(db_.handle(), "INSERT INTO memory_fts (id, content) VALUES (?, ?)", -1, &fts,
                     nullptr);
  sqlite3_bind_text(fts, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(fts, 2, content.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(fts);
  sqlite3_finalize(fts);

  nlohmann::json entry{{"id", id}, {"kind", kind}, {"content", content}, {"createdAt", now}};
  if (!session_id.empty()) entry["sessionId"] = session_id;
  return entry;
}

void MemoryStore::remove(const std::string& id) {
  auto run = [&](const char* sql) {
    sqlite3_stmt* s = nullptr;
    sqlite3_prepare_v2(db_.handle(), sql, -1, &s, nullptr);
    sqlite3_bind_text(s, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(s);
    sqlite3_finalize(s);
  };
  run("DELETE FROM memory WHERE id = ?");
  run("DELETE FROM memory_fts WHERE id = ?");
}

nlohmann::json MemoryStore::search(const std::string& query, int limit) {
  const std::string match = escape_fts_or_query(query);
  if (match.empty()) return nlohmann::json::array();

  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db_.handle(),
                         "SELECT m.id, m.kind, m.content, m.created_at, m.session_id "
                         "FROM memory_fts f JOIN memory m ON m.id = f.id "
                         "WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
                         -1, &stmt, nullptr) != SQLITE_OK) {
    return nlohmann::json::array();
  }
  sqlite3_bind_text(stmt, 1, match.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(stmt, 2, limit);
  nlohmann::json rows = nlohmann::json::array();
  while (sqlite3_step(stmt) == SQLITE_ROW) rows.push_back(row_to_entry(stmt));
  sqlite3_finalize(stmt);
  return rows;
}

nlohmann::json MemoryStore::list_decisions(const std::string& run_id) {
  sqlite3_stmt* stmt = nullptr;
  if (run_id.empty()) {
    sqlite3_prepare_v2(db_.handle(),
                       "SELECT id, run_id, parent_id, label, detail, created_at FROM decisions "
                       "ORDER BY created_at DESC LIMIT 200",
                       -1, &stmt, nullptr);
  } else {
    sqlite3_prepare_v2(db_.handle(),
                       "SELECT id, run_id, parent_id, label, detail, created_at FROM decisions "
                       "WHERE run_id = ? ORDER BY created_at ASC",
                       -1, &stmt, nullptr);
    sqlite3_bind_text(stmt, 1, run_id.c_str(), -1, SQLITE_TRANSIENT);
  }
  nlohmann::json rows = nlohmann::json::array();
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    nlohmann::json row{
        {"id", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0))},
        {"label", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3))},
        {"createdAt", sqlite3_column_int64(stmt, 5)}};
    if (sqlite3_column_type(stmt, 1) != SQLITE_NULL) {
      row["runId"] = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    }
    if (sqlite3_column_type(stmt, 2) != SQLITE_NULL) {
      row["parentId"] = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    }
    if (sqlite3_column_type(stmt, 4) != SQLITE_NULL) {
      row["detail"] = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 4));
    }
    rows.push_back(std::move(row));
  }
  sqlite3_finalize(stmt);
  return rows;
}

nlohmann::json MemoryStore::export_bundle(const std::string& profile_id) {
  return {{"version", 1},
          {"exportedAt", now_ms()},
          {"profileId", profile_id},
          {"entries", list(2000)}};
}

nlohmann::json MemoryStore::import_bundle(const nlohmann::json& bundle,
                                          const std::string& mode) {
  if (bundle.value("version", 0) != 1 || !bundle.contains("entries")) {
    throw std::runtime_error("Invalid memory bundle (expected version 1)");
  }
  if (mode == "replace") {
    sqlite3_exec(db_.handle(), "DELETE FROM memory", nullptr, nullptr, nullptr);
    sqlite3_exec(db_.handle(), "DELETE FROM memory_fts", nullptr, nullptr, nullptr);
  }
  int imported = 0;
  int skipped = 0;
  for (const auto& e : bundle["entries"]) {
    if (!e.contains("content") || e["content"].get<std::string>().empty()) {
      ++skipped;
      continue;
    }
    const std::string id = e.value("id", random_uuid());
    if (mode == "merge") {
      sqlite3_stmt* chk = nullptr;
      sqlite3_prepare_v2(db_.handle(), "SELECT 1 FROM memory WHERE id = ?", -1, &chk, nullptr);
      sqlite3_bind_text(chk, 1, id.c_str(), -1, SQLITE_TRANSIENT);
      if (sqlite3_step(chk) == SQLITE_ROW) {
        sqlite3_finalize(chk);
        ++skipped;
        continue;
      }
      sqlite3_finalize(chk);
    }
    add(e.value("kind", "fact"), e["content"].get<std::string>(),
        e.value("sessionId", ""));
    ++imported;
  }
  return {{"imported", imported}, {"skipped", skipped}};
}

nlohmann::json MemoryStore::run_janitor(int max_entries, int max_age_days) {
  int memory_removed = 0;
  std::string note = "Memory within limits";

  if (max_entries > 0) {
    const int count = db_.table_count("memory");
    if (count > max_entries) {
      const int excess = count - max_entries;
      sqlite3_stmt* stmt = nullptr;
      sqlite3_prepare_v2(db_.handle(), "SELECT id FROM memory ORDER BY created_at ASC LIMIT ?", -1,
                         &stmt, nullptr);
      sqlite3_bind_int(stmt, 1, excess);
      while (sqlite3_step(stmt) == SQLITE_ROW) {
        remove(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0)));
        ++memory_removed;
      }
      sqlite3_finalize(stmt);
      note = "trimmed old memory rows";
    }
  }

  if (max_age_days > 0) {
    const int64_t cutoff = now_ms() - static_cast<int64_t>(max_age_days) * 86400000LL;
    sqlite3_stmt* stmt = nullptr;
    sqlite3_prepare_v2(db_.handle(), "SELECT id FROM memory WHERE created_at < ?", -1, &stmt,
                       nullptr);
    sqlite3_bind_int64(stmt, 1, cutoff);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
      remove(reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0)));
      ++memory_removed;
    }
    sqlite3_finalize(stmt);
  }

  return {{"memoryRemoved", memory_removed}, {"note", note}};
}

}  // namespace omega::runtime

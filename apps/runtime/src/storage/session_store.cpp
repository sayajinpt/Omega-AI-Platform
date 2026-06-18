#include "omega/runtime/storage/session_store.hpp"

#include "omega/runtime/json_safe.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <chrono>
#include <cctype>
#include <stdexcept>
#include <vector>
#include <functional>

namespace omega::runtime {

SessionStore::SessionStore(Database& db) : db_(db) {}

int64_t SessionStore::now_ms() const {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

std::string SessionStore::escape_fts_query(const std::string& query) const {
  std::string out;
  std::string word;
  int terms = 0;
  for (char c : query + ' ') {
    if (std::isalnum(static_cast<unsigned char>(c)) || c == '_' || c == '-') {
      word.push_back(c);
    } else if (!word.empty()) {
      if (word.size() >= 2 && terms < 12) {
        if (!out.empty()) out += ' ';
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

void SessionStore::index_session_fts(const std::string& session_id, const std::string& title,
                                     const std::string& body) {
  sqlite3* conn = db_.handle();
  sqlite3_stmt* del = nullptr;
  sqlite3_prepare_v2(conn, "DELETE FROM sessions_fts WHERE session_id = ?", -1, &del, nullptr);
  sqlite3_bind_text(del, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(del);
  sqlite3_finalize(del);

  sqlite3_stmt* ins = nullptr;
  sqlite3_prepare_v2(conn, "INSERT INTO sessions_fts (session_id, title, body) VALUES (?, ?, ?)", -1,
                     &ins, nullptr);
  sqlite3_bind_text(ins, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(ins, 2, title.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(ins, 3, body.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(ins);
  sqlite3_finalize(ins);
}

nlohmann::json SessionStore::list_sessions() {
  const auto _db = db_lock();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(
      db_.handle(),
      "SELECT id, title, model_id, system_prompt, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
      -1, &stmt, nullptr);
  nlohmann::json rows = nlohmann::json::array();
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    rows.push_back(
        {{"id", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0))},
         {"title", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1))},
         {"modelId", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2))},
         {"model_id", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2))},
         {"systemPrompt", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3))},
         {"system_prompt", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3))},
         {"createdAt", sqlite3_column_int64(stmt, 4)},
         {"created_at", sqlite3_column_int64(stmt, 4)},
         {"updatedAt", sqlite3_column_int64(stmt, 5)},
         {"updated_at", sqlite3_column_int64(stmt, 5)}});
  }
  sqlite3_finalize(stmt);
  return rows;
}

nlohmann::json SessionStore::create_session(const std::string& title, const std::string& model_id,
                                            const std::string& system_prompt) {
  const auto _db = db_lock();
  const std::string id = random_uuid();
  const int64_t now = now_ms();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "INSERT INTO sessions (id, title, model_id, system_prompt, created_at, updated_at) "
                     "VALUES (?, ?, ?, ?, ?, ?)",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, title.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, model_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 4, system_prompt.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 5, now);
  sqlite3_bind_int64(stmt, 6, now);
  if (sqlite3_step(stmt) != SQLITE_DONE) {
    sqlite3_finalize(stmt);
    throw std::runtime_error("create session failed");
  }
  sqlite3_finalize(stmt);
  index_session_fts(id, title, "");
  return {{"id", id},
          {"title", title},
          {"modelId", model_id},
          {"systemPrompt", system_prompt},
          {"createdAt", now},
          {"updatedAt", now}};
}

void SessionStore::delete_session(const std::string& id) {
  const auto _db = db_lock();
  sqlite3* conn = db_.handle();
  auto run = [&](const char* sql) {
    sqlite3_stmt* s = nullptr;
    sqlite3_prepare_v2(conn, sql, -1, &s, nullptr);
    sqlite3_bind_text(s, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(s);
    sqlite3_finalize(s);
  };
  run("DELETE FROM messages WHERE session_id = ?");
  run("DELETE FROM sessions_fts WHERE session_id = ?");
  run("DELETE FROM sessions WHERE id = ?");
}

void SessionStore::update_title(const std::string& id, const std::string& title) {
  const auto _db = db_lock();
  std::string trimmed = title;
  if (trimmed.size() > 120) trimmed.resize(120);
  if (trimmed.empty()) trimmed = "New chat";
  const int64_t now = now_ms();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(), "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?", -1,
                     &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, trimmed.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 2, now);
  sqlite3_bind_text(stmt, 3, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  const auto msgs = get_messages(id);
  std::string body;
  for (const auto& m : msgs) body += m.value("content", "") + '\n';
  index_session_fts(id, trimmed, body);
}

void SessionStore::update_model_id(const std::string& id, const std::string& model_id) {
  const auto _db = db_lock();
  if (id.empty() || model_id.empty()) return;
  const int64_t now = now_ms();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(), "UPDATE sessions SET model_id = ?, updated_at = ? WHERE id = ?",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, model_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 2, now);
  sqlite3_bind_text(stmt, 3, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(stmt);
  sqlite3_finalize(stmt);
}

nlohmann::json SessionStore::get_messages(const std::string& session_id) {
  const auto _db = db_lock();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT role, content, extras, created_at FROM messages WHERE session_id = ? "
                     "ORDER BY created_at ASC, id ASC",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);
  nlohmann::json rows = nlohmann::json::array();
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    nlohmann::json row{{"role", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0))},
                       {"content", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1))},
                       {"created_at", sqlite3_column_int64(stmt, 3)}};
    const char* extras = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    if (extras && *extras) {
      try {
        const nlohmann::json ex = nlohmann::json::parse(extras);
        if (ex.contains("parts")) row["parts"] = ex["parts"];
        if (ex.contains("attachments")) row["attachments"] = ex["attachments"];
      } catch (...) {
      }
    }
    rows.push_back(std::move(row));
  }
  sqlite3_finalize(stmt);
  return rows;
}

nlohmann::json SessionStore::search(const std::string& query, int limit) {
  const auto _db = db_lock();
  if (query.empty()) return list_sessions();
  const std::string match = escape_fts_query(query);
  if (match.empty()) return nlohmann::json::array();

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT s.id, s.title, s.model_id, s.system_prompt, s.created_at, s.updated_at "
                     "FROM sessions_fts f JOIN sessions s ON s.id = f.session_id "
                     "WHERE sessions_fts MATCH ? ORDER BY rank LIMIT ?",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, match.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(stmt, 2, limit);
  nlohmann::json rows = nlohmann::json::array();
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    rows.push_back(
        {{"id", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0))},
         {"title", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1))},
         {"modelId", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2))},
         {"systemPrompt", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 3))},
         {"createdAt", sqlite3_column_int64(stmt, 4)},
         {"updatedAt", sqlite3_column_int64(stmt, 5)}});
  }
  sqlite3_finalize(stmt);
  return rows;
}

nlohmann::json SessionStore::fork_session(const std::string& source_id) {
  const auto _db = db_lock();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT title, model_id, system_prompt FROM sessions WHERE id = ?", -1, &stmt,
                     nullptr);
  sqlite3_bind_text(stmt, 1, source_id.c_str(), -1, SQLITE_TRANSIENT);
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    throw std::runtime_error("session not found: " + source_id);
  }
  std::string src_title = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
  std::string model_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
  std::string system_prompt = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
  sqlite3_finalize(stmt);

  std::string title = ("Fork · " + src_title).substr(0, 120);
  nlohmann::json forked = create_session(title, model_id, system_prompt);
  const std::string fork_id = forked["id"].get<std::string>();
  for (const auto& m : get_messages(source_id)) {
    nlohmann::json extras = nullptr;
    if (m.contains("parts") || m.contains("attachments")) {
      extras = nlohmann::json{{"parts", m.value("parts", nlohmann::json::array())},
                              {"attachments", m.value("attachments", nlohmann::json::array())}};
    }
    append_message(fork_id, m["role"].get<std::string>(), m["content"].get<std::string>(), extras);
  }
  return {{"id", fork_id}, {"title", title}};
}

void SessionStore::truncate_messages(const std::string& session_id, int from_index) {
  const auto _db = db_lock();
  if (from_index <= 0) {
    sqlite3_stmt* del = nullptr;
    sqlite3_prepare_v2(db_.handle(), "DELETE FROM messages WHERE session_id = ?", -1, &del, nullptr);
    sqlite3_bind_text(del, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(del);
    sqlite3_finalize(del);
    sqlite3_stmt* upd = nullptr;
    sqlite3_prepare_v2(db_.handle(),
                       "UPDATE sessions SET updated_at = ?, token_estimate = 0 WHERE id = ?", -1,
                       &upd, nullptr);
    sqlite3_bind_int64(upd, 1, now_ms());
    sqlite3_bind_text(upd, 2, session_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(upd);
    sqlite3_finalize(upd);
    return;
  }

  nlohmann::json msgs = get_messages(session_id);
  if (from_index >= static_cast<int>(msgs.size())) return;

  sqlite3_stmt* ids = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT id FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
                     -1, &ids, nullptr);
  sqlite3_bind_text(ids, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);
  std::vector<std::string> to_delete;
  int idx = 0;
  while (sqlite3_step(ids) == SQLITE_ROW) {
    if (idx >= from_index) {
      to_delete.emplace_back(reinterpret_cast<const char*>(sqlite3_column_text(ids, 0)));
    }
    ++idx;
  }
  sqlite3_finalize(ids);

  for (const auto& mid : to_delete) {
    sqlite3_stmt* del = nullptr;
    sqlite3_prepare_v2(db_.handle(), "DELETE FROM messages WHERE id = ?", -1, &del, nullptr);
    sqlite3_bind_text(del, 1, mid.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(del);
    sqlite3_finalize(del);
  }

  sqlite3_stmt* upd = nullptr;
  sqlite3_prepare_v2(db_.handle(), "UPDATE sessions SET updated_at = ? WHERE id = ?", -1, &upd,
                     nullptr);
  sqlite3_bind_int64(upd, 1, now_ms());
  sqlite3_bind_text(upd, 2, session_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(upd);
  sqlite3_finalize(upd);
}

void SessionStore::append_message(const std::string& session_id, const std::string& role,
                                  const std::string& content, const nlohmann::json& extras) {
  const auto _db = db_lock();
  const std::string id = random_uuid();
  const int64_t now = now_ms();
  std::string extras_str;
  const char* extras_ptr = nullptr;
  if (!extras.is_null() && !extras.empty()) {
    extras_str = json_dump_safe(extras);
    extras_ptr = extras_str.c_str();
  }
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "INSERT INTO messages (id, session_id, role, content, extras, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?)",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, session_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, role.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 4, content.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 5, extras_ptr, -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 6, now);
  sqlite3_step(stmt);
  sqlite3_finalize(stmt);

  sqlite3_stmt* upd = nullptr;
  sqlite3_prepare_v2(db_.handle(), "UPDATE sessions SET updated_at = ? WHERE id = ?", -1, &upd,
                     nullptr);
  sqlite3_bind_int64(upd, 1, now);
  sqlite3_bind_text(upd, 2, session_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(upd);
  sqlite3_finalize(upd);
}

std::optional<SessionStore::AssistantPatch> SessionStore::patch_assistant_message_with_job(
    const std::string& session_id, const std::string& job_id,
    const std::function<void(nlohmann::json& parts, std::string& content)>& mutator) {
  const auto _db = db_lock();
  const std::string jid = job_id;
  if (jid.empty()) return std::nullopt;

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT id, content, extras FROM messages WHERE session_id = ? AND role = "
                     "'assistant' ORDER BY created_at ASC, id ASC",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);

  struct Row {
    std::string id;
    std::string content;
    nlohmann::json parts;
    nlohmann::json attachments;
  };
  std::vector<Row> rows;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    Row row;
    row.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    row.content = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    const char* extras = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    if (extras && *extras) {
      try {
        const nlohmann::json ex = nlohmann::json::parse(extras);
        if (ex.contains("parts")) row.parts = ex["parts"];
        if (ex.contains("attachments")) row.attachments = ex["attachments"];
      } catch (...) {
      }
    }
    rows.push_back(std::move(row));
  }
  sqlite3_finalize(stmt);
  if (rows.empty()) return std::nullopt;

  auto apply = [&](Row& row) -> AssistantPatch {
    nlohmann::json parts = row.parts.is_array() ? row.parts : nlohmann::json::array();
    std::string content = row.content;
    mutator(parts, content);
    const nlohmann::json extras = nlohmann::json{{"parts", parts}, {"attachments", row.attachments}};
    const std::string extras_str = json_dump_safe(extras);

    sqlite3_stmt* upd = nullptr;
    sqlite3_prepare_v2(db_.handle(), "UPDATE messages SET content = ?, extras = ? WHERE id = ?", -1,
                       &upd, nullptr);
    sqlite3_bind_text(upd, 1, content.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(upd, 2, extras_str.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(upd, 3, row.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(upd);
    sqlite3_finalize(upd);

    sqlite3_stmt* sess = nullptr;
    sqlite3_prepare_v2(db_.handle(), "UPDATE sessions SET updated_at = ? WHERE id = ?", -1, &sess,
                         nullptr);
    sqlite3_bind_int64(sess, 1, now_ms());
    sqlite3_bind_text(sess, 2, session_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(sess);
    sqlite3_finalize(sess);

    AssistantPatch patch;
    patch.content = content;
    patch.parts = parts;
    return patch;
  };

  for (int i = static_cast<int>(rows.size()) - 1; i >= 0; --i) {
    auto& row = rows[static_cast<size_t>(i)];
    if (!row.parts.is_array()) continue;
    bool has_job = false;
    for (const auto& p : row.parts) {
      const std::string ptype = p.value("type", "");
      if ((ptype == "content_studio" || ptype == "direct_video") && p.value("jobId", "") == jid) {
        has_job = true;
        break;
      }
    }
    if (!has_job) continue;
    auto patch = apply(row);
    patch.message_index = i;
    return patch;
  }

  return std::nullopt;
}

std::optional<SessionStore::AssistantPatch> SessionStore::patch_latest_assistant_message(
    const std::string& session_id,
    const std::function<void(nlohmann::json& parts, std::string& content)>& mutator) {
  const auto _db = db_lock();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT id, content, extras FROM messages WHERE session_id = ? AND role = "
                     "'assistant' ORDER BY created_at ASC, id ASC",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);

  struct Row {
    std::string id;
    std::string content;
    nlohmann::json parts;
    nlohmann::json attachments;
  };
  std::vector<Row> rows;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    Row row;
    row.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    row.content = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    const char* extras = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    if (extras && *extras) {
      try {
        const nlohmann::json ex = nlohmann::json::parse(extras);
        if (ex.contains("parts")) row.parts = ex["parts"];
        if (ex.contains("attachments")) row.attachments = ex["attachments"];
      } catch (...) {
      }
    }
    rows.push_back(std::move(row));
  }
  sqlite3_finalize(stmt);
  if (rows.empty()) return std::nullopt;

  auto apply = [&](Row& row) -> AssistantPatch {
    nlohmann::json parts = row.parts.is_array() ? row.parts : nlohmann::json::array();
    std::string content = row.content;
    mutator(parts, content);
    const nlohmann::json extras = nlohmann::json{{"parts", parts}, {"attachments", row.attachments}};
    const std::string extras_str = json_dump_safe(extras);

    sqlite3_stmt* upd = nullptr;
    sqlite3_prepare_v2(db_.handle(), "UPDATE messages SET content = ?, extras = ? WHERE id = ?", -1,
                       &upd, nullptr);
    sqlite3_bind_text(upd, 1, content.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(upd, 2, extras_str.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(upd, 3, row.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(upd);
    sqlite3_finalize(upd);

    sqlite3_stmt* sess = nullptr;
    sqlite3_prepare_v2(db_.handle(), "UPDATE sessions SET updated_at = ? WHERE id = ?", -1, &sess,
                       nullptr);
    sqlite3_bind_int64(sess, 1, now_ms());
    sqlite3_bind_text(sess, 2, session_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(sess);
    sqlite3_finalize(sess);

    AssistantPatch patch;
    patch.content = content;
    patch.parts = parts;
    return patch;
  };

  auto patch = apply(rows.back());
  patch.message_index = static_cast<int>(rows.size()) - 1;
  return patch;
}

void SessionStore::strip_content_studio_parts(const std::string& session_id) {
  const auto _db = db_lock();
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT id, content, extras FROM messages WHERE session_id = ? AND role = "
                     "'assistant' ORDER BY created_at ASC, id ASC",
                     -1, &stmt, nullptr);
  sqlite3_bind_text(stmt, 1, session_id.c_str(), -1, SQLITE_TRANSIENT);

  struct Row {
    std::string id;
    std::string content;
    nlohmann::json parts;
    nlohmann::json attachments;
  };
  std::vector<Row> rows;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    Row row;
    row.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    row.content = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    const char* extras = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    if (extras && *extras) {
      try {
        const nlohmann::json ex = nlohmann::json::parse(extras);
        if (ex.contains("parts")) row.parts = ex["parts"];
        if (ex.contains("attachments")) row.attachments = ex["attachments"];
      } catch (...) {
      }
    }
    rows.push_back(std::move(row));
  }
  sqlite3_finalize(stmt);

  for (auto& row : rows) {
    if (!row.parts.is_array()) continue;
    nlohmann::json kept = nlohmann::json::array();
    bool changed = false;
    for (const auto& p : row.parts) {
      if (p.value("type", "") == "content_studio") {
        changed = true;
        continue;
      }
      kept.push_back(p);
    }
    if (!changed) continue;
    row.parts = kept;
    const nlohmann::json extras = nlohmann::json{{"parts", row.parts}, {"attachments", row.attachments}};
    const std::string extras_str = json_dump_safe(extras);

    sqlite3_stmt* upd = nullptr;
    sqlite3_prepare_v2(db_.handle(), "UPDATE messages SET content = ?, extras = ? WHERE id = ?", -1,
                       &upd, nullptr);
    sqlite3_bind_text(upd, 1, row.content.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(upd, 2, extras_str.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(upd, 3, row.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(upd);
    sqlite3_finalize(upd);
  }

  if (!rows.empty()) {
    sqlite3_stmt* sess = nullptr;
    sqlite3_prepare_v2(db_.handle(), "UPDATE sessions SET updated_at = ? WHERE id = ?", -1, &sess,
                       nullptr);
    sqlite3_bind_int64(sess, 1, now_ms());
    sqlite3_bind_text(sess, 2, session_id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_step(sess);
    sqlite3_finalize(sess);
  }
}

}  // namespace omega::runtime

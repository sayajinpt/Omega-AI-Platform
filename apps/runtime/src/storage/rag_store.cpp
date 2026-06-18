#include "omega/runtime/storage/rag_store.hpp"

#include "omega/runtime/util/text_files.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

constexpr int64_t k_max_file_bytes = 4 * 1024 * 1024;

std::string read_file_utf8(const fs::path& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) throw std::runtime_error("cannot read file: " + path.string());
  in.seekg(0, std::ios::end);
  const auto sz = in.tellg();
  if (sz < 0 || sz > k_max_file_bytes) return {};
  in.seekg(0, std::ios::beg);
  std::string data(static_cast<size_t>(sz), '\0');
  in.read(data.data(), sz);
  return data;
}

}  // namespace

RagStore::RagStore(Database& db, EngineClient& engine, ConfigStore& config)
    : db_(db), engine_(engine), config_(config) {}

std::string RagStore::default_model() const {
  const json cfg = config_.load();
  return cfg.value("defaultModel", "");
}

std::vector<float> RagStore::embed_text(const std::string& model, const std::string& text) {
  if (model.empty()) return {};
  try {
    const json data =
        engine_.command("chat.embed", json{{"model", model}, {"text", text}}, 120000);
    if (!data.contains("vector") || !data["vector"].is_array()) return {};
    std::vector<float> out;
    for (const auto& v : data["vector"]) out.push_back(v.get<float>());
    return out;
  } catch (...) {
    return {};
  }
}

float RagStore::cosine(const std::vector<float>& a, const std::vector<float>& b) {
  if (a.size() != b.size() || a.empty()) return 0.f;
  double dot = 0, na = 0, nb = 0;
  for (size_t i = 0; i < a.size(); ++i) {
    dot += static_cast<double>(a[i]) * b[i];
    na += static_cast<double>(a[i]) * a[i];
    nb += static_cast<double>(b[i]) * b[i];
  }
  const double d = std::sqrt(na) * std::sqrt(nb);
  return d == 0 ? 0.f : static_cast<float>(dot / d);
}

std::vector<float> RagStore::blob_to_floats(const void* data, int bytes, int dim) {
  std::vector<float> out(static_cast<size_t>(dim));
  if (bytes < dim * static_cast<int>(sizeof(float))) return out;
  std::memcpy(out.data(), data, static_cast<size_t>(dim) * sizeof(float));
  return out;
}

nlohmann::json RagStore::list_sources() {
  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT source, COUNT(*) as n FROM rag_chunks GROUP BY source ORDER BY source",
                     -1, &stmt, nullptr);
  json rows = json::array();
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    rows.push_back({{"source", reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0))},
                    {"chunks", sqlite3_column_int(stmt, 1)}});
  }
  sqlite3_finalize(stmt);
  return rows;
}

void RagStore::clear_index(const std::string& source) {
  sqlite3* conn = db_.handle();
  if (source.empty()) {
    sqlite3_exec(conn, "DELETE FROM rag_vectors; DELETE FROM rag_chunks;", nullptr, nullptr,
                 nullptr);
    return;
  }
  sqlite3_stmt* sel = nullptr;
  sqlite3_prepare_v2(conn, "SELECT id FROM rag_chunks WHERE source = ?", -1, &sel, nullptr);
  sqlite3_bind_text(sel, 1, source.c_str(), -1, SQLITE_TRANSIENT);
  while (sqlite3_step(sel) == SQLITE_ROW) {
    const char* id = reinterpret_cast<const char*>(sqlite3_column_text(sel, 0));
    sqlite3_stmt* del = nullptr;
    sqlite3_prepare_v2(conn, "DELETE FROM rag_vectors WHERE chunk_id = ?", -1, &del, nullptr);
    sqlite3_bind_text(del, 1, id, -1, SQLITE_TRANSIENT);
    sqlite3_step(del);
    sqlite3_finalize(del);
  }
  sqlite3_finalize(sel);
  sqlite3_stmt* del_chunks = nullptr;
  sqlite3_prepare_v2(conn, "DELETE FROM rag_chunks WHERE source = ?", -1, &del_chunks, nullptr);
  sqlite3_bind_text(del_chunks, 1, source.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_step(del_chunks);
  sqlite3_finalize(del_chunks);
}

json RagStore::index_file(const std::string& abs_path, const std::string& model_id) {
  const fs::path path = fs::absolute(abs_path);
  const std::string ext = path.extension().string();
  if (!is_text_extension(ext)) return json{{"chunks", 0}};

  std::error_code ec;
  if (!fs::exists(path, ec) || !fs::is_regular_file(path, ec)) {
    throw std::runtime_error("file not found: " + abs_path);
  }
  if (fs::file_size(path, ec) > k_max_file_bytes) return json{{"chunks", 0}};

  const std::string text = read_file_utf8(path);
  if (text.empty()) return json{{"chunks", 0}};

  const std::string model = model_id.empty() ? default_model() : model_id;
  const auto chunks = chunk_text(text);
  const int64_t created_at = std::chrono::duration_cast<std::chrono::milliseconds>(
                                 std::chrono::system_clock::now().time_since_epoch())
                                 .count();
  const std::string source = path.string();

  clear_index(source);

  struct ChunkRow {
    std::string id;
    std::string content;
  };
  std::vector<ChunkRow> rows;
  rows.reserve(chunks.size());

  sqlite3* conn = db_.handle();
  sqlite3_stmt* ins = nullptr;
  sqlite3_prepare_v2(
      conn,
      "INSERT INTO rag_chunks (id, source, chunk_idx, content, created_at) VALUES (?, ?, ?, ?, ?)",
      -1, &ins, nullptr);

  for (size_t idx = 0; idx < chunks.size(); ++idx) {
    const std::string id = random_uuid();
    sqlite3_bind_text(ins, 1, id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(ins, 2, source.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(ins, 3, static_cast<int>(idx));
    sqlite3_bind_text(ins, 4, chunks[idx].c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(ins, 5, created_at);
    sqlite3_step(ins);
    sqlite3_reset(ins);
    rows.push_back({id, chunks[idx]});
  }
  sqlite3_finalize(ins);

  int embedded = 0;
  sqlite3_stmt* ins_vec = nullptr;
  sqlite3_prepare_v2(conn, "INSERT OR REPLACE INTO rag_vectors (chunk_id, dim, vec) VALUES (?, ?, ?)",
                     -1, &ins_vec, nullptr);

  for (const auto& row : rows) {
    const std::vector<float> vec = embed_text(model, row.content);
    if (vec.empty()) continue;
    sqlite3_bind_text(ins_vec, 1, row.id.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int(ins_vec, 2, static_cast<int>(vec.size()));
    sqlite3_bind_blob(ins_vec, 3, vec.data(), static_cast<int>(vec.size() * sizeof(float)),
                      SQLITE_TRANSIENT);
    sqlite3_step(ins_vec);
    sqlite3_reset(ins_vec);
    ++embedded;
  }
  sqlite3_finalize(ins_vec);

  return json{{"chunks", static_cast<int>(chunks.size())},
              {"embedded", embedded},
              {"source", source}};
}

json RagStore::index_directory(const std::string& abs_dir, const std::string& model_id) {
  const std::string model = model_id.empty() ? default_model() : model_id;
  int files = 0;
  int chunks = 0;
  walk_text_files(fs::absolute(abs_dir), [&](const fs::path& file) {
    try {
      const json r = index_file(file.string(), model);
      const int n = r.value("chunks", 0);
      if (n > 0) {
        ++files;
        chunks += n;
      }
    } catch (...) {
    }
  });
  return json{{"files", files}, {"chunks", chunks}};
}

json RagStore::search(const std::string& query, const std::string& model_id, int limit) {
  const std::string model = model_id.empty() ? default_model() : model_id;
  const std::vector<float> q = embed_text(model, query);
  if (q.empty()) return json::array();

  sqlite3_stmt* stmt = nullptr;
  sqlite3_prepare_v2(db_.handle(),
                     "SELECT c.source, c.chunk_idx, c.content, v.dim, v.vec "
                     "FROM rag_chunks c JOIN rag_vectors v ON v.chunk_id = c.id",
                     -1, &stmt, nullptr);

  struct Scored {
    std::string source;
    int chunk_idx;
    std::string content;
    float score;
  };
  std::vector<Scored> scored;

  while (sqlite3_step(stmt) == SQLITE_ROW) {
    const int dim = sqlite3_column_int(stmt, 3);
    const void* blob = sqlite3_column_blob(stmt, 4);
    const int bytes = sqlite3_column_bytes(stmt, 4);
    const auto vec = blob_to_floats(blob, bytes, dim);
    Scored row{reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0)),
               sqlite3_column_int(stmt, 1),
               reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2)),
               cosine(q, vec)};
    scored.push_back(std::move(row));
  }
  sqlite3_finalize(stmt);

  std::sort(scored.begin(), scored.end(),
            [](const Scored& a, const Scored& b) { return a.score > b.score; });

  json out = json::array();
  for (int i = 0; i < limit && i < static_cast<int>(scored.size()); ++i) {
    out.push_back({{"source", scored[static_cast<size_t>(i)].source},
                   {"chunkIdx", scored[static_cast<size_t>(i)].chunk_idx},
                   {"content", scored[static_cast<size_t>(i)].content},
                   {"score", scored[static_cast<size_t>(i)].score}});
  }
  return out;
}

}  // namespace omega::runtime

#include "omega/runtime/storage/usage_store.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

UsageStore::UsageStore(ProfileContext& profile) : profile_(profile) {}

std::string UsageStore::path() const {
  return (fs::path(profile_.profile_home()) / "usage.json").string();
}

json UsageStore::load_all() const {
  const fs::path p = path();
  if (!fs::exists(p)) return json::array();
  try {
    std::ifstream in(p);
    json root = json::parse(in);
    return root.is_array() ? root : json::array();
  } catch (...) {
    return json::array();
  }
}

void UsageStore::save_all(const json& rows) const {
  const fs::path p = path();
  fs::create_directories(p.parent_path());
  std::ofstream out(p);
  out << rows.dump(2);
}

void UsageStore::record(const std::string& session_id, const std::string& model_id, int tokens_in,
                        int tokens_out, double cost_usd) {
  if (tokens_in <= 0 && tokens_out <= 0) return;
  json rows = load_all();
  if (!rows.is_array()) rows = json::array();
  const int64_t ts = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
  rows.push_back(json{{"sessionId", session_id},
                      {"modelId", model_id},
                      {"tokensIn", tokens_in},
                      {"tokensOut", tokens_out},
                      {"costUsd", cost_usd},
                      {"ts", ts}});
  while (rows.size() > 5000) {
    rows.erase(rows.begin());
  }
  save_all(rows);
}

int UsageStore::remove_session_records(const std::string& session_id) {
  if (session_id.empty()) return 0;
  json rows = load_all();
  if (!rows.is_array()) return 0;
  json kept = json::array();
  int removed = 0;
  for (const auto& row : rows) {
    if (row.is_object() && row.value("sessionId", "") == session_id) {
      ++removed;
      continue;
    }
    kept.push_back(row);
  }
  if (removed > 0) save_all(kept);
  return removed;
}

json UsageStore::summary(const std::optional<std::string>& session_id) const {
  json all = load_all();
  json records = json::array();
  if (session_id && !session_id->empty()) {
    for (const auto& row : all) {
      if (row.is_object() && row.value("sessionId", "") == *session_id) records.push_back(row);
    }
  } else {
    const size_t start = all.size() > 100 ? all.size() - 100 : 0;
    for (size_t i = start; i < all.size(); ++i) records.push_back(all[i]);
  }

  int tokens_in = 0;
  int tokens_out = 0;
  double cost = 0;
  for (const auto& row : records) {
    if (!row.is_object()) continue;
    tokens_in += row.value("tokensIn", 0);
    tokens_out += row.value("tokensOut", 0);
    cost += row.value("costUsd", 0.0);
  }

  json out{{"totalTokensIn", tokens_in},
           {"totalTokensOut", tokens_out},
           {"totalCostUsd", cost},
           {"records", records}};
  if (session_id) out["sessionId"] = *session_id;
  return out;
}

}  // namespace omega::runtime

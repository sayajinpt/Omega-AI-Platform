#include "omega/runtime/services/self_improve_service.hpp"

#include "omega/runtime/util/uuid.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string store_path(ProfileContext& profile) {
  return (fs::path(profile.profile_home()) / "self-improve.json").string();
}

}  // namespace

SelfImproveService::SelfImproveService(ProfileContext& profile, ConfigStore& config,
                                       SessionStore& sessions, MemoryStore& memory,
                                       InferenceRouter& inference)
    : profile_(profile),
      config_(config),
      sessions_(sessions),
      memory_(memory),
      inference_(inference) {}

json SelfImproveService::load_all() const {
  const fs::path p = store_path(profile_);
  if (!fs::exists(p)) return json::array();
  try {
    std::ifstream in(p);
    json root = json::parse(in);
    return root.is_array() ? root : json::array();
  } catch (...) {
    return json::array();
  }
}

void SelfImproveService::save_all(const json& rows) const {
  const fs::path p = store_path(profile_);
  fs::create_directories(p.parent_path());
  json trimmed = rows;
  if (trimmed.is_array() && trimmed.size() > 200) {
    trimmed = json::array();
    for (size_t i = rows.size() - 200; i < rows.size(); ++i) trimmed.push_back(rows[i]);
  }
  std::ofstream out(p);
  out << trimmed.dump(2);
}

json SelfImproveService::list(int limit) const {
  json rows = load_all();
  if (!rows.is_array()) return json::array();
  std::vector<json> sorted;
  for (const auto& row : rows) {
    if (row.is_object()) sorted.push_back(row);
  }
  std::sort(sorted.begin(), sorted.end(), [](const json& a, const json& b) {
    return a.value("createdAt", 0LL) > b.value("createdAt", 0LL);
  });
  json out = json::array();
  for (size_t i = 0; i < sorted.size() && static_cast<int>(i) < limit; ++i) out.push_back(sorted[i]);
  return out;
}

json SelfImproveService::reflect(const std::string& session_id) {
  const json msgs = sessions_.get_messages(session_id);
  if (!msgs.is_array() || msgs.size() < 4) return json(nullptr);

  const json cfg = config_.load();
  const std::string model = cfg.value("defaultModel", "");
  if (model.empty()) return json(nullptr);

  std::ostringstream transcript;
  const size_t start = msgs.size() > 12 ? msgs.size() - 12 : 0;
  for (size_t i = start; i < msgs.size(); ++i) {
    const json& m = msgs[i];
    if (!m.is_object()) continue;
    std::string content = m.value("content", "");
    if (content.size() > 500) content = content.substr(0, 500);
    transcript << m.value("role", "user") << ": " << content << '\n';
  }

  json messages = json::array(
      {json{{"role", "system"},
            {"content",
             "You improve the assistant over time. Reply with JSON only: "
             "{\"insight\":\"one sentence lesson\",\"action\":\"optional habit to adopt\","
             "\"memory\":\"optional fact to remember\"}"}},
       json{{"role", "user"},
            {"content", "Reflect on this conversation:\n" + transcript.str()}}});

  json payload{{"model", model},
               {"messages", messages},
               {"sampling", json{{"max_tokens", 400}, {"temperature", 0.2}}}};

  std::string text;
  inference_.chat(payload, session_id + "-reflect",
                  [&](const std::string& chunk, int) { text += chunk; }, {}, 120000);

  json parsed = json::object();
  try {
    static const std::regex re(R"(\{[\s\S]*\})");
    std::smatch m;
    if (std::regex_search(text, m, re)) parsed = json::parse(m.str());
  } catch (...) {
    if (!text.empty()) parsed["insight"] = text.substr(0, 300);
  }

  const std::string insight = parsed.value("insight", "");
  if (insight.empty()) return json(nullptr);

  const int64_t now = std::chrono::duration_cast<std::chrono::milliseconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count();

  json entry{{"id", random_uuid()},
             {"sessionId", session_id},
             {"insight", insight},
             {"applied", false},
             {"createdAt", now}};
  if (parsed.contains("action") && parsed["action"].is_string()) {
    entry["action"] = parsed["action"];
  }

  json rows = load_all();
  rows.push_back(entry);
  save_all(rows);

  const std::string memory_text = parsed.value("memory", "");
  if (!memory_text.empty()) {
    memory_.add("preference", memory_text, session_id);
    entry["applied"] = true;
    for (auto& row : rows) {
      if (row.is_object() && row.value("id", "") == entry["id"].get<std::string>()) {
        row["applied"] = true;
        break;
      }
    }
    save_all(rows);
  }

  memory_.add("summary", insight, session_id);
  return entry;
}

json SelfImproveService::janitor_session(const std::string& session_id) {
  const json cfg = config_.load();
  const json rules = cfg.value("memoryJanitor", json::object());
  const int max_msgs = rules.value("maxSessionMessages", 30);
  const int keep = rules.value("keepSessionMessages", 20);

  const json msgs = sessions_.get_messages(session_id);
  if (!msgs.is_array() || static_cast<int>(msgs.size()) < max_msgs) {
    return json{{"removed", 0}, {"note", "Session within size limits"}};
  }

  const int removed = static_cast<int>(msgs.size()) - keep;
  sessions_.truncate_messages(session_id, keep);
  const json mem_note = memory_.run_janitor(500, 0);

  return json{{"removed", removed},
              {"note", "Janitor kept last " + std::to_string(keep) + " messages. " +
                           mem_note.value("note", "")}};
}

}  // namespace omega::runtime

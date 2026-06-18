#include "omega/runtime/storage/soul_store.hpp"

#include <filesystem>
#include <fstream>
#include <regex>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

SoulStore::SoulStore(ProfileContext& profile) : profile_(profile) {}

std::string SoulStore::soul_path() const {
  return (fs::path(profile_.profile_home()) / "SOUL.md").string();
}

json SoulStore::default_soul() {
  return json{{"identity", "You are Omega, a fully local AI operating system."},
              {"values",
               "Be helpful, accurate, and honest. Refuse only when truly harmful. Respect the "
               "user's autonomy."},
              {"style", "Plain language. Short by default; long when the question deserves it."},
              {"goals",
               "Help the user accomplish their tasks efficiently, learn from each interaction, "
               "and keep their data on-device."}};
}

json SoulStore::parse_soul_md(const std::string& md) {
  json defaults = default_soul();
  static const std::regex section_re(R"(^##\s+(.+)$)", std::regex_constants::multiline);
  std::sregex_iterator it(md.begin(), md.end(), section_re);
  std::sregex_iterator end;
  std::vector<std::pair<size_t, std::string>> marks;
  for (; it != end; ++it) {
    marks.emplace_back(static_cast<size_t>(it->position()), (*it)[1].str());
  }
  json out = defaults;
  for (size_t i = 0; i < marks.size(); ++i) {
    const size_t start = marks[i].first;
    const size_t body_start = md.find('\n', start);
    const size_t content_start = body_start == std::string::npos ? start : body_start + 1;
    const size_t content_end =
        i + 1 < marks.size() ? marks[i + 1].first : md.size();
    std::string title = marks[i].second;
    for (char& c : title) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    std::string body = md.substr(content_start, content_end - content_start);
    while (!body.empty() && (body.front() == '\n' || body.front() == ' ')) body.erase(body.begin());
    while (!body.empty() && (body.back() == '\n' || body.back() == ' ')) body.pop_back();
    if (title == "identity" || title == "values" || title == "style" || title == "goals") {
      if (!body.empty()) out[title] = body;
    }
  }
  return out;
}

std::string SoulStore::serialize_soul(const json& soul) {
  return "## Identity\n" + soul.value("identity", "") + "\n\n## Values\n" +
         soul.value("values", "") + "\n\n## Style\n" + soul.value("style", "") +
         "\n\n## Goals\n" + soul.value("goals", "") + "\n";
}

json SoulStore::get() {
  const fs::path path = soul_path();
  if (!fs::exists(path)) return default_soul();
  try {
    std::ifstream in(path);
    const std::string md((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    return parse_soul_md(md);
  } catch (...) {
    return default_soul();
  }
}

json SoulStore::set(const json& input) {
  const fs::path path = soul_path();
  fs::create_directories(path.parent_path());
  json merged = default_soul();
  for (const char* key : {"identity", "values", "style", "goals"}) {
    if (input.contains(key)) merged[key] = input[key];
  }
  std::ofstream out(path);
  out << serialize_soul(merged);
  return merged;
}

json SoulStore::reset() { return set(default_soul()); }

}  // namespace omega::runtime

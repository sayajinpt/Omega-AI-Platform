#include "omega/runtime/storage/skills_store.hpp"

#include "omega/runtime/util/slugify.hpp"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <vector>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::vector<std::string> split_lines(const std::string& text) {
  std::vector<std::string> lines;
  std::istringstream in(text);
  std::string line;
  while (std::getline(in, line)) lines.push_back(line);
  return lines;
}

struct Frontmatter {
  std::string name;
  std::string description;
  std::string category;
  json tags = json::array();
  bool enabled = true;
  bool has_enabled = false;
};

Frontmatter parse_frontmatter(const std::string& body, std::string& rest) {
  Frontmatter meta;
  rest = body;
  if (!body.starts_with("---")) return meta;
  const size_t end = body.find("\n---", 3);
  if (end == std::string::npos) return meta;
  const std::string yaml = body.substr(3, end - 3);
  rest = body.substr(end + 4);
  while (!rest.empty() && rest.front() == '\n') rest.erase(rest.begin());

  static const std::regex line_re(R"(^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$)");
  for (const std::string& line : split_lines(yaml)) {
    std::smatch m;
    if (!std::regex_match(line, m, line_re)) continue;
    const std::string key = m[1].str();
    std::string val = m[2].str();
    while (!val.empty() && (val.front() == ' ' || val.front() == '\t')) val.erase(val.begin());
    if (key == "name") meta.name = val;
    else if (key == "description") meta.description = val;
    else if (key == "category") meta.category = val;
    else if (key == "enabled") {
      meta.has_enabled = true;
      meta.enabled = (val == "true");
    }     else if (key == "tags" && val.front() == '[' && val.back() == ']') {
      json tags = json::array();
      val = val.substr(1, val.size() - 2);
      std::string token;
      for (char c : val) {
        if (c == ',') {
          while (!token.empty() && (token.front() == ' ' || token.front() == '"' ||
                                    token.front() == '\''))
            token.erase(token.begin());
          while (!token.empty() && (token.back() == ' ' || token.back() == '"' ||
                                    token.back() == '\''))
            token.pop_back();
          if (!token.empty()) tags.push_back(token);
          token.clear();
        } else {
          token.push_back(c);
        }
      }
      if (!token.empty()) {
        while (!token.empty() && (token.front() == ' ' || token.front() == '"' ||
                                  token.front() == '\''))
          token.erase(token.begin());
        while (!token.empty() && (token.back() == ' ' || token.back() == '"' ||
                                  token.back() == '\''))
          token.pop_back();
        tags.push_back(token);
      }
      meta.tags = tags;
    }
  }
  return meta;
}

}  // namespace

SkillsStore::SkillsStore(ProfileContext& profile) : profile_(profile) {}

std::string SkillsStore::skills_dir() const {
  return (fs::path(profile_.profile_home()) / "skills").string();
}

std::optional<json> SkillsStore::read_skill(const std::string& id, bool include_body) const {
  const fs::path dir = fs::path(skills_dir()) / id;
  const fs::path file = dir / "SKILL.md";
  if (!fs::exists(file)) return std::nullopt;
  std::ifstream in(file);
  const std::string raw((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  std::string rest;
  const Frontmatter meta = parse_frontmatter(raw, rest);

  static const std::regex heading_re(R"(^#\s+(.+)$)", std::regex_constants::multiline);
  std::smatch hm;
  std::string first_heading;
  if (std::regex_search(rest, hm, heading_re)) first_heading = hm[1].str();

  std::string first_para;
  {
    std::string after = rest;
    const size_t nl = after.find('\n');
    if (nl != std::string::npos && after.substr(0, nl).starts_with("#"))
      after = after.substr(nl + 1);
    const size_t blank = after.find("\n\n");
    first_para = blank == std::string::npos ? after : after.substr(0, blank);
    while (!first_para.empty() && (first_para.front() == '\n' || first_para.front() == ' '))
      first_para.erase(first_para.begin());
  }

  json out{{"id", id},
           {"name", meta.name.empty() ? (first_heading.empty() ? id : first_heading) : meta.name},
           {"description",
            meta.description.empty() ? first_para.substr(0, 240) : meta.description},
           {"enabled", meta.has_enabled ? meta.enabled : true},
           {"path", file.string()},
           {"contentPreview", rest.substr(0, 320)}};
  if (!meta.category.empty()) out["category"] = meta.category;
  if (!meta.tags.empty()) out["tags"] = meta.tags;
  if (include_body) out["body"] = rest;
  return out;
}

json SkillsStore::list() {
  const fs::path root = skills_dir();
  fs::create_directories(root);
  json arr = json::array();
  for (const auto& entry : fs::directory_iterator(root)) {
    if (!entry.is_directory()) continue;
    if (auto s = read_skill(entry.path().filename().string(), false)) arr.push_back(*s);
  }
  std::sort(arr.begin(), arr.end(), [](const json& a, const json& b) {
    return a.value("name", "") < b.value("name", "");
  });
  return arr;
}

json SkillsStore::get(const std::string& id) {
  if (auto s = read_skill(id, true)) return *s;
  throw std::runtime_error("skill not found: " + id);
}

json SkillsStore::save(const json& input) {
  const std::string name = input.value("name", "");
  if (name.empty()) throw std::runtime_error("name required");
  const std::string skill_id =
      input.contains("id") && input["id"].is_string() ? input["id"].get<std::string>() : slugify(name);
  const fs::path dir = fs::path(skills_dir()) / skill_id;
  fs::create_directories(dir);

  std::vector<std::string> fm = {"---",
                                 "name: " + name,
                                 "description: " + input.value("description", "")};
  if (input.contains("category") && input["category"].is_string())
    fm.push_back("category: " + input["category"].get<std::string>());
  if (input.contains("tags") && input["tags"].is_array() && !input["tags"].empty()) {
    std::string tags = "tags: [";
    for (size_t i = 0; i < input["tags"].size(); ++i) {
      if (i) tags += ", ";
      tags += "\"" + input["tags"][i].get<std::string>() + "\"";
    }
    tags += "]";
    fm.push_back(tags);
  }
  const bool enabled = input.value("enabled", true);
  fm.push_back(std::string("enabled: ") + (enabled ? "true" : "false"));
  fm.push_back("---");
  fm.push_back("");
  const std::string body = input.value("body", "");
  const std::string content = [&]() {
    std::ostringstream oss;
    for (size_t i = 0; i < fm.size(); ++i) {
      oss << fm[i];
      if (i + 1 < fm.size()) oss << '\n';
    }
    oss << body;
    if (!body.empty() && body.back() != '\n') oss << '\n';
    return oss.str();
  }();

  std::ofstream out(dir / "SKILL.md");
  out << content;
  return get(skill_id);
}

void SkillsStore::remove(const std::string& id) {
  const fs::path dir = fs::path(skills_dir()) / id;
  if (fs::exists(dir)) fs::remove_all(dir);
}

json SkillsStore::toggle(const std::string& id, bool enabled) {
  json s = get(id);
  s["enabled"] = enabled;
  return save(s);
}

}  // namespace omega::runtime

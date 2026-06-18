#include "omega/runtime/storage/plugin_store.hpp"

#include "omega/runtime/paths.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <httplib.h>
#include <stdexcept>
#include <string>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace {

struct UrlParts {
  std::string host;
  int port = 80;
  std::string path;
  bool https = false;
};

UrlParts parse_http_url(const std::string& url) {
  const auto host_start = url.find("://");
  if (host_start == std::string::npos) throw std::runtime_error("invalid url");
  UrlParts parts;
  parts.https = url.rfind("https://", 0) == 0;
  if (!parts.https && url.rfind("http://", 0) != 0) {
    throw std::runtime_error("only http(s) urls supported");
  }
  parts.port = parts.https ? 443 : 80;
  const auto path_start = url.find('/', host_start + 3);
  if (path_start == std::string::npos) throw std::runtime_error("invalid url path");
  const std::string hostport = url.substr(host_start + 3, path_start - host_start - 3);
  parts.path = url.substr(path_start);
  const size_t colon = hostport.find(':');
  if (colon == std::string::npos) {
    parts.host = hostport;
  } else {
    parts.host = hostport.substr(0, colon);
    parts.port = std::stoi(hostport.substr(colon + 1));
  }
  return parts;
}

std::string download_url_body(const std::string& url) {
  const UrlParts parts = parse_http_url(url);
#ifdef CPPHTTPLIB_OPENSSL_SUPPORT
  (void)parts.https;
#else
  if (parts.https) {
    throw std::runtime_error("https plugin urls require OpenSSL-enabled runtime build; use http://");
  }
#endif
  httplib::Client cli(parts.host, parts.port);
  cli.set_connection_timeout(15, 0);
  cli.set_read_timeout(120, 0);
  const auto res = cli.Get(parts.path);
  if (!res || res->status < 200 || res->status >= 300) {
    throw std::runtime_error("failed to download url");
  }
  return res->body;
}

std::string ps_quote(const std::string& s) {
  std::string out = "'";
  for (const char c : s) {
    if (c == '\'') {
      out += "''";
    } else {
      out += c;
    }
  }
  out += "'";
  return out;
}

std::string shell_quote(const std::string& s) {
  std::string out = "\"";
  for (const char c : s) {
    if (c == '"') out += "\\\"";
    else out += c;
  }
  out += "\"";
  return out;
}

std::string git_bin() {
  if (const char* env = std::getenv("OMEGA_GIT_BIN")) {
    const std::string v = env;
    if (!v.empty()) return v;
  }
  return "git";
}

}  // namespace

namespace omega::runtime {

std::string PluginStore::plugins_root() const { return plugins_dir(); }

std::string PluginStore::enabled_state_path() const {
  return (fs::path(omega_home()) / "plugin-enabled.json").string();
}

json PluginStore::load_enabled() const {
  const fs::path path = enabled_state_path();
  if (!fs::exists(path)) return json::object();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_object() ? root : json::object();
  } catch (...) {
    return json::object();
  }
}

void PluginStore::save_enabled(const json& state) const {
  const fs::path path = enabled_state_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << state.dump(2);
}

json PluginStore::scan_manifest(const std::string& dir) const {
  const fs::path manifest = fs::path(dir) / "omega-plugin.json";
  if (!fs::exists(manifest)) return json();
  try {
    std::ifstream in(manifest);
    return json::parse(in);
  } catch (...) {
    return json();
  }
}

json PluginStore::list() const {
  const json enabled = load_enabled();
  json out = json::array();
  const fs::path root = plugins_root();
  fs::create_directories(root);
  for (const auto& entry : fs::directory_iterator(root)) {
    if (!entry.is_directory()) continue;
    const json manifest = scan_manifest(entry.path().string());
    if (manifest.is_null() || !manifest.is_object()) continue;
    const std::string id = manifest.value("id", entry.path().filename().string());
    json tools = json::array();
    if (manifest.contains("tools") && manifest["tools"].is_array()) {
      for (const auto& t : manifest["tools"]) {
        if (t.is_string()) tools.push_back(t);
        else if (t.is_object()) tools.push_back(t.value("name", ""));
      }
    }
    const bool is_enabled = enabled.contains(id) ? enabled[id].get<bool>() : true;
    out.push_back(json{{"id", id},
                       {"name", manifest.value("name", id)},
                       {"version", manifest.value("version", "0.0.0")},
                       {"tools", tools},
                       {"enabled", is_enabled}});
  }
  std::sort(out.begin(), out.end(), [](const json& a, const json& b) {
    return a.value("name", "") < b.value("name", "");
  });
  return out;
}

json PluginStore::builtin_catalog_template() const {
  return json::array({
      json{{"id", "omega-hello"},
           {"name", "Hello World"},
           {"description", "Adds a single greeting tool. Useful as a plugin template."},
           {"version", "0.1.0"},
           {"author", "Omega"},
           {"tools", json::array({"hello"})},
           {"source", "builtin:hello"}},
      json{{"id", "omega-fs-ext"},
           {"name", "File system extras"},
           {"description", "Adds copy_file, move_file, and search_files tools."},
           {"version", "0.1.0"},
           {"author", "Omega"},
           {"tools", json::array({"copy_file", "move_file", "search_files"})},
           {"source", "builtin:fs-ext"}},
      json{{"id", "omega-screen"},
           {"name", "Screen tools"},
           {"description", "Take screenshots and OCR them."},
           {"version", "0.1.0"},
           {"author", "Omega"},
           {"tools", json::array({"screenshot", "ocr"})},
           {"source", "builtin:screen"},
           {"permissions", json::array({"display", "screen-capture"})}},
      json{{"id", "omega-youtube-dl"},
           {"name", "YouTube audio download"},
           {"description",
            "Download music/audio (MP3) from a YouTube watch link. Requires yt-dlp installed."},
           {"version", "0.1.0"},
           {"author", "Omega"},
           {"tools", json::array({"download_audio"})},
           {"source", "builtin:youtube-dl"}}});
}

json PluginStore::catalog() {
  json entries = builtin_catalog_template();
  const json installed = list();
  auto is_installed = [&](const std::string& id) {
    for (const auto& p : installed) {
      if (p.value("id", "") == id) return true;
    }
    return false;
  };
  for (auto& e : entries) {
    e["installed"] = is_installed(e.value("id", ""));
    if (e["installed"].get<bool>()) {
      for (const auto& p : installed) {
        if (p.value("id", "") == e.value("id", "")) {
          e["version"] = p.value("version", e.value("version", "0.0.0"));
          break;
        }
      }
    } else {
      e["installed"] = false;
    }
  }
  return entries;
}

std::string PluginStore::builtin_script(const std::string& id) const {
  if (id == "omega-hello") {
    return R"(module.exports = {
  hello: async (args) => ({ ok: true, output: 'Hello, ' + (args.name || 'world') + '!' })
}
)";
  }
  if (id == "omega-fs-ext") {
    return R"(const fs = require('fs')
const path = require('path')
const ok = (output) => ({ ok: true, output: String(output) })
module.exports = {
  copy_file: async (a) => { fs.copyFileSync(a.from, a.to); return ok('copied') },
  move_file: async (a) => { fs.renameSync(a.from, a.to); return ok('moved') },
  search_files: async (a) => {
    const root = a.path || '.'
    const pat = (a.pattern || '').toLowerCase()
    const out = []
    function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (!pat || e.name.toLowerCase().includes(pat)) out.push(p)
      }
    }
    walk(root)
    return ok(out.slice(0, 200).join('\n'))
  }
}
)";
  }
  if (id == "omega-screen") {
    return R"(module.exports = {
  screenshot: async () => ({ ok: false, output: 'screenshot requires platform integration' }),
  ocr: async () => ({ ok: false, output: 'ocr requires tesseract' })
}
)";
  }
  if (id == "omega-youtube-dl") {
    return R"(const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const ok = (output) => ({ ok: true, output: String(output) })
const err = (output) => ({ ok: false, output: String(output) })
function defaultOutDir() {
  const home = os.homedir()
  return path.join(home, 'Music', 'Omega Downloads')
}
module.exports = {
  download_audio: async (args) => {
    const url = String(args.url || '').trim()
    if (!url) return err('url required')
    const outDir = String(args.output_dir || args.outputDir || defaultOutDir())
    fs.mkdirSync(outDir, { recursive: true })
    const template = path.join(outDir, '%(title)s.%(ext)s')
    const r = spawnSync('yt-dlp', ['-x', '--audio-format', 'mp3', '-o', template, url], {
      encoding: 'utf8',
      shell: process.platform === 'win32'
    })
    const combined = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
    if (r.status !== 0) {
      return err(
        'yt-dlp failed — install yt-dlp (winget install yt-dlp)\n' + (combined || 'no output')
      )
    }
    return ok('Download complete in ' + outDir + (combined ? '\n' + combined : ''))
  }
}
)";
  }
  return "module.exports = {}\n";
}

void PluginStore::write_installed_plugin(const json& entry) {
  const std::string id = entry.value("id", "");
  if (id.empty()) throw std::runtime_error("plugin id required");
  const fs::path dir = fs::path(plugins_root()) / id;
  fs::create_directories(dir);

  json manifest{{"id", id},
                {"name", entry.value("name", id)},
                {"description", entry.value("description", "")},
                {"version", entry.value("version", "0.0.0")},
                {"author", entry.value("author", "Omega")},
                {"tools", entry.value("tools", json::array())},
                {"entry", "index.js"}};
  if (entry.contains("permissions")) manifest["permissions"] = entry["permissions"];

  {
    std::ofstream out(dir / "omega-plugin.json");
    out << manifest.dump(2);
  }
  {
    std::ofstream out(dir / "index.js");
    out << builtin_script(id);
  }
}

json PluginStore::install_builtin(const std::string& id) {
  json entry;
  for (const auto& e : builtin_catalog_template()) {
    if (e.value("id", "") == id) {
      entry = e;
      break;
    }
  }
  if (entry.is_null() || entry.empty()) throw std::runtime_error("unknown built-in plugin: " + id);
  write_installed_plugin(entry);
  return scan_manifest((fs::path(plugins_root()) / id).string());
}

std::string PluginStore::sanitize_id(std::string s) {
  for (char& c : s) {
    if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-' && c != '_') c = '-';
  }
  while (!s.empty() && s.front() == '-') s.erase(s.begin());
  while (!s.empty() && s.back() == '-') s.pop_back();
  for (size_t i = 1; i < s.size();) {
    if (s[i] == '-' && s[i - 1] == '-') {
      s.erase(i, 1);
    } else {
      ++i;
    }
  }
  if (s.empty()) s = "plugin";
  return s;
}

std::optional<std::string> PluginStore::find_manifest_dir(const std::string& root) const {
  const fs::path root_path = root;
  if (!fs::exists(root_path)) return std::nullopt;
  if (!scan_manifest(root).is_null()) return root;
  for (const auto& entry : fs::directory_iterator(root_path)) {
    if (!entry.is_directory()) continue;
    const std::string dir = entry.path().string();
    if (!scan_manifest(dir).is_null()) return dir;
  }
  return std::nullopt;
}

json PluginStore::install_from_url(const std::string& url_in) {
  const std::string url = [&]() {
    std::string t = url_in;
    while (!t.empty() && (t.front() == ' ' || t.front() == '\t')) t.erase(t.begin());
    while (!t.empty() && (t.back() == ' ' || t.back() == '\t')) t.pop_back();
    return t;
  }();
  if (url.empty()) throw std::runtime_error("url required");

  if (url.size() > 4 && url.substr(url.size() - 3) == ".js") {
    const std::string body = download_url_body(url);
    const UrlParts parts = parse_http_url(url);
    const std::string filename = fs::path(parts.path).filename().string();
    std::string base = filename;
    if (base.size() > 3 && base.substr(base.size() - 3) == ".js") base = base.substr(0, base.size() - 3);
    const std::string id = sanitize_id(base);

    const fs::path dir = fs::path(plugins_root()) / id;
    fs::create_directories(dir);
    {
      std::ofstream out(dir / "index.js");
      out << body;
    }
    json manifest{{"id", id},
                  {"name", id},
                  {"description", "Installed from " + url},
                  {"version", "0.0.0"},
                  {"tools", json::array({id})},
                  {"entry", "index.js"}};
    {
      std::ofstream out(dir / "omega-plugin.json");
      out << manifest.dump(2);
    }
    return manifest;
  }

  if (url.ends_with(".git") || url.rfind("git+", 0) == 0) {
    std::string clean_url = url;
    if (clean_url.rfind("git+", 0) == 0) clean_url = clean_url.substr(4);
    const auto stamp = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    const fs::path root = plugins_root();
    fs::create_directories(root);
    const fs::path tmp_dir = root / ("tmp-" + std::to_string(stamp));
    fs::create_directories(tmp_dir);
    const std::string cmd = git_bin() + " clone --depth 1 " + shell_quote(clean_url) + " " +
                            shell_quote(tmp_dir.string());
    if (std::system(cmd.c_str()) != 0) {
      fs::remove_all(tmp_dir);
      throw std::runtime_error("git clone failed — install Git or set OMEGA_GIT_BIN");
    }
    const std::optional<std::string> manifest_dir = find_manifest_dir(tmp_dir.string());
    if (!manifest_dir) {
      fs::remove_all(tmp_dir);
      throw std::runtime_error("repo has no omega-plugin.json");
    }
    const json manifest = scan_manifest(*manifest_dir);
    if (manifest.is_null() || !manifest.is_object()) {
      fs::remove_all(tmp_dir);
      throw std::runtime_error("repo has no omega-plugin.json");
    }
    const std::string id = manifest.value("id", "");
    if (id.empty()) {
      fs::remove_all(tmp_dir);
      throw std::runtime_error("plugin manifest missing id");
    }
    const fs::path final_dir = root / id;
    if (fs::exists(final_dir)) fs::remove_all(final_dir);
    fs::rename(*manifest_dir, final_dir);
    if (fs::exists(tmp_dir) && fs::is_empty(tmp_dir)) fs::remove_all(tmp_dir);
    return scan_manifest(final_dir.string());
  }
  if (url.ends_with(".zip")) {
    const std::string body = download_url_body(url);
    const auto stamp = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    const fs::path root = plugins_root();
    fs::create_directories(root);
    const fs::path tmp_zip = root / ("dl-" + std::to_string(stamp) + ".zip");
    const fs::path tmp_dir = root / ("tmp-" + std::to_string(stamp));
    {
      std::ofstream out(tmp_zip, std::ios::binary);
      out << body;
    }
    fs::create_directories(tmp_dir);
#ifdef _WIN32
    const std::string cmd = "powershell.exe -NoProfile -Command \"Expand-Archive -Path " +
                            ps_quote(tmp_zip.string()) + " -DestinationPath " +
                            ps_quote(tmp_dir.string()) + " -Force\"";
    if (std::system(cmd.c_str()) != 0) {
      fs::remove_all(tmp_dir);
      fs::remove(tmp_zip);
      throw std::runtime_error("failed to extract plugin zip");
    }
#else
    const std::string cmd =
        "unzip -o " + ps_quote(tmp_zip.string()) + " -d " + ps_quote(tmp_dir.string());
    if (std::system(cmd.c_str()) != 0) {
      fs::remove_all(tmp_dir);
      fs::remove(tmp_zip);
      throw std::runtime_error("failed to extract plugin zip — install unzip");
    }
#endif
    fs::remove(tmp_zip);

    const std::optional<std::string> manifest_dir = find_manifest_dir(tmp_dir.string());
    if (!manifest_dir) {
      fs::remove_all(tmp_dir);
      throw std::runtime_error("zip has no omega-plugin.json");
    }
    const json manifest = scan_manifest(*manifest_dir);
    if (manifest.is_null() || !manifest.is_object()) {
      fs::remove_all(tmp_dir);
      throw std::runtime_error("zip has no omega-plugin.json");
    }
    const std::string id = manifest.value("id", "");
    if (id.empty()) {
      fs::remove_all(tmp_dir);
      throw std::runtime_error("plugin manifest missing id");
    }

    const fs::path final_dir = root / id;
    if (fs::exists(final_dir)) fs::remove_all(final_dir);
    fs::rename(*manifest_dir, final_dir);
    if (fs::exists(tmp_dir) && fs::is_empty(tmp_dir)) fs::remove_all(tmp_dir);
    return scan_manifest(final_dir.string());
  }
  throw std::runtime_error("unsupported url — provide a .js, .zip, or .git URL");
}

void PluginStore::uninstall(const std::string& id) {
  const fs::path dir = fs::path(plugins_root()) / id;
  if (fs::exists(dir)) {
    fs::remove_all(dir);
  }
  json state = load_enabled();
  if (state.contains(id)) {
    state.erase(id);
    save_enabled(state);
  }
}

json PluginStore::plugin_tools() const {
  const json enabled = load_enabled();
  json out = json::array();
  for (const auto& plugin : list()) {
    const std::string plugin_id = plugin.value("id", "");
    if (plugin_id.empty()) continue;
    const bool plugin_enabled =
        enabled.contains(plugin_id) ? enabled[plugin_id].get<bool>() : true;
    if (!plugin_enabled) continue;

    const fs::path dir = fs::path(plugins_root()) / plugin_id;
    const json manifest = scan_manifest(dir.string());
    if (manifest.is_null()) continue;

    json tool_defs = json::array();
    if (manifest.contains("tools") && manifest["tools"].is_array()) {
      tool_defs = manifest["tools"];
    }

    for (const auto& t : tool_defs) {
      std::string tool_name;
      std::string description;
      if (t.is_string()) {
        tool_name = t.get<std::string>();
        description = "Plugin tool from " + plugin_id;
      } else if (t.is_object()) {
        tool_name = t.value("name", "");
        description = t.value("description", "Plugin tool from " + plugin_id);
      }
      if (tool_name.empty()) continue;
      out.push_back(json{{"name", plugin_id + ":" + tool_name},
                         {"description", description},
                         {"pluginId", plugin_id},
                         {"toolName", tool_name},
                         {"enabled", true}});
    }
  }
  return out;
}

bool PluginStore::is_plugin_tool(const std::string& namespaced_name) const {
  const size_t colon = namespaced_name.find(':');
  if (colon == std::string::npos || colon == 0) return false;
  if (namespaced_name.rfind("mcp:", 0) == 0) return false;
  const std::string plugin_id = namespaced_name.substr(0, colon);
  const std::string tool_name = namespaced_name.substr(colon + 1);
  for (const auto& t : plugin_tools()) {
    if (t.value("pluginId", "") == plugin_id && t.value("toolName", "") == tool_name) return true;
  }
  return false;
}

json PluginStore::toggle(const std::string& id, bool enabled) {
  json state = load_enabled();
  state[id] = enabled;
  save_enabled(state);
  return list();
}

json PluginStore::reload() { return list(); }

json PluginStore::status() const {
  return json{{"mounted", list().size()}, {"errors", json::object()}};
}

json PluginStore::write_agent_plugin(const json& input) {
  const std::string id = sanitize_id(input.value("pluginId", ""));
  if (id.empty()) throw std::runtime_error("pluginId required");
  const std::string name = input.value("name", id);
  const std::string source = input.value("source", "");
  if (source.empty()) throw std::runtime_error("source (index.js) required");

  json tools = json::array();
  if (input.contains("tools") && input["tools"].is_array()) {
    tools = input["tools"];
  } else if (input.contains("toolsJson") && input["toolsJson"].is_string()) {
    tools = json::parse(input["toolsJson"].get<std::string>());
  }
  if (!tools.is_array() || tools.empty()) {
    throw std::runtime_error("toolsJson must be a non-empty JSON array");
  }

  json manifest{{"id", id},
                {"name", name},
                {"description", input.value("description", "")},
                {"version", input.value("version", "0.1.0")},
                {"author", input.value("author", "Omega agent")},
                {"tools", tools},
                {"entry", "index.js"}};
  if (input.contains("permissions")) manifest["permissions"] = input["permissions"];

  const fs::path dir = fs::path(plugins_root()) / id;
  fs::create_directories(dir);
  {
    std::ofstream out(dir / "omega-plugin.json");
    out << manifest.dump(2);
  }
  {
    std::ofstream out(dir / "index.js");
    out << source;
  }
  return scan_manifest(dir.string());
}

}  // namespace omega::runtime

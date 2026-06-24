#include "omega/runtime/models/hf_client.hpp"

#include "omega/runtime/net/https_client.hpp"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <regex>
#include <sstream>
#include <stdexcept>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::string url_encode(const std::string& value) {
  std::ostringstream escaped;
  for (unsigned char c : value) {
    if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') {
      escaped << c;
    } else {
      escaped << '%' << std::uppercase << std::hex << ((c >> 4) & 0xF) << (c & 0xF) << std::nouppercase
              << std::dec;
    }
  }
  return escaped.str();
}

std::string detect_format(const std::string& path) {
  const std::string p = path;
  std::string lower = p;
  for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (lower.size() >= 5 && lower.substr(lower.size() - 5) == ".gguf") return "gguf";
  if (lower.find(".safetensors") != std::string::npos) {
    if (lower.find("awq") != std::string::npos) return "awq";
    if (lower.find("gptq") != std::string::npos) return "gptq";
    return "safetensors";
  }
  if (lower.find(".onnx") != std::string::npos) return "onnx";
  if (lower.ends_with("genai_config.json") || lower.ends_with("tokenizer.json") ||
      lower.ends_with("tokenizer_config.json") || lower.ends_with("tokenizer.model") ||
      lower.ends_with("chat_template.jinja") || lower.ends_with("generation_config.json") ||
      lower.ends_with("special_tokens_map.json") || lower.ends_with("added_tokens.json") ||
      lower.ends_with("vocab.json") || lower.ends_with("merges.txt") ||
      lower.ends_with("model_index.json") || lower.ends_with("/config.json") ||
      lower == "config.json")
    return "config";
  return {};
}

https::RequestOptions hf_request_opts(const std::map<std::string, std::string>& headers) {
  https::RequestOptions opts;
  opts.headers = headers;
  opts.connection_timeout_sec = 30;
  opts.read_timeout_sec = 120;
  opts.follow_redirects = true;
  return opts;
}

/** HF tree/siblings sizes are bytes; must use int64 (GGUF files are often >2 GiB). */
int64_t hf_file_size_bytes(const json& node) {
  int64_t bytes = 0;
  if (node.contains("lfs") && node["lfs"].is_object()) {
    const json& lfs = node["lfs"];
    if (lfs.contains("size") && lfs["size"].is_number()) {
      bytes = std::max(bytes, lfs["size"].get<int64_t>());
    }
  }
  if (node.contains("size") && node["size"].is_number()) {
    bytes = std::max(bytes, node["size"].get<int64_t>());
  }
  return bytes > 0 ? bytes : 0;
}

}  // namespace

HfClient::HfClient(ConfigStore& config) : config_(config) {}

std::string HfClient::hf_token() const {
  const json cfg = config_.load();
  if (cfg.contains("hfToken") && cfg["hfToken"].is_string()) {
    const std::string t = cfg["hfToken"].get<std::string>();
    if (!t.empty()) return t;
  }
  if (const char* env = std::getenv("HF_TOKEN")) {
    if (*env) return env;
  }
  if (const char* env = std::getenv("HUGGING_FACE_HUB_TOKEN")) {
    if (*env) return env;
  }
  return {};
}

std::map<std::string, std::string> HfClient::auth_headers() const {
  std::map<std::string, std::string> h{{"Accept", "application/json"}};
  const std::string token = hf_token();
  if (!token.empty()) h.emplace("Authorization", "Bearer " + token);
  return h;
}

std::string HfClient::encode_repo(const std::string& repo) {
  std::ostringstream out;
  std::istringstream in(repo);
  std::string part;
  bool first = true;
  while (std::getline(in, part, '/')) {
    if (!first) out << '/';
    first = false;
    out << url_encode(part);
  }
  return out.str();
}

json HfClient::search(const json& opts) const {
  const json o = opts.is_object() ? opts : json::object();
  const std::string query = o.value("query", "");
  const std::string author = o.value("author", "");
  const std::string tag = o.value("tag", "");
  const std::string pipeline_tag =
      o.contains("pipelineTag") && o["pipelineTag"].is_string()
          ? o["pipelineTag"].get<std::string>()
          : o.value("pipeline_tag", o.value("pipeline", ""));
  const std::string sort = o.value("sort", "trending");
  const int limit = o.value("limit", 60);
  const std::string fmt = o.value("format", "");
  const bool fmt_any = fmt == "any";
  const bool fmt_gguf = fmt == "gguf" || (fmt.empty() && o.value("ggufOnly", false));
  const bool default_gguf_browse =
      pipeline_tag.empty() && tag.empty() && query.empty() && author.empty() && fmt.empty();
  const bool use_gguf =
      !fmt_any && (fmt_gguf || (fmt.empty() && default_gguf_browse && !o.contains("ggufOnly")));

  std::ostringstream path;
  path << "/api/models?";
  if (!query.empty()) path << "search=" << url_encode(query) << '&';
  if (!author.empty()) path << "author=" << url_encode(author) << '&';
  if (!pipeline_tag.empty()) path << "pipeline_tag=" << url_encode(pipeline_tag) << '&';
  if (!tag.empty()) path << "other=" << url_encode(tag) << '&';
  if (use_gguf) {
    path << "filter=gguf&";
  } else if (fmt == "onnx") {
    path << "library=onnx&";
  } else if (fmt == "safetensors" || fmt == "awq" || fmt == "gptq") {
    path << "library=safetensors&";
  }
  path << "sort=" << (sort == "trending" ? "trendingScore" : sort) << "&direction=-1&limit="
       << std::min(std::max(limit, 1), 100) << "&full=true";

  const auto res =
      https::get("https://huggingface.co" + path.str(), hf_request_opts(auth_headers()));
  if (res.status < 200 || res.status >= 300) {
    throw std::runtime_error("HF search failed: HTTP " + std::to_string(res.status));
  }
  const json items = json::parse(res.body);
  if (!items.is_array()) return json::array();
  json out = json::array();
  for (const auto& m : items) {
    out.push_back(json{{"id", m.value("id", "")},
                       {"modelId", m.value("modelId", m.value("id", ""))},
                       {"author", m.value("author", "")},
                       {"downloads", m.value("downloads", 0)},
                       {"likes", m.value("likes", 0)},
                       {"lastModified", m.value("lastModified", "")},
                       {"tags", m.contains("tags") ? m["tags"] : json::array()},
                       {"pipeline", m.value("pipeline_tag", "")}});
  }
  return out;
}

json HfClient::model_card(const std::string& repo) const {
  const std::string encoded = encode_repo(repo);
  const auto opts = hf_request_opts(auth_headers());
  const auto res = https::get("https://huggingface.co/api/models/" + encoded, opts);
  if (res.status < 200 || res.status >= 300) {
    throw std::runtime_error("HF model card failed");
  }
  const json m = json::parse(res.body);
  json tree = json::array();
  const auto fetch_tree = [&](const std::string& revision) {
    return https::get("https://huggingface.co/api/models/" + encoded + "/tree/" + revision +
                          "?recursive=1",
                      opts);
  };
  auto tree_res = fetch_tree("main");
  if (tree_res.status < 200 || tree_res.status >= 300) tree_res = fetch_tree("master");
  if (tree_res.status >= 200 && tree_res.status < 300) {
    tree = json::parse(tree_res.body);
  } else if (m.contains("siblings") && m["siblings"].is_array()) {
    for (const auto& s : m["siblings"]) {
      tree.push_back(json{{"path", s.value("rfilename", "")},
                          {"size", hf_file_size_bytes(s)},
                          {"type", "file"}});
    }
  }
  static const std::regex quant_re(R"((IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|F16|F32|BF16))", std::regex::icase);
  json files = json::array();
  if (tree.is_array()) {
    for (const auto& node : tree) {
      if (node.value("type", "") != "file") continue;
      const std::string path = node.value("path", "");
      const std::string fmt = detect_format(path);
      if (fmt.empty()) continue;
      std::smatch match;
      const int64_t size_bytes = hf_file_size_bytes(node);
      json f{{"path", path},
             {"size", size_bytes},
             {"format", fmt},
             {"nativeSupported", fmt == "gguf" || fmt == "onnx"}};
      if (std::regex_search(path, match, quant_re)) f["quant"] = match[1].str();
      files.push_back(f);
    }
  }
  return json{{"id", m.value("id", repo)},
              {"description", m.value("description", "")},
              {"files", files},
              {"tags", m.contains("tags") ? m["tags"] : json::array()},
              {"pipeline", m.value("pipeline_tag", "")},
              {"downloads", m.value("downloads", 0)},
              {"likes", m.value("likes", 0)}};
}

json HfClient::common_tags() const {
  return json::array({"gguf", "safetensors", "text-generation", "conversational", "llama", "qwen",
                      "mistral", "mixtral", "vision", "embedding", "lora", "4-bit", "8-bit"});
}

json HfClient::check_repo_access(const std::string& repo) const {
  const std::string trimmed = repo;
  const std::string page_url = "https://huggingface.co/" + trimmed;
  const bool has_token = !hf_token().empty();
  const auto res =
      https::get("https://huggingface.co/api/models/" + encode_repo(trimmed), hf_request_opts(auth_headers()));
  const int status = res.status;
  const bool gated = status == 401 || status == 403;
  std::string hint;
  if (gated) {
    if (status == 403) hint = "accept_license";
    else if (status == 401 && has_token) hint = "refresh_token";
    else hint = "add_token";
  }
  return json{{"ok", status >= 200 && status < 300},
              {"status", status},
              {"hasToken", has_token},
              {"pageUrl", page_url},
              {"gated", gated},
              {"hint", hint.empty() ? json() : json(hint)}};
}

json HfClient::repo_file_paths(const std::string& repo) const {
  const json card = model_card(repo);
  json paths = json::array();
  if (card.contains("files") && card["files"].is_array()) {
    for (const auto& f : card["files"]) paths.push_back(f.value("path", ""));
  }
  return paths;
}

}  // namespace omega::runtime

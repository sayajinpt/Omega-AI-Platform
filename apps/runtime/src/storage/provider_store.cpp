#include "omega/runtime/storage/provider_store.hpp"

#include "omega/runtime/inference/remote_chat.hpp"
#include "omega/runtime/util/uuid.hpp"

#include <filesystem>
#include <fstream>
#include <stdexcept>

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

ProviderStore::ProviderStore(ProfileContext& profile) : profile_(profile) {}

std::string ProviderStore::file_path() const {
  return (fs::path(profile_.profile_home()) / "providers.json").string();
}

json ProviderStore::load_all() const {
  const fs::path path = file_path();
  if (!fs::exists(path)) return json::array();
  try {
    std::ifstream in(path);
    json root = json::parse(in);
    return root.is_array() ? root : json::array();
  } catch (...) {
    return json::array();
  }
}

void ProviderStore::persist(const json& rows) const {
  const fs::path path = file_path();
  fs::create_directories(path.parent_path());
  std::ofstream out(path);
  out << rows.dump(2);
}

json ProviderStore::list() { return load_all(); }

json ProviderStore::save(const json& input) {
  if (!input.is_object()) throw std::runtime_error("provider must be an object");
  json rows = load_all();
  const std::string id =
      input.contains("id") && input["id"].is_string() ? input["id"].get<std::string>()
                                                      : random_uuid();
  json row = input;
  row["id"] = id;
  bool found = false;
  for (auto& r : rows) {
    if (r.value("id", "") == id) {
      r = row;
      found = true;
      break;
    }
  }
  if (!found) rows.push_back(row);
  persist(rows);
  return row;
}

void ProviderStore::remove(const std::string& id) {
  json rows = load_all();
  json next = json::array();
  for (const auto& r : rows) {
    if (r.value("id", "") != id) next.push_back(r);
  }
  persist(next);
}

std::optional<std::pair<json, std::string>> ProviderStore::resolve_model(
    const std::string& qualified_model_id) const {
  const size_t slash = qualified_model_id.find('/');
  if (slash == std::string::npos || slash == 0) return std::nullopt;
  const std::string pid = qualified_model_id.substr(0, slash);
  const std::string model = qualified_model_id.substr(slash + 1);
  for (const auto& p : load_all()) {
    if (p.value("id", "") == pid && p.value("enabled", true)) {
      return std::make_pair(p, model);
    }
  }
  return std::nullopt;
}

json ProviderStore::fetch_models(const std::string& id, bool should_persist) {
  json rows = load_all();
  json* provider = nullptr;
  for (auto& r : rows) {
    if (r.value("id", "") == id) {
      provider = &r;
      break;
    }
  }
  if (!provider) return json{{"models", json::array()}, {"error", "Provider not found"}};

  const std::string kind = provider->value("kind", "openai");
  if (kind != "ollama" && kind != "lmstudio" && provider->value("apiKey", "").empty()) {
    return json{{"models", provider->value("models", json::array())},
                {"error", "Add an API key first"}};
  }

  try {
    const json models = remote_list_models(*provider);
    if (should_persist && models.is_array() && !models.empty()) {
      (*provider)["models"] = models;
      if (!provider->contains("defaultModel")) (*provider)["defaultModel"] = models[0];
      persist(rows);
    }
    return json{{"models", models.is_array() ? models : json::array()}};
  } catch (const std::exception& e) {
    return json{{"models", json::array()}, {"error", e.what()}};
  }
}

json ProviderStore::presets() const {
  return json::array({
      json{{"id", "openai"},
           {"name", "OpenAI"},
           {"kind", "openai"},
           {"baseUrl", "https://api.openai.com"},
           {"enabled", false},
           {"defaultModel", "gpt-4o-mini"}},
      json{{"id", "anthropic"},
           {"name", "Anthropic"},
           {"kind", "anthropic"},
           {"baseUrl", "https://api.anthropic.com"},
           {"enabled", false},
           {"defaultModel", "claude-3-5-sonnet-latest"}},
      json{{"id", "openrouter"},
           {"name", "OpenRouter"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://openrouter.ai/api"},
           {"enabled", false}},
      json{{"id", "groq"},
           {"name", "Groq"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.groq.com/openai"},
           {"enabled", false}},
      json{{"id", "together"},
           {"name", "Together"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.together.xyz"},
           {"enabled", false}},
      json{{"id", "deepseek"},
           {"name", "DeepSeek"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.deepseek.com"},
           {"enabled", false}},
      json{{"id", "mistral"},
           {"name", "Mistral"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.mistral.ai"},
           {"enabled", false}},
      json{{"id", "perplexity"},
           {"name", "Perplexity"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.perplexity.ai"},
           {"enabled", false}},
      json{{"id", "fireworks"},
           {"name", "Fireworks"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.fireworks.ai/inference"},
           {"enabled", false}},
      json{{"id", "cerebras"},
           {"name", "Cerebras"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.cerebras.ai"},
           {"enabled", false}},
      json{{"id", "xai"},
           {"name", "xAI"},
           {"kind", "custom-openai"},
           {"baseUrl", "https://api.x.ai"},
           {"enabled", false}},
      json{{"id", "ollama"},
           {"name", "Ollama (local)"},
           {"kind", "ollama"},
           {"baseUrl", "http://127.0.0.1:11434"},
           {"enabled", false}},
      json{{"id", "lmstudio"},
           {"name", "LM Studio (local)"},
           {"kind", "lmstudio"},
           {"baseUrl", "http://127.0.0.1:1234"},
           {"enabled", false}},
      json{{"id", "llamacpp"},
           {"name", "llama.cpp server"},
           {"kind", "custom-openai"},
           {"baseUrl", "http://127.0.0.1:8080"},
           {"enabled", false}},
      json{{"id", "vllm"},
           {"name", "vLLM"},
           {"kind", "custom-openai"},
           {"baseUrl", "http://127.0.0.1:8000"},
           {"enabled", false}}});
}

json ProviderStore::discover_all() {
  json out = json::array();
  for (const auto& p : load_all()) {
    if (!p.value("enabled", true)) continue;
    const std::string pid = p.value("id", "");
    const std::string pname = p.value("name", pid);
    json models = p.contains("models") && p["models"].is_array() ? p["models"] : json::array();
    if (models.empty() && !pid.empty()) {
      const json fetched = fetch_models(pid, false);
      if (fetched.contains("models") && fetched["models"].is_array()) {
        models = fetched["models"];
      }
    }
    for (const auto& m : models) {
      if (!m.is_string()) continue;
      const std::string mid = m.get<std::string>();
      out.push_back(json{{"providerId", pid},
                         {"modelId", pid + "/" + mid},
                         {"displayName", pname + ": " + mid}});
    }
  }
  return out;
}

}  // namespace omega::runtime

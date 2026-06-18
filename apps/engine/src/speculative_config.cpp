#include "omega/engine/speculative_config.hpp"

#include <algorithm>
#include <cstdio>

namespace omega::engine {

SpeculativeOptions default_speculative(const SpeculativeOptions& in) {
  SpeculativeOptions out = in;
  if (out.enabled && out.types.empty()) {
    out.types.push_back("draft-mtp");
  }
  if (out.n_max <= 0) out.n_max = 2;
  if (out.n_min < 0) out.n_min = 0;
  return out;
}

bool speculative_uses_infer_server(const SpeculativeOptions& spec) {
  const auto cfg = default_speculative(spec);
  if (!cfg.enabled) return false;
  for (const auto& t : cfg.types) {
    if (t == "draft-mtp" || t == "draft-eagle3" || t == "ngram-simple") return true;
  }
  return false;
}

std::vector<std::string> speculative_cli_args(const SpeculativeOptions& spec,
                                              const std::string& main_model_path) {
  const auto cfg = default_speculative(spec);
  std::vector<std::string> args;
  if (!cfg.enabled) return args;
  if (!cfg.types.empty()) {
    std::string joined;
    for (size_t i = 0; i < cfg.types.size(); ++i) {
      if (i) joined += ',';
      joined += cfg.types[i];
    }
    args.push_back("--spec-type");
    args.push_back(joined);
  }
  std::string draft = cfg.draft_model_path.empty() ? main_model_path : cfg.draft_model_path;
  if (!draft.empty()) {
    args.push_back("--spec-draft-model");
    args.push_back(draft);
  }
  if (cfg.n_max > 0) {
    args.push_back("--spec-draft-n-max");
    args.push_back(std::to_string(cfg.n_max));
  }
  if (cfg.n_min > 0) {
    args.push_back("--spec-draft-n-min");
    args.push_back(std::to_string(cfg.n_min));
  }
  if (cfg.p_min > 0.f) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%g", cfg.p_min);
    args.push_back("--spec-draft-p-min");
    args.push_back(buf);
  }
  return args;
}

}  // namespace omega::engine

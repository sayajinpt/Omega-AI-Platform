#pragma once

#include <string>
#include <vector>

namespace omega::engine {

/** Maps to llama.cpp --spec-type / --spec-draft-* (b9247+). */
struct SpeculativeOptions {
  bool enabled = false;
  std::vector<std::string> types;
  std::string draft_model_path;
  int n_max = 2;
  int n_min = 0;
  float p_min = 0.f;
};

struct LoadOptions;

SpeculativeOptions default_speculative(const SpeculativeOptions& in);

/** True when draft-mtp (or other server-only spec types) should use omega-infer. */
bool speculative_uses_infer_server(const SpeculativeOptions& spec);

/** Append --spec-* CLI flags after base infer args. */
std::vector<std::string> speculative_cli_args(const SpeculativeOptions& spec,
                                              const std::string& main_model_path);

}  // namespace omega::engine

#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

struct SafeGgufMetadata {
  std::string architecture;
  std::string quantization;
  std::optional<double> parameter_count;
  std::optional<int> total_layers;
  std::optional<int> context_length_max;
  std::optional<int> embedding_length;
  bool skipped_large_tokenizer{false};
};

/** Read scalar GGUF KV fields without loading tokenizer arrays. */
std::optional<SafeGgufMetadata> read_safe_gguf_metadata(const std::string& path);

}  // namespace omega::runtime

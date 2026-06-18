#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/storage/database.hpp"

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace omega::runtime {

class RagStore {
 public:
  RagStore(Database& db, EngineClient& engine, ConfigStore& config);

  nlohmann::json list_sources();
  void clear_index(const std::string& source = "");
  nlohmann::json index_file(const std::string& abs_path, const std::string& model_id = "");
  nlohmann::json index_directory(const std::string& abs_dir, const std::string& model_id = "");
  nlohmann::json search(const std::string& query, const std::string& model_id = "", int limit = 6);

 private:
  std::string default_model() const;
  std::vector<float> embed_text(const std::string& model, const std::string& text);
  static float cosine(const std::vector<float>& a, const std::vector<float>& b);
  static std::vector<float> blob_to_floats(const void* data, int bytes, int dim);

  Database& db_;
  EngineClient& engine_;
  ConfigStore& config_;
};

}  // namespace omega::runtime

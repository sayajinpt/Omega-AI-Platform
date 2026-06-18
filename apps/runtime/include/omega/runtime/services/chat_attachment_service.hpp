#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/storage/project_store.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ChatAttachmentService {
 public:
  ChatAttachmentService(ConfigStore& config, ProjectStore& projects);

  nlohmann::json limits() const;
  nlohmann::json pick_paths(const nlohmann::json& body);
  nlohmann::json stage(const std::string& session_id, const std::string& source_path);
  nlohmann::json stage_encoded(const std::string& session_id, const std::string& name,
                               const std::string& data_base64, const std::string& mime_hint = {});

 private:
  static bool is_allowed_ext(const std::string& ext);
  static std::string mime_for(const std::string& ext);
  static std::string kind_for(const std::string& mime, const std::string& ext);
  static std::string content_hash_hex(const std::string& data);
  nlohmann::json stage_bytes(const std::string& session_id, const std::string& name,
                             const std::string& data, const std::string& mime_hint = {});

  ConfigStore& config_;
  ProjectStore& projects_;
};

}  // namespace omega::runtime

#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ContentStudioSettings {
 public:
  explicit ContentStudioSettings(ProfileContext& profile);

  nlohmann::json load_credentials() const;
  nlohmann::json save_credentials(const nlohmann::json& creds);
  nlohmann::json credentials_to_api_payload(const nlohmann::json& creds) const;

  nlohmann::json load_generation() const;
  nlohmann::json save_generation(const nlohmann::json& settings);
  /** Copy omegaTools model overrides from app config into generation settings on disk. */
  nlohmann::json sync_generation_from_app_config(const nlohmann::json& app_config);
  nlohmann::json generation_to_api_payload(const nlohmann::json& gen) const;
  nlohmann::json local_generation_catalog() const;

  /** True when generation weights for ``kind`` + ``repo_id`` exist under the models root. */
  static bool model_installed(const std::string& kind, const std::string& repo_id);

  /** True when any diffusers pack exists under ``video/`` (user may leave model role on Automatic). */
  static bool any_video_model_installed();

  /** Installed generation-model packs + Python readiness for system info / media capabilities. */
  static nlohmann::json generation_media_summary();

 private:
  ProfileContext& profile_;
  std::string credentials_path() const;
  std::string generation_path() const;
  static nlohmann::json generation_defaults();
};

}  // namespace omega::runtime

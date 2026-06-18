#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/inference/inference_router.hpp"
#include "omega/runtime/profile_context.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/storage/session_store.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class SelfImproveService {
 public:
  SelfImproveService(ProfileContext& profile, ConfigStore& config, SessionStore& sessions,
                     MemoryStore& memory, InferenceRouter& inference);

  nlohmann::json list(int limit = 50) const;
  nlohmann::json reflect(const std::string& session_id);
  nlohmann::json janitor_session(const std::string& session_id);

 private:
  nlohmann::json load_all() const;
  void save_all(const nlohmann::json& rows) const;

  ProfileContext& profile_;
  ConfigStore& config_;
  SessionStore& sessions_;
  MemoryStore& memory_;
  InferenceRouter& inference_;
};

}  // namespace omega::runtime

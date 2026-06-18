#pragma once

#include <mutex>
#include <nlohmann/json.hpp>

namespace omega::runtime {

class PipelineActivityService {
 public:
  nlohmann::json snapshot() const;
  void set(const nlohmann::json& patch);
  void clear(const std::string& subsystem = "");

 private:
  mutable std::mutex mu_;
  nlohmann::json state_ = nlohmann::json{{"subsystem", "idle"},
                                         {"label", "Idle"},
                                         {"stage", "Waiting"},
                                         {"updatedAt", 0}};
};

}  // namespace omega::runtime

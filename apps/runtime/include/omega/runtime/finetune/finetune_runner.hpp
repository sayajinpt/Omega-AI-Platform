#pragma once

#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/storage/finetune_store.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class FinetuneRunner {
 public:
  explicit FinetuneRunner(FinetuneStore& store);

  nlohmann::json start(const std::string& job_id, EventBus& events);
  void abort(const std::string& job_id);

 private:
  FinetuneStore& store_;
  std::string script_path() const;
};

}  // namespace omega::runtime

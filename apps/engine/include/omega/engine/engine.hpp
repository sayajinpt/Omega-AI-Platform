#pragma once

#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "omega/engine/command.hpp"
#include "omega/engine/dispatcher.hpp"
#include "omega/engine/event_bus.hpp"
#include "omega/engine/inference_service.hpp"
#include "omega/engine/inference_worker.hpp"
#include "omega/engine/model_registry.hpp"
#include "omega/engine/runtime/dispatch_metrics.hpp"
#include "omega/engine/runtime/thread_pool.hpp"

namespace omega::engine {

/** Production inference host — registry, load, generate, embed over stdio JSON. */
class Engine {
 public:
  explicit Engine(std::string models_dir);
  ~Engine();

  Dispatcher& dispatcher() { return dispatcher_; }
  EventBus& events() { return events_; }
  ModelRegistry& registry() { return registry_; }
  InferenceService& inference() { return inference_; }
  InferenceWorker& worker() { return *worker_; }
  ThreadPool& service_pool() { return service_pool_; }
  const DispatchMetrics& metrics() const { return dispatch_metrics_; }

  /** Dispatch with latency accounting (Phase 6). */
  CommandResponse dispatch(const Command& cmd);

  void set_event_sink(std::function<void(const std::string&)> sink);

  static bool is_async_command(const std::string& type);

 private:
  EventBus events_;
  Dispatcher dispatcher_;
  ModelRegistry registry_;
  InferenceService inference_;
  std::unique_ptr<InferenceWorker> worker_;
  ThreadPool service_pool_;
  DispatchMetrics dispatch_metrics_;
  std::mutex io_mutex_;
  std::function<void(const std::string&)> event_sink_;

  void write_line(const std::string& line);
  void register_commands();
};

}  // namespace omega::engine

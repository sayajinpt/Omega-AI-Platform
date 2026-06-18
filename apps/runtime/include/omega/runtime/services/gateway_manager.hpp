#pragma once

#include "omega/runtime/chat/chat_service.hpp"
#include "omega/runtime/config_store.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/storage/gateway_store.hpp"

#include <atomic>
#include <functional>
#include <memory>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <unordered_map>

namespace omega::runtime {

class GatewayManager {
 public:
  GatewayManager(GatewayStore& store, ChatService& chat, ConfigStore& config, EventBus& events);
  ~GatewayManager();

  nlohmann::json platforms() const;
  nlohmann::json list_configs() const;
  nlohmann::json save_config(const nlohmann::json& cfg);
  void delete_config(const std::string& id);
  nlohmann::json list_statuses() const;
  nlohmann::json start_platform(const std::string& id);
  void stop_platform(const std::string& id);
  nlohmann::json handle_inbound(const std::string& id, const nlohmann::json& body);
  void start_all_enabled();
  void stop_all();

 private:
  struct WorkerState {
    nlohmann::json cfg;
    nlohmann::json status;
    std::atomic<bool> stopped{false};
    std::thread poll_thread;
  };

  using InboundHandler = std::function<nlohmann::json(const nlohmann::json&)>;

  std::string reply_with_agent(const nlohmann::json& cfg, const std::string& prompt);
  bool matches_trigger(const nlohmann::json& cfg, const std::string& text,
                       const std::string& from) const;
  void publish_status();
  void patch_status(const std::string& id, const nlohmann::json& patch);
  void register_inbound(const std::string& id, InboundHandler handler);
  void unregister_inbound(const std::string& id);
  void start_webhook_worker(const nlohmann::json& cfg);
  void start_telegram_worker(const nlohmann::json& cfg);
  void start_matrix_worker(const nlohmann::json& cfg);
  void start_bluebubbles_worker(const nlohmann::json& cfg);
  void start_inbound_webhook_worker(
      const std::string& id,
      std::function<std::pair<std::string, std::string>(const nlohmann::json&)> parse,
      std::function<nlohmann::json(const std::string&)> reply_payload);

  GatewayStore& store_;
  ChatService& chat_;
  ConfigStore& config_;
  EventBus& events_;
  mutable std::mutex mu_;
  std::unordered_map<std::string, std::unique_ptr<WorkerState>> workers_;
  std::unordered_map<std::string, InboundHandler> inbound_handlers_;
};

}  // namespace omega::runtime

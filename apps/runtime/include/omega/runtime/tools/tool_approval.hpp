#pragma once

#include <nlohmann/json.hpp>
#include <condition_variable>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <string>

namespace omega::runtime {

/** Tool + capability approval gates (mirrors tools/approvals.ts). */
class ToolApprovalGate {
 public:
  using EventSink = std::function<void(const std::string& channel, const nlohmann::json& payload)>;

  struct PendingApproval {
    std::string id;
    std::string tool;
    nlohmann::json args;
    std::string kind;
    std::optional<std::string> rationale;
    int64_t created_at_ms = 0;
  };

  bool require_tool_approval(const std::string& tool, const nlohmann::json& args,
                             const nlohmann::json& config);

  bool resolve_tool(const std::string& id, bool approved);

  nlohmann::json list_pending_tools() const;

  bool require_capability(const std::string& capability, const std::string& tool,
                          const nlohmann::json& args, const nlohmann::json& config,
                          const std::function<nlohmann::json(const nlohmann::json&)>& save_config);

  bool resolve_capability(const std::string& id, bool approved, bool remember,
                          const std::function<nlohmann::json(const nlohmann::json&)>& save_config);

  nlohmann::json list_pending_capabilities() const;

  void set_event_sink(EventSink sink) { event_sink_ = std::move(sink); }

  /** Set when require_tool_approval / require_capability returns false. */
  const std::string& last_tool_approval_error() const { return last_tool_approval_error_; }
  const std::string& last_capability_error() const { return last_capability_error_; }

 private:
  bool wait_for_tool(const std::string& id, int timeout_ms);
  bool wait_for_capability(const std::string& id, int timeout_ms);

  mutable std::mutex mu_;
  std::map<std::string, bool> tool_results_;
  std::map<std::string, bool> capability_results_;
  std::map<std::string, PendingApproval> pending_tools_;
  std::map<std::string, nlohmann::json> pending_capabilities_;
  std::condition_variable cv_;
  EventSink event_sink_;
  std::string last_tool_approval_error_;
  std::string last_capability_error_;
};

std::optional<std::string> capability_for_tool(const std::string& tool);
bool is_capability_enabled(const std::string& capability, const nlohmann::json& config);
bool is_dangerous_tool(const std::string& tool, const nlohmann::json& args);

}  // namespace omega::runtime

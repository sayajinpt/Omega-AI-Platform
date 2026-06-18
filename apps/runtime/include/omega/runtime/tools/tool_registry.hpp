#pragma once

#include "omega/runtime/config_store.hpp"
#include "omega/runtime/event_bus.hpp"
#include "omega/runtime/profile_context.hpp"
#include "omega/runtime/storage/memory_store.hpp"
#include "omega/runtime/storage/plugin_store.hpp"
#include "omega/runtime/storage/rag_store.hpp"
#include "omega/runtime/storage/skills_store.hpp"
#include "omega/runtime/tools/sandbox.hpp"
#include "omega/runtime/tools/tool_approval.hpp"

#include <nlohmann/json.hpp>
#include <map>
#include <string>
#include <vector>

namespace omega::runtime {

class ContentJobDeliveryService;
class ContentStudioOrchestrator;
class ContentStudioSupervisor;
class DebugStore;
class AgentDesktopTools;
class AgentPlatformTools;
class McpClientManager;
class ProjectStore;
class SessionStore;

class ToolRegistry {
 public:
  ToolRegistry(ConfigStore& config, ProfileContext& profile, MemoryStore& memory, RagStore& rag,
               SkillsStore& skills, McpClientManager& mcp, PluginStore& plugins);

  nlohmann::json list();
  void toggle(const std::string& name, bool enabled);
  nlohmann::json run(const std::string& name, const nlohmann::json& args);

  void attach_content_services(ContentStudioSupervisor* content_studio,
                               ContentJobDeliveryService* delivery, SessionStore* sessions,
                               EventBus* events);
  void attach_content_orchestrator(ContentStudioOrchestrator* orchestrator);
  /** Resume Content Studio after briefing choices (tone, style, language, …). */
  std::optional<nlohmann::json> try_resume_content_briefing_choice(const std::string& session_id,
                                                                   const std::string& user_message);
  /** Resume Content Studio render after GPU mode choice (keep_agent / max_performance). */
  std::optional<nlohmann::json> try_resume_content_gpu_choice(const std::string& session_id,
                                                              const std::string& user_message);
  /** Resume chat TTS after voice/text choice cards. */
  std::optional<nlohmann::json> try_resume_tts_choice(const std::string& session_id,
                                                        const std::string& user_message);
  void attach_agent_desktop_tools(AgentDesktopTools* desktop_tools);
  void attach_agent_platform_tools(AgentPlatformTools* platform_tools);
  void attach_project_store(ProjectStore* projects);
  void attach_debug(DebugStore* debug);

  ToolApprovalGate& approvals() { return approvals_; }
  bool resolve_capability_permission(const std::string& id, bool approved, bool remember);

 private:
  struct CatalogEntry {
    std::string name;
    std::string description;
    bool enabled = true;
    std::string source = "builtin";
    bool needs_approval = false;
  };

  void load_catalog();
  std::string sandbox_root() const;
  Sandbox make_sandbox() const;
  Sandbox make_sandbox_for(const std::map<std::string, std::string>& args) const;
  std::map<std::string, std::string> args_map(const nlohmann::json& args) const;
  bool is_enabled(const CatalogEntry& entry) const;
  const CatalogEntry* find_entry(const std::string& name) const;
  nlohmann::json result_json(const ToolResult& r) const;
  nlohmann::json run_native(const std::string& name, const std::map<std::string, std::string>& args);
  nlohmann::json run_content_tool(const std::string& name,
                                  const std::map<std::string, std::string>& args);
  nlohmann::json run_mcp_tool(const std::string& name, const nlohmann::json& args);
  nlohmann::json run_plugin_tool(const std::string& name, const nlohmann::json& args);
  nlohmann::json run_unavailable_tool(const std::string& name,
                                  const std::map<std::string, std::string>& args);

  ConfigStore& config_;
  ProfileContext& profile_;
  MemoryStore& memory_;
  RagStore& rag_;
  SkillsStore& skills_;
  McpClientManager& mcp_;
  PluginStore& plugins_;
  ContentStudioSupervisor* content_studio_{nullptr};
  ContentStudioOrchestrator* content_orchestrator_{nullptr};
  AgentDesktopTools* agent_desktop_{nullptr};
  AgentPlatformTools* agent_platform_{nullptr};
  ProjectStore* projects_{nullptr};
  ContentJobDeliveryService* content_delivery_{nullptr};
  SessionStore* sessions_{nullptr};
  EventBus* events_{nullptr};
  DebugStore* debug_{nullptr};
  ToolApprovalGate approvals_;
  std::vector<CatalogEntry> catalog_;
  std::map<std::string, bool> toggles_;
};

}  // namespace omega::runtime

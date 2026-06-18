#pragma once

#include <map>
#include <mutex>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class ConfigStore;
class EngineClient;
class MediaPlayerService;
class ProjectStore;

/** Chat TTS flow: voice option cards, text input when needed, then synthesize to session media. */
class ChatTtsOrchestrator {
 public:
  void attach(ConfigStore* config, EngineClient* engine, ProjectStore* projects,
              MediaPlayerService* media);

  nlohmann::json run_tool(const std::map<std::string, std::string>& args);
  std::optional<nlohmann::json> try_resume_after_choice(const std::string& session_id,
                                                        const std::string& user_message);
  void discard_session(const std::string& session_id);

 private:
  struct PendingTts {
    std::map<std::string, std::string> args;
    bool awaiting_options{false};
  };

  std::optional<PendingTts> get_pending(const std::string& session_id) const;
  void set_pending(const std::string& session_id, PendingTts pending);
  void clear_pending(const std::string& session_id);

  nlohmann::json synthesize(const std::map<std::string, std::string>& args);

  ConfigStore* config_{nullptr};
  EngineClient* engine_{nullptr};
  ProjectStore* projects_{nullptr};
  MediaPlayerService* media_{nullptr};
  mutable std::mutex mu_;
  std::map<std::string, PendingTts> pending_;
};

}  // namespace omega::runtime

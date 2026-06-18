#pragma once

#include "omega/runtime/profile_context.hpp"

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ChatService;
class MemoryStore;

class CronStore {
 public:
  explicit CronStore(ProfileContext& profile);

  nlohmann::json list();
  nlohmann::json save(const nlohmann::json& input);
  void remove(const std::string& id);
  nlohmann::json pause(const std::string& id, bool paused);
  nlohmann::json run_now(const std::string& id, ChatService& chat, MemoryStore& memory);
  void tick(ChatService& chat, MemoryStore& memory);

 private:
  void execute_job(nlohmann::json& job, ChatService& chat, MemoryStore& memory);
  std::string file_path() const;
  nlohmann::json load_all();
  void persist(const nlohmann::json& jobs);
  static int64_t now_ms();
  static int64_t compute_next_run(const nlohmann::json& freq, int64_t from_ms);
  void deliver(const nlohmann::json& job, const std::string& text, MemoryStore& memory);

  ProfileContext& profile_;
};

}  // namespace omega::runtime

#pragma once

#include "omega/runtime/profile_context.hpp"

#include <atomic>
#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class ChatService;

class KanbanStore {
 public:
  explicit KanbanStore(ProfileContext& profile);

  nlohmann::json list();
  nlohmann::json save(const nlohmann::json& input);
  nlohmann::json move(const std::string& id, const std::string& status);
  void remove(const std::string& id);
  nlohmann::json dispatch(const std::string& id, ChatService& chat, const std::string& default_model);

 private:
  std::string file_path() const;
  nlohmann::json load_all();
  void persist(const nlohmann::json& tasks);
  static int64_t now_ms();
  static int priority_rank(const std::string& p);

  ProfileContext& profile_;
  std::atomic<bool> dispatching_{false};
};

}  // namespace omega::runtime

#include "omega/engine/dispatcher.hpp"

namespace omega::engine {

void Dispatcher::register_handler(const std::string& type, CommandHandler handler) {
  std::lock_guard lock(mutex_);
  handlers_[type] = std::move(handler);
}

CommandResponse Dispatcher::dispatch(const Command& cmd) const {
  CommandHandler handler;
  {
    std::lock_guard lock(mutex_);
    const auto it = handlers_.find(cmd.type);
    if (it == handlers_.end()) {
      return CommandResponse{
          .id = cmd.id,
          .type = cmd.type,
          .success = false,
          .data_json = "{}",
          .error = "unknown command: " + cmd.type,
      };
    }
    handler = it->second;
  }
  return handler(cmd);
}

}  // namespace omega::engine

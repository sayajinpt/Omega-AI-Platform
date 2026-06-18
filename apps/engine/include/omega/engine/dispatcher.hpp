#pragma once

#include <functional>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "omega/engine/command.hpp"

namespace omega::engine {

using CommandHandler = std::function<CommandResponse(const Command&)>;

/** Routes typed commands to registered service handlers. */
class Dispatcher {
 public:
  void register_handler(const std::string& type, CommandHandler handler);
  CommandResponse dispatch(const Command& cmd) const;

 private:
  mutable std::mutex mutex_;
  std::unordered_map<std::string, CommandHandler> handlers_;
};

}  // namespace omega::engine

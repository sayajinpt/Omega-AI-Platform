#pragma once

#include "omega/runtime/event_bus.hpp"

#include <mutex>
#include <nlohmann/json.hpp>

namespace omega::runtime {

class MediaPlayerService {
 public:
  explicit MediaPlayerService(EventBus& events);

  nlohmann::json state() const;
  nlohmann::json stop();
  nlohmann::json pause();
  nlohmann::json resume();
  nlohmann::json show_preview(const nlohmann::json& body);
  nlohmann::json play_local_path(const std::string& path, const std::string& title);
  nlohmann::json play_youtube_url(const std::string& url, const std::string& title,
                                  const std::string& embed_url = "", bool embed_in_chat = true);
  void stop_if_session(const std::string& session_id);

 private:
  void broadcast() const;

  EventBus& events_;
  mutable std::mutex mu_;
  nlohmann::json now_playing_;
};

}  // namespace omega::runtime

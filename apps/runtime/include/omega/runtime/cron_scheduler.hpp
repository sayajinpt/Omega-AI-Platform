#pragma once

#include "omega/runtime/storage/cron_store.hpp"

#include <atomic>
#include <thread>

namespace omega::runtime {

class ChatService;
class MemoryStore;

/** Background cron tick loop (30s interval, matches Electron main). */
class CronScheduler {
 public:
  CronScheduler(CronStore& store, ChatService& chat, MemoryStore& memory);
  ~CronScheduler();

  CronScheduler(const CronScheduler&) = delete;
  CronScheduler& operator=(const CronScheduler&) = delete;

  void start();
  void stop();

 private:
  void loop();

  CronStore& store_;
  ChatService& chat_;
  MemoryStore& memory_;
  std::atomic<bool> stop_{false};
  std::thread thread_;
};

}  // namespace omega::runtime

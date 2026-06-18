#include "omega/runtime/cron_scheduler.hpp"

#include "omega/runtime/chat/chat_service.hpp"
#include "omega/runtime/storage/memory_store.hpp"

#include <chrono>

namespace omega::runtime {

CronScheduler::CronScheduler(CronStore& store, ChatService& chat, MemoryStore& memory)
    : store_(store), chat_(chat), memory_(memory) {}

CronScheduler::~CronScheduler() { stop(); }

void CronScheduler::start() {
  if (thread_.joinable()) return;
  stop_.store(false);
  thread_ = std::thread([this] { loop(); });
}

void CronScheduler::stop() {
  stop_.store(true);
  if (thread_.joinable()) thread_.join();
}

void CronScheduler::loop() {
  std::this_thread::sleep_for(std::chrono::seconds(5));
  while (!stop_.load()) {
    try {
      store_.tick(chat_, memory_);
    } catch (...) {
    }
    for (int i = 0; i < 30 && !stop_.load(); ++i) {
      std::this_thread::sleep_for(std::chrono::seconds(1));
    }
  }
}

}  // namespace omega::runtime

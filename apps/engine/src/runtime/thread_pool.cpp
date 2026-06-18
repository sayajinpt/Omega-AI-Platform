#include "omega/engine/runtime/thread_pool.hpp"

#include <condition_variable>
#include <mutex>

namespace omega::engine {

ThreadPool::ThreadPool(std::size_t workers) {
  if (workers == 0) workers = 1;
  workers_.reserve(workers);
  for (std::size_t i = 0; i < workers; ++i) {
    workers_.emplace_back([this] { run_worker(); });
  }
}

ThreadPool::~ThreadPool() {
  {
    std::lock_guard lock(mutex_);
    stop_ = true;
  }
  cv_.notify_all();
  for (auto& w : workers_) {
    if (w.joinable()) w.join();
  }
}

void ThreadPool::submit(std::function<void()> task) {
  {
    std::lock_guard lock(mutex_);
    queue_.push(std::move(task));
  }
  cv_.notify_one();
}

void ThreadPool::run_worker() {
  while (true) {
    std::function<void()> task;
    {
      std::unique_lock lock(mutex_);
      cv_.wait(lock, [this] { return stop_ || !queue_.empty(); });
      if (stop_ && queue_.empty()) return;
      task = std::move(queue_.front());
      queue_.pop();
    }
    if (task) task();
  }
}

}  // namespace omega::engine

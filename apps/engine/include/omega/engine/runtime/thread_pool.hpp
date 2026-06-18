#pragma once

#include <cstddef>
#include <functional>
#include <future>
#include <queue>
#include <thread>
#include <vector>

namespace omega::engine {

/** Fixed worker pool for registry scans and other service I/O — Phase 6. */
class ThreadPool {
 public:
  explicit ThreadPool(std::size_t workers);
  ~ThreadPool();

  ThreadPool(const ThreadPool&) = delete;
  ThreadPool& operator=(const ThreadPool&) = delete;

  std::size_t worker_count() const { return workers_.size(); }

  void submit(std::function<void()> task);

  template <typename F>
  auto submit_future(F&& f) -> std::future<std::invoke_result_t<F>> {
    using R = std::invoke_result_t<F>;
    auto packaged = std::make_shared<std::packaged_task<R()>>(std::forward<F>(f));
    std::future<R> fut = packaged->get_future();
    submit([packaged]() { (*packaged)(); });
    return fut;
  }

 private:
  std::vector<std::thread> workers_;
  std::queue<std::function<void()>> queue_;
  std::mutex mutex_;
  std::condition_variable cv_;
  bool stop_ = false;

  void run_worker();
};

}  // namespace omega::engine

#pragma once

#include <atomic>
#include <cstdint>

namespace omega::engine {

/** Tracks IPC dispatch latency for health probes — Phase 6. */
struct DispatchMetrics {
  std::atomic<int64_t> last_dispatch_us{0};
  std::atomic<int64_t> max_dispatch_us{0};

  void record(int64_t duration_us);
};

}  // namespace omega::engine

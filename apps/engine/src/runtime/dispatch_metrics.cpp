#include "omega/engine/runtime/dispatch_metrics.hpp"

#include <algorithm>

namespace omega::engine {

void DispatchMetrics::record(int64_t duration_us) {
  last_dispatch_us.store(duration_us, std::memory_order_relaxed);
  int64_t cur = max_dispatch_us.load(std::memory_order_relaxed);
  while (duration_us > cur &&
         !max_dispatch_us.compare_exchange_weak(cur, duration_us, std::memory_order_relaxed)) {
  }
}

}  // namespace omega::engine

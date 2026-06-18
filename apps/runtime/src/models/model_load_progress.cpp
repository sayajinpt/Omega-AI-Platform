#include "omega/runtime/models/model_load_progress.hpp"

#include <algorithm>
#include <chrono>
#include <map>
#include <sstream>
#include <vector>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

}  // namespace

ModelLoadProgress::ModelLoadProgress(EventBus& events) : events_(events) {
  last_ = json{{"modelId", ""}, {"phase", "idle"}, {"detail", ""}, {"percent", 0}};
}

int ModelLoadProgress::percent_for_phase(const std::string& phase, int prev) {
  static const std::map<std::string, int> k{
      {"start", 5},   {"prepare", 10}, {"path", 15}, {"gpu", 28},
      {"weights", 55}, {"context", 82}, {"ollama", 40}, {"runtime", 45}, {"ready", 100}};
  const auto it = k.find(phase);
  if (it == k.end()) return std::min(99, prev + 2);
  return std::max(prev, it->second);
}

void ModelLoadProgress::emit(const std::string& model_id, const std::string& phase,
                             const std::string& detail) {
  json payload;
  {
    std::lock_guard lock(mu_);
    const int prev = last_.value("percent", 0);
    const int pct = percent_for_phase(phase, prev);
    payload = json{{"modelId", model_id},
                   {"phase", phase},
                   {"detail", detail.empty() ? phase : detail},
                   {"percent", pct},
                   {"ts", now_ms()}};
    last_ = payload;
  }
  events_.publish("omega:models:load-progress", payload);
}

void ModelLoadProgress::emit_percent(const std::string& model_id, int percent,
                                     const std::string& detail) {
  json payload;
  {
    std::lock_guard lock(mu_);
    const int prev = last_.value("percent", 0);
    const int pct = std::max(prev, std::clamp(percent, 0, 99));
    payload = json{{"modelId", model_id},
                   {"phase", "weights"},
                   {"detail", detail.empty() ? "Loading weights…" : detail},
                   {"percent", pct},
                   {"ts", now_ms()}};
    last_ = payload;
  }
  events_.publish("omega:models:load-progress", payload);
}

json ModelLoadProgress::snapshot() const {
  std::lock_guard lock(mu_);
  return last_;
}

}  // namespace omega::runtime

#include "omega/runtime/python/setup_progress.hpp"

#include <algorithm>

namespace omega::runtime {

namespace {

struct StepDef {
  const char* id;
  const char* label;
};

constexpr StepDef kSteps[] = {
    {"venv", "Omega unified venv (~/.omega/venvs/unified)"},
    {"pip-base", "Shared base packages"},
    {"playwright", "Playwright Chromium"},
    {"content-api", "Content Studio API packages"},
    {"gen-models", "Generation models package"},
    {"content-media", "GPU media packages (PyTorch, TTS, diffusers)"},
};

bool detail_contains(const std::string& detail, const char* needle) {
  return detail.find(needle) != std::string::npos;
}

}  // namespace

ContentStudioSetupProgressTracker::ContentStudioSetupProgressTracker(EventBus& events)
    : events_(events) {
  for (const auto& s : kSteps) {
    steps_.push_back(
        nlohmann::json{{"id", s.id}, {"label", s.label}, {"status", "pending"}});
  }
}

void ContentStudioSetupProgressTracker::set_step(const std::string& id,
                                                 const std::string& status,
                                                 const std::string& detail) {
  for (auto& step : steps_) {
    if (step.value("id", "") != id) continue;
    step["status"] = status;
    if (detail.empty()) {
      step.erase("detail");
    } else {
      step["detail"] = detail;
    }
    return;
  }
}

int ContentStudioSetupProgressTracker::percent_done() const {
  if (steps_.empty()) return 0;
  int done = 0;
  for (const auto& step : steps_) {
    const std::string status = step.value("status", "");
    if (status == "done" || status == "skipped") done++;
  }
  return (done * 100) / static_cast<int>(steps_.size());
}

void ContentStudioSetupProgressTracker::publish(bool running, const std::string& error) {
  nlohmann::json payload{{"running", running},
                         {"steps", steps_},
                         {"percent", percent_done()}};
  if (!error.empty()) payload["error"] = error;
  events_.publish("omega:content-studio:setupProgress", payload);
}

void ContentStudioSetupProgressTracker::publish_error(const std::string& message) {
  bool marked = false;
  for (auto& step : steps_) {
    if (step.value("status", "") == "running") {
      step["status"] = "error";
      step["detail"] = message;
      marked = true;
    }
  }
  if (!marked && message.find("venv") != std::string::npos) {
    set_step("venv", "error", message);
  }
  running_ = false;
  publish(false, message);
}

void ContentStudioSetupProgressTracker::on_phase(const std::string& phase,
                                                 const std::string& detail) {
  if (phase == "start") {
    running_ = true;
    if (detail_contains(detail, "content-only")) {
      set_step("venv", "done");
      set_step("pip-base", "done");
      set_step("playwright", "skipped", "not needed for content-only install");
    }
    publish(true);
    return;
  }
  if (phase == "error") {
    publish_error(detail.empty() ? "Setup failed" : detail);
    return;
  }
  if (phase == "done") {
    running_ = false;
    publish(false);
    return;
  }
  if (phase == "content-media" && detail == "done") {
    set_step("content-media", "done");
    publish(true);
    return;
  }
  if (phase == "venv") {
    set_step("venv", "running", detail);
    publish(true);
    return;
  }
  if (phase == "pip" && detail_contains(detail, "upgrade")) {
    set_step("venv", "done");
    set_step("pip-base", "running", detail);
    publish(true);
    return;
  }
  if (phase == "packages") {
    if (detail_contains(detail, "base requirements")) {
      set_step("venv", "done");
      set_step("pip-base", "running", detail);
    } else if (detail_contains(detail, "content studio")) {
      set_step("pip-base", "done");
      set_step("playwright", "done");
      if (detail_contains(detail, "local media") || detail_contains(detail, "torch stack")) {
        set_step("content-api", "done");
        set_step("gen-models", "done");
        set_step("content-media", "running", detail);
      } else {
        set_step("content-api", "running", detail);
      }
    } else if (detail_contains(detail, "generation_models")) {
      if (detail_contains(detail, "[tts,image]")) {
        set_step("content-api", "done");
        set_step("content-media", "running", detail);
      } else {
        set_step("content-api", "done");
        set_step("gen-models", "running", detail);
      }
    }
    publish(true);
    return;
  }
  if (phase == "playwright") {
    set_step("pip-base", "done");
    if (detail_contains(detail, "failed")) {
      set_step("playwright", "skipped", detail);
    } else {
      set_step("playwright", "running", detail);
    }
    publish(true);
    return;
  }
  if (phase == "pip") {
    publish(true);
  }
}

}  // namespace omega::runtime

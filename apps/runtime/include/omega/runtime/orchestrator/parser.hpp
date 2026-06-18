#pragma once

#include <optional>
#include <string>
#include <vector>

namespace omega::runtime {

enum class OrchestratorMode { Reply, Plan };

struct OrchestratorPlan {
  OrchestratorMode mode = OrchestratorMode::Reply;
  std::string briefing;
  std::vector<std::string> tools;
  std::string response;
};

/** Result of PROMPT_1 (plan phase) parsing. */
struct OrchestratorPlanParse {
  bool ok = false;
  OrchestratorPlan plan;
};

/** Parse PROMPT_1 model output (<omega_turn> or legacy briefing/tools tags). */
OrchestratorPlanParse parse_plan_phase(const std::string& text);

/** @deprecated Use parse_plan_phase; kept for compatibility. */
std::optional<OrchestratorPlan> parse_orchestrator_turn(const std::string& text);

std::string strip_orchestrator_markup(const std::string& text);

/** Visible assistant text when mode=reply. */
std::string visible_reply_from_plan(const std::string& raw, const OrchestratorPlan& plan);

}  // namespace omega::runtime

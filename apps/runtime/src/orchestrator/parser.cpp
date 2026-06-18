#include "omega/runtime/orchestrator/parser.hpp"

#include "omega/runtime/orchestrator/tool_catalog.hpp"

#include <algorithm>
#include <regex>
#include <sstream>

namespace omega::runtime {

namespace {

std::string extract_tag(const std::string& block, const std::string& tag) {
  const std::string open = "<" + tag;
  const auto start = block.find(open);
  if (start == std::string::npos) return "";
  const auto gt = block.find('>', start);
  if (gt == std::string::npos) return "";
  const auto close = block.find("</" + tag + ">", gt);
  if (close == std::string::npos) return "";
  std::string inner = block.substr(gt + 1, close - gt - 1);
  while (!inner.empty() && (inner.front() == '\n' || inner.front() == ' ')) inner.erase(inner.begin());
  while (!inner.empty() && (inner.back() == '\n' || inner.back() == ' ')) inner.pop_back();
  return inner;
}

std::vector<std::string> parse_tools_list(const std::string& raw) {
  std::vector<std::string> out;
  std::string token;
  for (char c : raw) {
    if (c == ',' || c == ';' || c == '\n') {
      while (!token.empty() && token.front() == ' ') token.erase(token.begin());
      while (!token.empty() && token.back() == ' ') token.pop_back();
      if (!token.empty()) out.push_back(token);
      token.clear();
    } else {
      token.push_back(c);
    }
  }
  if (!token.empty()) {
    while (!token.empty() && token.front() == ' ') token.erase(token.begin());
    while (!token.empty() && token.back() == ' ') token.pop_back();
    if (!token.empty()) out.push_back(token);
  }
  return out;
}

void normalize_tool_list(std::vector<std::string>& tools) {
  for (auto& t : tools) t = normalize_orchestrator_tool_name(t);
  tools.erase(std::remove_if(tools.begin(), tools.end(),
                             [](const std::string& s) { return s.empty(); }),
              tools.end());
}

std::optional<OrchestratorPlan> parse_omega_turn_block(const std::string& text) {
  static const std::regex block_re(
      R"re(<omega_turn[^>]*mode=["']?(reply|plan)["']?[^>]*>([\s\S]*?)</omega_turn>)re",
      std::regex_constants::icase);
  std::smatch m;
  if (!std::regex_search(text, m, block_re)) return std::nullopt;

  OrchestratorPlan plan;
  const std::string mode = m[1].str();
  const std::string inner = m[2].str();
  plan.mode = (mode == "plan" || mode == "Plan") ? OrchestratorMode::Plan : OrchestratorMode::Reply;

  if (plan.mode == OrchestratorMode::Reply) {
    std::string response = extract_tag(inner, "response");
    if (response.empty()) response = extract_tag(text, "response");
    if (response.empty()) {
      response = inner;
      response = std::regex_replace(response, std::regex(R"(</?[^>]+>)"), "");
    }
    if (response.empty()) return std::nullopt;
    plan.response = response;
    return plan;
  }

  plan.briefing = extract_tag(inner, "briefing");
  if (plan.briefing.empty()) plan.briefing = extract_tag(text, "briefing");
  if (plan.briefing.empty()) plan.briefing = "Execute user request";

  const std::string tools_raw = extract_tag(inner, "tools").empty() ? extract_tag(text, "tools")
                                                                    : extract_tag(inner, "tools");
  plan.tools = parse_tools_list(tools_raw);
  normalize_tool_list(plan.tools);
  return plan;
}

std::optional<OrchestratorPlan> parse_legacy_briefing_tools(const std::string& text) {
  const std::string briefing = extract_tag(text, "briefing");
  const std::string tools_raw = extract_tag(text, "tools");
  if (briefing.empty() && tools_raw.empty()) return std::nullopt;

  OrchestratorPlan plan;
  plan.mode = OrchestratorMode::Plan;
  plan.briefing = briefing.empty() ? "Execute user request" : briefing;
  plan.tools = parse_tools_list(tools_raw);
  normalize_tool_list(plan.tools);
  if (plan.tools.empty()) return std::nullopt;
  return plan;
}

}  // namespace

OrchestratorPlanParse parse_plan_phase(const std::string& text) {
  OrchestratorPlanParse out;
  if (auto turn = parse_omega_turn_block(text)) {
    out.ok = true;
    out.plan = *turn;
    return out;
  }
  if (auto legacy = parse_legacy_briefing_tools(text)) {
    out.ok = true;
    out.plan = *legacy;
    return out;
  }

  static const std::regex plan_hint(
      R"re(\b(?:JOB\s+BRIEFING|briefing)\s*[:]\s*(.+?)(?:\n|TOOLS\s*[:]|$))re",
      std::regex_constants::icase);
  std::smatch m;
  if (std::regex_search(text, m, plan_hint)) {
    out.ok = true;
    out.plan.mode = OrchestratorMode::Plan;
    out.plan.briefing = m[1].str();
    const std::string tools_raw = extract_tag(text, "tools");
    if (!tools_raw.empty()) {
      out.plan.tools = parse_tools_list(tools_raw);
      normalize_tool_list(out.plan.tools);
    }
    if (!out.plan.tools.empty()) return out;
  }

  return out;
}

std::optional<OrchestratorPlan> parse_orchestrator_turn(const std::string& text) {
  const auto parsed = parse_plan_phase(text);
  if (parsed.ok) return parsed.plan;
  return std::nullopt;
}

std::string strip_orchestrator_markup(const std::string& text) {
  static const std::regex re(R"(<omega_turn[\s\S]*?</omega_turn>)", std::regex_constants::icase);
  std::string out = std::regex_replace(text, re, "");
  out = std::regex_replace(out, std::regex(R"(</?briefing>[\s\S]*?</briefing>)", std::regex_constants::icase), "");
  out = std::regex_replace(out, std::regex(R"(</?tools>[\s\S]*?</tools>)", std::regex_constants::icase), "");
  return out;
}

std::string visible_reply_from_plan(const std::string& raw, const OrchestratorPlan& plan) {
  if (!plan.response.empty()) return plan.response;
  std::string text = strip_orchestrator_markup(raw);
  while (!text.empty() && (text.front() == '\n' || text.front() == ' ')) text.erase(text.begin());
  while (!text.empty() && (text.back() == '\n' || text.back() == ' ')) text.pop_back();
  return text;
}

}  // namespace omega::runtime

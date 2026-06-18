/**
 * GGUF chat-template formatting (enable_thinking, Qwen3 /no_think, etc.)
 */
#include "omega_infer.h"
#include "omega_infer_internal.h"

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP

#  include "chat.h"
#  include "llama.h"

#  if defined(OMEGA_HAVE_QWEN35_CHAT_TEMPLATE)
#    include "omega_qwen35_chat_template.h"
#  endif

#  include <cstring>
#  include <exception>
#  include <string>
#  include <vector>

namespace {

std::string model_architecture(llama_model * model) {
  if (!model) {
    return {};
  }
  char buf[128];
  const int32_t n = llama_model_meta_val_str(model, "general.architecture", buf, sizeof(buf));
  if (n <= 0) {
    return {};
  }
  return std::string(buf, static_cast<size_t>(n));
}

bool architecture_needs_qwen35_template(const std::string & arch) {
  if (arch.empty()) {
    return false;
  }
  return arch.find("qwen35") != std::string::npos;
}

std::string lower_ascii(std::string s) {
  for (char & c : s) {
    if (c >= 'A' && c <= 'Z') {
      c = static_cast<char>(c - 'A' + 'a');
    }
  }
  return s;
}

bool meta_value_suggests_qwen35(llama_model * model, const char * key) {
  if (!model || !key) {
    return false;
  }
  char buf[512];
  const int32_t n = llama_model_meta_val_str(model, key, buf, sizeof(buf));
  if (n <= 0) {
    return false;
  }
  const std::string value = lower_ascii(std::string(buf, static_cast<size_t>(n)));
  return value.find("qwen3.5") != std::string::npos || value.find("qwen35") != std::string::npos;
}

bool model_needs_qwen35_template(llama_model * model) {
  if (!model) {
    return false;
  }
  // Only swap templates when GGUF architecture is qwen35 — filename/metadata heuristics
  // mis-fire on merged/custom models and can crash jinja template apply inside llama.cpp.
  return architecture_needs_qwen35_template(model_architecture(model));
}

bool chat_templates_usable(const common_chat_templates * tmpls) {
  return tmpls != nullptr;
}

bool resolve_enable_thinking(const common_chat_templates * tmpls, bool requested) {
  if (!requested || !chat_templates_usable(tmpls)) {
    return false;
  }
  try {
    return common_chat_templates_support_enable_thinking(tmpls);
  } catch (...) {
    return false;
  }
}

common_chat_templates_ptr init_chat_templates(llama_model * model) {
  auto tmpls = common_chat_templates_init(model, "", "");
  if (!tmpls) {
    return tmpls;
  }
  if (common_chat_templates_was_explicit(tmpls.get())) {
    return tmpls;
  }

  if (!model_needs_qwen35_template(model)) {
    return tmpls;
  }

#  if defined(OMEGA_HAVE_QWEN35_CHAT_TEMPLATE)
  tmpls = common_chat_templates_init(model, OMEGA_QWEN35_CHAT_TEMPLATE, "");
#  else
  (void) arch;
#  endif
  return tmpls;
}

std::string format_with_template(llama_model * model,
                                 const omega_chat_turn_t * turns,
                                 size_t n_turns,
                                 bool enable_thinking) {
  if (!model || !turns) {
    return {};
  }

  try {
    auto tmpls = init_chat_templates(model);
    if (!chat_templates_usable(tmpls.get())) {
      return {};
    }

    common_chat_templates_inputs inputs;
    inputs.enable_thinking       = resolve_enable_thinking(tmpls.get(), enable_thinking);
    inputs.use_jinja             = true;
    inputs.add_generation_prompt = true;

    inputs.messages.reserve(n_turns);
    for (size_t i = 0; i < n_turns; ++i) {
      common_chat_msg msg;
      msg.role    = turns[i].role ? turns[i].role : "";
      msg.content = turns[i].content ? turns[i].content : "";
      inputs.messages.push_back(std::move(msg));
    }

    const common_chat_params params = common_chat_templates_apply(tmpls.get(), inputs);
    return params.prompt;
  } catch (const std::exception &) {
    return {};
  } catch (...) {
    return {};
  }
}

}  // namespace

#endif

extern "C" {

int omega_format_chat_prompt(omega_model_t * model,
                             const omega_chat_turn_t * turns,
                             size_t n_turns,
                             int enable_thinking,
                             char * out,
                             size_t out_cap) {
#if !defined(OMEGA_HAVE_LLAMA_CPP) || !OMEGA_HAVE_LLAMA_CPP
  (void) model;
  (void) turns;
  (void) n_turns;
  (void) enable_thinking;
  (void) out;
  (void) out_cap;
  return OMEGA_ERR_NOT_BUILT;
#else
  auto * m = reinterpret_cast<omega_model_impl *>(model);
  if (!m || !m->model || !turns || !out || out_cap == 0) {
    return OMEGA_ERR;
  }

  const std::string prompt =
      format_with_template(m->model, turns, n_turns, enable_thinking != 0);
  if (prompt.empty()) {
    return OMEGA_ERR;
  }

  if (prompt.size() >= out_cap) {
    return -static_cast<int>(prompt.size() + 1);
  }

  std::memcpy(out, prompt.data(), prompt.size());
  out[prompt.size()] = '\0';
  return static_cast<int>(prompt.size());
#endif
}

}  // extern "C"

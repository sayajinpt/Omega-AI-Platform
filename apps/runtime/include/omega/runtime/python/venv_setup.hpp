#pragma once

#include <functional>
#include <string>

namespace omega::runtime {

using VenvProgressCallback = std::function<void(const std::string& phase, const std::string& detail)>;

struct UnifiedVenvSetupOptions {
  /** base | sidecar | content | content-media | full */
  std::string profile = "base";
  /** When set, pip-install sidecar stack into unified venv (Sidecar UI). */
  bool sidecar_exl2 = false;
  bool sidecar_onnx = false;
  /** Pip-install router-models stack (Optimum/ONNX). */
  bool router_models = false;
};

/** Create/update ~/.omega/venvs/unified without Node. Returns exit code (0 = ok). */
int run_unified_venv_setup(const UnifiedVenvSetupOptions& opts, const VenvProgressCallback& on_progress);

/** Pip-install Content Studio API stack (requirements-omega + generation_models). Returns 0 on ok. */
int install_content_studio_stack(const std::string& py, const VenvProgressCallback& on_progress = nullptr);

/** Pip-install torch/TTS/diffusers stack (requirements-local-media.txt). Returns 0 on ok. */
int install_content_studio_local_media(const std::string& py,
                                       const VenvProgressCallback& on_progress = nullptr);

/** Find a system Python 3.10+ launcher command (e.g. `py -3.12` or `python3.11`). Empty if none. */
std::string find_system_python_launcher();

}  // namespace omega::runtime

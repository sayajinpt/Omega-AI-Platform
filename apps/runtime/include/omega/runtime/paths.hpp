#pragma once

#include <string>

namespace omega::runtime {

std::string omega_home();
std::string config_path();
std::string models_dir();
std::string plugins_dir();
std::string resolve_engine_binary();
/** Packaged ``bin/`` next to omega-engine (CUDA/Vulkan helper DLLs). */
std::string resolve_bundled_bin_dir();
/** Writable stderr log for the omega-engine child process. */
std::string resolve_engine_stderr_log();
/** Runtime-written load trace (always populated on failures). */
std::string resolve_load_diagnostic_log();
void append_load_diagnostic(const std::string& message);
std::string resolve_ollama_binary();
std::string resolve_unified_python();
std::string resolve_resources_root();
std::string resolve_engines_root();
std::string resolve_python_unified_root();
std::string resolve_python_runtime_script(const std::string& name);
std::string resolve_content_studio_backend();
std::string resolve_claw3d_office_root();
/** Absolute path to .next/standalone/node_modules (Next production trace). */
std::string resolve_claw3d_standalone_node_modules();
std::string resolve_claw3d_adapter_script();
/** node.exe on PATH or OMEGA_NODE_BIN; empty if not found. */
std::string resolve_node_binary();
std::string resolve_quantize_binary();
std::string resolve_sidecar_python();
std::string resolve_router_models_build_script();
std::string resolve_router_models_python();
std::string resolve_content_studio_download_script();
std::string resolve_content_studio_generation_models();
/** True when ``path`` resolves inside ``omega_home()`` (or a subfolder). */
bool path_is_under_omega_home(const std::string& path);
/** HF snapshot root: ~/.omega/models/generation-models (override only if under ~/.omega). */
std::string resolve_content_studio_generation_models_root();
std::string resolve_content_studio_native_media_script();
/** Same tree as Content Studio ``settings.storage_path`` (backend/storage by default). */
std::string resolve_content_studio_storage();
/** Writable SQLite data dir under ~/.omega/content-studio/data (not install dir). */
std::string resolve_content_studio_data_dir();
/** sqlite:/// URL for Content Studio media_auto.db. */
std::string resolve_content_studio_database_url();
/** Shell env prefix for Content Studio Python subprocesses (native media phases, etc.). */
std::string content_studio_subprocess_env_prefix();
std::string runtime_executable_dir();

}  // namespace omega::runtime

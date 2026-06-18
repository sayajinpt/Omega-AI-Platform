#pragma once

#include <optional>
#include <string>

namespace omega::shell {

/** Resolve ~/.omega or OMEGA_HOME. */
std::string omega_home();

/** Directory containing omega-desktop.exe. */
std::string exe_dir();

/** dist/ui or resources/ui next to packaged layout. */
std::string ui_root();

std::string runtime_binary_path();
std::string engine_binary_path();
std::string ollama_binary_path();
std::string bundled_bin_dir();
/** Packaged resources/ next to omega-desktop.exe (engines, claw3d-office, …). */
std::string resources_dir();
std::string engine_binary_dir();

/** Append bundled bin + engine dirs to PATH for child processes. */
std::string augmented_path();

bool file_exists(const std::string& path);

/** ~/.omega/content-studio/storage (finished job MP4s). */
std::string content_studio_storage_dir();

}  // namespace omega::shell

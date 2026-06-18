#pragma once

namespace omega {

/** Windows: register resources/bin (or OMEGA_BIN_DIR) for CUDA runtime DLL lookup. */
void init_shared_dll_search_paths();

}

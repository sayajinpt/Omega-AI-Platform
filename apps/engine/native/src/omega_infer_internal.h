#pragma once

#include "omega_infer.h"

#include <string>
#include <vector>

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
#  include "llama.h"
#endif

#if defined(OMEGA_HAVE_MTMD) && OMEGA_HAVE_MTMD
#  include "mtmd.h"
#endif

struct LayerQuantRange {
    int from_layer = 0;
    int to_layer   = 0;
    std::string quant;
};

struct omega_model_impl {
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    llama_model * model = nullptr;
    llama_context * ctx = nullptr;
#endif
    std::string path;
    std::string original_path;
    std::string mmproj_path;
    omega_load_params_t load{};
    std::string quant_policy;
    int n_paging_ops = 0;
    int gpu_layer_cutoff = -1;
    std::vector<LayerQuantRange> layer_quants;
#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
    std::vector<llama_model_tensor_buft_override> buft_overrides;
#endif
    std::vector<char> buft_pattern_buf;
    bool used_inflight_paging = false;
    bool used_mixed_quant = false;
#if defined(OMEGA_HAVE_MTMD) && OMEGA_HAVE_MTMD
    mtmd_context * mctx = nullptr;
#endif
};

#if defined(OMEGA_HAVE_LLAMA_CPP) && OMEGA_HAVE_LLAMA_CPP
void omega_impl_clear_kv(omega_model_impl * m);
bool omega_impl_reload_context(omega_model_impl * m);
int  omega_impl_setup_vision(omega_model_impl * m, const char * mmproj_override);
void omega_impl_teardown_vision(omega_model_impl * m);
#endif

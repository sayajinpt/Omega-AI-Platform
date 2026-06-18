/**
 * CMake flags for llama.cpp / libomega_infer builds that must run on end-user
 * machines, not only the builder's CPU and GPU.
 */

/** Real SASS (not PTX-only) for common NVIDIA GPUs in packaged installs. */
export const OMEGA_PACKAGED_CUDA_ARCHITECTURES = '75-real;80-real;86-real;89-real;90-real;120a-real'

export const GGML_PORTABLE_CPU_CMAKE_ARGS = [
  '-DGGML_NATIVE=OFF',
  '-DGGML_CPU_REPACK=OFF',
  '-DGGML_AVX512=OFF'
]

/** @returns {string[]} */
export function packagedCudaCmakeArgs() {
  return [
    ...GGML_PORTABLE_CPU_CMAKE_ARGS,
    `-DCMAKE_CUDA_ARCHITECTURES=${OMEGA_PACKAGED_CUDA_ARCHITECTURES}`
  ]
}

/**
 * CMake flags for standalone llama.cpp builds (llama-server / llama-quantize).
 */
import { fileURLToPath } from 'node:url'
import { resolveEngineGpuBuildOptions } from './engine-gpu-backend.mjs'
import { resolveVariant } from './llama-variants.mjs'
import {
  GGML_PORTABLE_CPU_CMAKE_ARGS,
  OMEGA_PACKAGED_CUDA_ARCHITECTURES,
  packagedCudaCmakeArgs
} from './ggml-portable-cmake.mjs'

/** CMake flags so llama.cpp binaries run on end-user CPUs (not only the build machine). */
export { GGML_PORTABLE_CPU_CMAKE_ARGS, OMEGA_PACKAGED_CUDA_ARCHITECTURES, packagedCudaCmakeArgs }

/**
 * @param {string} root
 * @param {import('./llama-variants.mjs').LlamaVariant} variant
 */
export function resolveInferSourceGpuOptions(root, variant) {
  const prev = process.env.OMEGA_LLAMA_VARIANT
  process.env.OMEGA_LLAMA_VARIANT = variant.id
  try {
    return resolveEngineGpuBuildOptions(root)
  } finally {
    if (prev === undefined) delete process.env.OMEGA_LLAMA_VARIANT
    else process.env.OMEGA_LLAMA_VARIANT = prev
  }
}

/**
 * @param {{ enableCuda: boolean, enableVulkan: boolean }} gpu
 * @returns {string[]}
 */
export function llamaStandaloneCmakeArgs(gpu) {
  const args = [
    '-DLLAMA_BUILD_TOOLS=ON',
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DBUILD_SHARED_LIBS=ON',
    ...GGML_PORTABLE_CPU_CMAKE_ARGS
  ]
  if (gpu.enableCuda) {
    args.push('-DGGML_CUDA=ON', '-DGGML_VULKAN=OFF')
    if (process.platform === 'win32') args.push('-DGGML_CUDA_CUB_3DOT2=ON')
    args.push(`-DCMAKE_CUDA_ARCHITECTURES=${OMEGA_PACKAGED_CUDA_ARCHITECTURES}`)
    return args
  }
  if (gpu.enableVulkan) {
    args.push('-DGGML_CUDA=OFF', '-DGGML_VULKAN=ON')
    return args
  }
  args.push('-DGGML_CUDA=OFF', '-DGGML_VULKAN=OFF')
  return args
}

/** CLI: node scripts/lib/infer-source-cmake-args.mjs --cmake-args --variant=win-cuda */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const variantArg = process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1]
  if (variantArg) process.env.OMEGA_LLAMA_VARIANT = variantArg
  const root = process.cwd()
  const variant = variantArg ? resolveVariant(variantArg) : null
  const gpu = variant ? resolveInferSourceGpuOptions(root, variant) : resolveEngineGpuBuildOptions(root)
  if (process.argv.includes('--cmake-args')) {
    console.log(JSON.stringify(llamaStandaloneCmakeArgs(gpu)))
    process.exit(0)
  }
  console.log(JSON.stringify(gpu))
}

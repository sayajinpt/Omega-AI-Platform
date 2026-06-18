cmake_minimum_required(VERSION 3.20)
project(omega_infer C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(OMEGA_HAVE_LLAMA_CPP "Link against llama.cpp" ON)

set(LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp")
if(NOT EXISTS "${LLAMA_CPP_DIR}/CMakeLists.txt")
  set(_legacy_llama "${CMAKE_CURRENT_SOURCE_DIR}/../../runtime/native/third_party/llama.cpp")
  if(EXISTS "${_legacy_llama}/CMakeLists.txt")
    set(LLAMA_CPP_DIR "${_legacy_llama}")
  endif()
endif()
unset(_legacy_llama)

add_library(omega_infer SHARED
  src/omega_infer.cpp
  src/omega_infer_chat.cpp
)

target_include_directories(omega_infer PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

target_compile_definitions(omega_infer PRIVATE OMEGA_INFER_EXPORTS)

if(OMEGA_HAVE_LLAMA_CPP AND EXISTS "${LLAMA_CPP_DIR}/CMakeLists.txt")
  message(STATUS "Building libomega_infer with llama.cpp from ${LLAMA_CPP_DIR}")

  option(OMEGA_GGML_CUDA "Build llama.cpp with NVIDIA CUDA GPU offload" OFF)
  option(OMEGA_GGML_VULKAN "Build llama.cpp with Vulkan GPU offload" OFF)
  if(OMEGA_GGML_CUDA)
    set(GGML_CUDA ON CACHE BOOL "Enable CUDA for GPU layers" FORCE)
    set(GGML_VULKAN OFF CACHE BOOL "Enable Vulkan for GPU layers" FORCE)
    if(MSVC)
      set(GGML_CUDA_CUB_3DOT2 ON CACHE BOOL "CUDA 13+ CCCL cub" FORCE)
    endif()
    # llama.cpp defaults include 75-virtual (PTX-only). On GTX 16xx / Turing (sm_75)
    # inference fails at runtime: "no kernel image is available for execution on the device".
    set(OMEGA_CUDA_ARCHITECTURES "75-real;80-real;86-real;89-real;90-real;120a-real"
        CACHE STRING "CUDA SASS targets for packaged end-user GPUs" FORCE)
    set(CMAKE_CUDA_ARCHITECTURES "${OMEGA_CUDA_ARCHITECTURES}" CACHE STRING "" FORCE)
    message(STATUS "libomega_infer: CMAKE_CUDA_ARCHITECTURES=${OMEGA_CUDA_ARCHITECTURES}")
    message(STATUS "libomega_infer: GGML_CUDA=ON")
  elseif(OMEGA_GGML_VULKAN)
    set(GGML_VULKAN ON CACHE BOOL "Enable Vulkan for GPU layers" FORCE)
    set(GGML_CUDA OFF CACHE BOOL "Enable CUDA for GPU layers" FORCE)
    message(STATUS "libomega_infer: GGML_VULKAN=ON")
  else()
    set(GGML_CUDA OFF CACHE BOOL "Enable CUDA for GPU layers" FORCE)
    set(GGML_VULKAN OFF CACHE BOOL "Enable Vulkan for GPU layers" FORCE)
    message(STATUS "libomega_infer: CPU-only (no GGML_CUDA / GGML_VULKAN)")
  endif()

  # Packaged installs must run on end-user CPUs, not only the builder machine.
  # GGML_NATIVE=ON (Windows default) runs FindSIMD on the build host and can enable
  # AVX512/AMX; executing that code on older CPUs yields ILLEGAL_INSTRUCTION (0xC000001D).
  # GGML_CPU_REPACK uses q4_K_8x8 SIMD repack kernels that fail the same way on some CPUs.
  set(GGML_NATIVE OFF CACHE BOOL "ggml: optimize for build CPU (off for packaged installs)" FORCE)
  set(GGML_CPU_REPACK OFF CACHE BOOL "ggml: runtime Q4 repack (off for broad CPU compatibility)" FORCE)
  set(GGML_AVX512 OFF CACHE BOOL "ggml: AVX512F" FORCE)

  set(LLAMA_BUILD_COMMON ON CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_TOOLS ON CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
  set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
  add_subdirectory(${LLAMA_CPP_DIR} llama_cpp_build EXCLUDE_FROM_ALL)

  if(TARGET llama)
    target_sources(llama PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/patches/llama_model_migrate.cpp)
    target_include_directories(llama PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/patches)
    target_include_directories(llama PRIVATE ${LLAMA_CPP_DIR}/src)
  endif()

  target_compile_definitions(omega_infer PRIVATE OMEGA_HAVE_LLAMA_CPP=1)
  target_include_directories(omega_infer PRIVATE ${LLAMA_CPP_DIR}/include)
  target_include_directories(omega_infer PRIVATE ${LLAMA_CPP_DIR}/common)
  target_include_directories(omega_infer PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/patches)

  set(_QWEN35_JINJA "${LLAMA_CPP_DIR}/models/templates/Qwen3.5-4B.jinja")
  find_package(Python3 COMPONENTS Interpreter QUIET)
  if(Python3_FOUND AND EXISTS "${_QWEN35_JINJA}")
    set(_QWEN35_HDR "${CMAKE_CURRENT_BINARY_DIR}/omega_qwen35_chat_template.h")
    add_custom_command(
      OUTPUT "${_QWEN35_HDR}"
      COMMAND ${Python3_EXECUTABLE}
              "${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_c_string.py"
              "${_QWEN35_JINJA}"
              "${_QWEN35_HDR}"
      DEPENDS "${_QWEN35_JINJA}"
              "${CMAKE_CURRENT_SOURCE_DIR}/cmake/embed_c_string.py"
      COMMENT "Embedding Qwen3.5 chat template for qwen35 GGUF packs without tokenizer.chat_template"
    )
    target_sources(omega_infer PRIVATE "${_QWEN35_HDR}")
    target_include_directories(omega_infer PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
    target_compile_definitions(omega_infer PRIVATE OMEGA_HAVE_QWEN35_CHAT_TEMPLATE=1)
  endif()

  target_link_libraries(omega_infer PRIVATE llama llama-common)

  if(TARGET mtmd)
    target_sources(omega_infer PRIVATE src/omega_infer_vision.cpp)
    target_compile_definitions(omega_infer PRIVATE OMEGA_HAVE_MTMD=1)
    target_include_directories(omega_infer PRIVATE ${LLAMA_CPP_DIR}/tools/mtmd)
    target_link_libraries(omega_infer PRIVATE mtmd)
  endif()

  if(MSVC)
    target_compile_options(omega_infer PRIVATE /utf-8)
  endif()
else()
  message(WARNING "llama.cpp not found at ${LLAMA_CPP_DIR} — building stub libomega_infer (omega_infer_available=0)")
  target_compile_definitions(omega_infer PRIVATE OMEGA_HAVE_LLAMA_CPP=0)
endif()

set_target_properties(omega_infer PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/lib"
  LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/lib"
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/lib"
)

# Copy DLL next to lib for Windows dev
if(WIN32)
  add_custom_command(TARGET omega_infer POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      $<TARGET_FILE:omega_infer>
      "${CMAKE_CURRENT_SOURCE_DIR}/lib/"
  )
endif()

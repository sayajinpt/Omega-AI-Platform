cmake_minimum_required(VERSION 3.20)
project(omega_engine CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(OMEGA_INFER_DIR "${CMAKE_CURRENT_SOURCE_DIR}/native")
if(EXISTS "${OMEGA_INFER_DIR}/CMakeLists.txt")
  option(OMEGA_ENGINE_LINK_INFER "Link libomega_infer from apps/engine/native" ON)
else()
  option(OMEGA_ENGINE_LINK_INFER "Link libomega_infer from apps/engine/native" OFF)
endif()

include(FetchContent)
FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
)
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG v0.15.3
)
set(HTTPLIB_REQUIRE_OPENSSL OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nlohmann_json httplib)

set(OMEGA_ENGINE_SOURCES
  src/main.cpp
  src/dispatcher.cpp
  src/event_bus.cpp
  src/engine.cpp
  src/json_protocol.cpp
  src/model_registry.cpp
  src/inference_service.cpp
  src/inference_worker.cpp
  src/speculative_config.cpp
  src/infer_server_backend.cpp
  src/media_service.cpp
  src/runtime/thread_pool.cpp
  src/runtime/dispatch_metrics.cpp
)

add_executable(omega-engine ${OMEGA_ENGINE_SOURCES})

target_include_directories(omega-engine PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(MSVC)
  target_compile_options(omega-engine PRIVATE /utf-8 /W4)
else()
  target_compile_options(omega-engine PRIVATE -Wall -Wextra)
endif()

target_link_libraries(omega-engine PRIVATE nlohmann_json::nlohmann_json httplib::httplib)

if(WIN32)
  target_link_libraries(omega-engine PRIVATE ws2_32)
  target_sources(omega-engine PRIVATE src/win_shared_dll_paths.cpp)
endif()

if (OMEGA_ENGINE_LINK_INFER)
  if(EXISTS "${OMEGA_INFER_DIR}/CMakeLists.txt")
    add_subdirectory(${OMEGA_INFER_DIR} omega_infer_build EXCLUDE_FROM_ALL)
    target_link_libraries(omega-engine PRIVATE omega_infer)
    target_include_directories(omega-engine PRIVATE ${OMEGA_INFER_DIR}/include)
    target_compile_definitions(omega-engine PRIVATE OMEGA_ENGINE_HAVE_INFER=1)
    message(STATUS "omega-engine: linked libomega_infer")
    if(WIN32)
      add_custom_command(TARGET omega-engine POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
          $<TARGET_FILE:omega_infer>
          $<TARGET_FILE_DIR:omega-engine>
        COMMENT "Copy omega_infer.dll next to omega-engine.exe"
      )
    endif()
  else()
    message(WARNING "OMEGA_ENGINE_LINK_INFER=ON but ${OMEGA_INFER_DIR} not found")
  endif()
endif()

install(TARGETS omega-engine RUNTIME DESTINATION bin)

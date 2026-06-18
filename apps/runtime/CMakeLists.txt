cmake_minimum_required(VERSION 3.20)
project(omega_runtime C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG v0.15.3
)
FetchContent_Declare(
  sqlite_amalgamation
  URL https://www.sqlite.org/2024/sqlite-amalgamation-3460100.zip
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
set(HTTPLIB_REQUIRE_OPENSSL OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nlohmann_json httplib)

FetchContent_GetProperties(sqlite_amalgamation)
if(NOT sqlite_amalgamation_POPULATED)
  FetchContent_Populate(sqlite_amalgamation)
  add_library(sqlite3 STATIC "${sqlite_amalgamation_SOURCE_DIR}/sqlite3.c")
  set_target_properties(sqlite3 PROPERTIES LINKER_LANGUAGE C)
  target_compile_definitions(sqlite3 PUBLIC SQLITE_ENABLE_FTS5=1)
  target_include_directories(sqlite3 PUBLIC "${sqlite_amalgamation_SOURCE_DIR}")
  if(MSVC)
    target_compile_options(sqlite3 PRIVATE /wd4018 /wd4244 /wd4996)
  endif()
endif()

add_executable(omega-runtime
  src/main.cpp
  src/http_server.cpp
  src/runtime_context.cpp
  src/config_store.cpp
  src/route_catalog.cpp
  src/paths.cpp
  src/process_util.cpp
  src/engine_client.cpp
  src/shell_bridge.cpp
  src/native_routes.cpp
  src/session_cleanup.cpp
  src/storage/database.cpp
  src/storage/session_store.cpp
  src/storage/memory_store.cpp
  src/storage/rag_store.cpp
  src/storage/workflow_store.cpp
  src/profile_context.cpp
  src/storage/skills_store.cpp
  src/storage/profile_store.cpp
  src/storage/soul_store.cpp
  src/storage/cron_store.cpp
  src/storage/kanban_store.cpp
  src/storage/provider_store.cpp
  src/storage/input_pipeline_store.cpp
  src/storage/plugin_store.cpp
  src/storage/mcp_store.cpp
  src/storage/gateway_store.cpp
  src/storage/project_store.cpp
  src/storage/finetune_store.cpp
  src/storage/content_studio_settings.cpp
  src/storage/model_config_store.cpp
  src/finetune/finetune_runner.cpp
  src/finetune/finetune_capabilities.cpp
  src/finetune/finetune_dataset_service.cpp
  src/models/gguf_metadata.cpp
  src/models/model_meta_service.cpp
  src/models/model_presets.cpp
  src/models/hf_client.cpp
  src/models/model_load_progress.cpp
  src/models/model_download_service.cpp
  src/net/https_client_win.cpp
  src/net/https_client_httplib.cpp
  src/models/model_quantize_service.cpp
  src/models/gpu_probe.cpp
  src/tools/sandbox.cpp
  src/tools/plugin_runner.cpp
  src/tools/tool_approval.cpp
  src/tools/tool_registry.cpp
  src/tools/agent_desktop_tools.cpp
  src/tools/agent_platform_tools.cpp
  src/chat/stream_hub.cpp
  src/chat/chat_service.cpp
  src/chat/message_media.cpp
  src/chat/media_encode.cpp
  src/chat/attachment_extract.cpp
  src/chat/assistant_message_merge.cpp
  src/chat/chat_sanitize.cpp
  src/chat/model_gate.cpp
  src/inference/inference_router.cpp
  src/inference/model_load_payload.cpp
  src/inference/media_engine_router.cpp
  src/inference/media_executor.cpp
  src/media/ffmpeg_compose.cpp
  src/media/ffmpeg_text_overlay.cpp
  src/media/content_studio_native_media.cpp
  src/media/studio_media_runner.cpp
  src/inference/chat_usage.cpp
  src/inference/sse_stream.cpp
  src/inference/remote_chat.cpp
  src/inference/ollama_supervisor.cpp
  src/inference/sidecar_model_inventory.cpp
  src/inference/sidecar_supervisor.cpp
  src/chat/agent_service.cpp
  src/agent/parse_tool_calls.cpp
  src/orchestrator/parser.cpp
  src/orchestrator/prompts.cpp
  src/orchestrator/tool_catalog.cpp
  src/event_bus.cpp
  src/cron_scheduler.cpp
  src/services/mcp_omega_handler.cpp
  src/services/mcp_client_manager.cpp
  src/services/gateway_manager.cpp
  src/services/pipeline_activity.cpp
  src/services/debug_store.cpp
  src/services/content_job_delivery_service.cpp
  src/services/content_studio_orchestrator.cpp
  src/services/chat_tts_orchestrator.cpp
  src/services/content_studio_supervisor.cpp
  src/services/content_studio_native_status.cpp
  src/services/terminal_store.cpp
  src/services/editor_service.cpp
  src/services/self_improve_service.cpp
  src/services/chat_attachment_service.cpp
  src/services/assistant_prompt.cpp
  src/services/integrations_api.cpp
  src/services/workforce_store.cpp
  src/services/workforce_orchestrator.cpp
  src/services/media_player_service.cpp
  src/services/updater_service.cpp
  src/services/office_visualization_service.cpp
  src/services/sidecar_service.cpp
  src/services/system_info_service.cpp
  src/services/router_models_service.cpp
  src/services/desktop_aux_service.cpp
  src/storage/integrations_store.cpp
  src/storage/usage_store.cpp
  src/python/python_supervisor.cpp
  src/python/setup_progress.cpp
  src/python/venv_setup.cpp
  src/util/context_trim.cpp
  src/workflows/workflow_runner.cpp
)

target_include_directories(omega-runtime PUBLIC
  ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(MSVC)
  target_compile_options(omega-runtime PRIVATE /utf-8 /W4)
else()
  target_compile_options(omega-runtime PRIVATE -Wall -Wextra)
endif()

target_link_libraries(omega-runtime PRIVATE
  nlohmann_json::nlohmann_json
  httplib::httplib
  sqlite3
)

if(WIN32)
  target_link_libraries(omega-runtime PRIVATE ws2_32 ole32 winhttp comdlg32)
  set_source_files_properties(src/net/https_client_httplib.cpp PROPERTIES HEADER_FILE_ONLY TRUE)
else()
  set_source_files_properties(src/net/https_client_win.cpp PROPERTIES HEADER_FILE_ONLY TRUE)
  find_package(OpenSSL QUIET)
  if(OpenSSL_FOUND)
    target_link_libraries(omega-runtime PRIVATE OpenSSL::SSL OpenSSL::Crypto)
    target_compile_definitions(omega-runtime PRIVATE CPPHTTPLIB_OPENSSL_SUPPORT)
  endif()
endif()

add_custom_command(TARGET omega-runtime POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    ${CMAKE_CURRENT_SOURCE_DIR}/resources/route-catalog.json
    $<TARGET_FILE_DIR:omega-runtime>/route-catalog.json
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    ${CMAKE_CURRENT_SOURCE_DIR}/resources/tool-catalog.json
    $<TARGET_FILE_DIR:omega-runtime>/tool-catalog.json
  COMMAND ${CMAKE_COMMAND} -E copy_directory
    ${CMAKE_CURRENT_SOURCE_DIR}/resources/python-runtime
    $<TARGET_FILE_DIR:omega-runtime>/python-runtime
  COMMENT "Copy route-catalog.json, tool-catalog.json, python-runtime scripts next to omega-runtime"
)

install(TARGETS omega-runtime RUNTIME DESTINATION bin)
install(FILES resources/route-catalog.json DESTINATION bin)

#include "omega/runtime/services/system_info_service.hpp"

#include "omega/runtime/engine_client.hpp"
#include "omega/runtime/inference/media_executor.hpp"
#include "omega/runtime/inference/ollama_supervisor.hpp"
#include "omega/runtime/models/gpu_probe.hpp"
#include "omega/runtime/models/model_load_progress.hpp"
#include "omega/runtime/paths.hpp"
#include "omega/runtime/services/content_studio_supervisor.hpp"
#include "omega/runtime/services/gateway_manager.hpp"
#include "omega/runtime/services/mcp_client_manager.hpp"
#include "omega/runtime/services/office_visualization_service.hpp"
#include "omega/runtime/services/router_models_service.hpp"
#include "omega/runtime/services/sidecar_service.hpp"
#include "omega/runtime/services/updater_service.hpp"
#include "omega/runtime/storage/content_studio_settings.hpp"
#include "omega/runtime/python/python_supervisor.hpp"

#include <chrono>
#include <nlohmann/json.hpp>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

using json = nlohmann::json;

namespace omega::runtime {

namespace {

int64_t now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

bool compiled_has(const std::string& compiled, const char* id) {
  return compiled.find(id) != std::string::npos;
}

bool gpu_kind_present(const json& devices, const char* kind) {
  if (!devices.is_array()) return false;
  for (const auto& d : devices) {
    if (d.value("kind", "") == kind) return true;
  }
  return false;
}

json safe_call(const std::function<json()>& fn, json fallback = json::object()) {
  try {
    return fn ? fn() : fallback;
  } catch (...) {
    return fallback;
  }
}

}  // namespace

json host_system_info() {
#ifdef _WIN32
  SYSTEM_INFO si{};
  GetSystemInfo(&si);
  MEMORYSTATUSEX mem{};
  mem.dwLength = sizeof(mem);
  GlobalMemoryStatusEx(&mem);
  char hostname[256]{};
  DWORD sz = sizeof(hostname);
  GetComputerNameA(hostname, &sz);
  OSVERSIONINFOEXW osvi{};
  osvi.dwOSVersionInfoSize = sizeof(osvi);
  std::string os_label = "Windows";
#pragma warning(push)
#pragma warning(disable : 4996)
  if (GetVersionExW(reinterpret_cast<OSVERSIONINFOW*>(&osvi))) {
    os_label = "Windows " + std::to_string(osvi.dwMajorVersion) + "." +
               std::to_string(osvi.dwMinorVersion) + " build " +
               std::to_string(osvi.dwBuildNumber);
  }
#pragma warning(pop)
  return json{{"platform", "win32"},
              {"os", os_label},
              {"arch", si.wProcessorArchitecture == PROCESSOR_ARCHITECTURE_AMD64 ? "x64" : "other"},
              {"cpus", static_cast<int>(si.dwNumberOfProcessors)},
              {"totalMemoryMb", static_cast<int>(mem.ullTotalPhys / (1024 * 1024))},
              {"freeMemoryMb", static_cast<int>(mem.ullAvailPhys / (1024 * 1024))},
              {"hostname", hostname}};
#else
  return json{{"platform", "unix"}};
#endif
}

json build_inference_backends(const json& engine_health, const json& gpu_devices) {
  const std::string compiled = engine_health.value("compiled_backends", "cpu");
  const bool gpu_offload = engine_health.value("gpu_offload", false);
  const bool infer_ok = engine_health.value("infer_available", false);

  auto row = [&](const char* id, const char* label, bool compiled_in, bool available) {
    return json{{"id", id}, {"label", label}, {"compiled", compiled_in}, {"available", available}};
  };

  json backends = json::array();
  const bool cuda_compiled = compiled_has(compiled, "cuda");
  const bool vulkan_compiled = compiled_has(compiled, "vulkan");
  const bool metal_compiled = compiled_has(compiled, "metal");
  const bool hip_compiled = compiled_has(compiled, "hip");
  const bool sycl_compiled = compiled_has(compiled, "sycl");

  backends.push_back(row("cuda", "NVIDIA CUDA",
                         cuda_compiled,
                         infer_ok && gpu_offload && cuda_compiled && gpu_kind_present(gpu_devices, "cuda")));
  backends.push_back(row("vulkan", "Vulkan",
                         vulkan_compiled,
                         infer_ok && gpu_offload && vulkan_compiled));
  backends.push_back(row("metal", "Apple Metal",
                         metal_compiled,
                         infer_ok && gpu_offload && metal_compiled));
  backends.push_back(row("hip", "AMD ROCm/HIP", hip_compiled, infer_ok && gpu_offload && hip_compiled));
  backends.push_back(row("sycl", "Intel SYCL", sycl_compiled, infer_ok && gpu_offload && sycl_compiled));
  backends.push_back(row("cpu", "CPU", true, infer_ok));

  std::string primary = "cpu";
  if (infer_ok && gpu_offload) {
    if (cuda_compiled && gpu_kind_present(gpu_devices, "cuda")) primary = "cuda";
    else if (vulkan_compiled) primary = "vulkan";
    else if (metal_compiled) primary = "metal";
    else if (hip_compiled) primary = "hip";
    else if (sycl_compiled) primary = "sycl";
  }

  return json{{"primary", primary}, {"compiled", compiled}, {"gpuOffload", gpu_offload}, {"backends", backends}};
}

json gather_system_info(const SystemInfoInputs& inputs) {
  json engine_health = json::object();
  try {
    if (inputs.engine.available()) {
      engine_health = inputs.engine.command("health", json::object(), 5000);
    }
  } catch (...) {
  }

  const json gpu_devices = list_gpu_devices();
  const json inference = build_inference_backends(engine_health, gpu_devices);

  json media_caps = json::object();
  try {
    if (inputs.engine.available()) {
      MediaExecutor::refresh_capabilities(inputs.engine);
      media_caps = MediaExecutor::capabilities_json();
    }
  } catch (...) {
  }

  const json studio = ContentStudioSettings::generation_media_summary();
  const bool py_ready = studio.value("pythonReady", false);
  media_caps["contentStudioGeneration"] = studio;
  media_caps["vision"] = media_caps.value("vision", false);

  const json acc = studio.value("accelerators", json::object());
  auto cs_accel_label = [&acc](const char* key) -> std::string {
    if (!acc.is_object() || !acc.contains(key) || !acc[key].is_object()) return {};
    return acc[key].value("label", "");
  };
  auto cs_accel_id = [&acc](const char* key) -> std::string {
    if (!acc.is_object() || !acc.contains(key) || !acc[key].is_object()) return {};
    return acc[key].value("accelerator", "");
  };

  if (py_ready && studio.value("studioImageInstalled", false)) {
    media_caps["imageGenerate"] = true;
    const std::string accel = cs_accel_label("image");
    media_caps["imageBackend"] =
        accel.empty() ? "content-studio (diffusers)" : ("content-studio (" + accel + ")");
    if (!cs_accel_id("image").empty()) media_caps["imageAccelerator"] = cs_accel_id("image");
  } else if (media_caps.value("ollamaImageAvailable", false)) {
    media_caps["imageGenerate"] = true;
    if (media_caps.value("imageBackend", "unavailable") == "unavailable") {
      media_caps["imageBackend"] = "ollama";
    }
  }

  if (py_ready && studio.value("studioTtsInstalled", false)) {
    media_caps["ttsGenerate"] = true;
    const std::string accel = cs_accel_label("tts");
    media_caps["ttsBackend"] =
        accel.empty() ? "content-studio (python)" : ("content-studio (" + accel + ")");
    if (!cs_accel_id("tts").empty()) media_caps["ttsAccelerator"] = cs_accel_id("tts");
  } else if (media_caps.value("ttsGenerate", false)) {
    if (media_caps.value("ttsBackend", "unavailable") == "unavailable") {
      media_caps["ttsBackend"] = "llama.cpp";
    }
  }

  if (py_ready && studio.value("studioVideoInstalled", false)) {
    media_caps["videoGenerate"] = true;
    const std::string accel = cs_accel_label("video");
    media_caps["videoBackend"] =
        accel.empty() ? "content-studio (diffusers)" : ("content-studio (" + accel + ")");
    if (!cs_accel_id("video").empty()) media_caps["videoAccelerator"] = cs_accel_id("video");
  } else {
    media_caps["videoGenerate"] = false;
    media_caps["videoBackend"] = "unavailable";
  }

  return json{
      {"collectedAt", now_ms()},
      {"host", host_system_info()},
      {"omegaHome", omega_home()},
      {"runtime", safe_call(inputs.runtime_info)},
      {"runtimeStatus", safe_call(inputs.runtime_status)},
      {"app", inputs.updater.status()},
      {"inference", inference},
      {"gpuDevices", gpu_devices},
      {"omegaEngine",
       json{{"present", inputs.engine.available()},
            {"lastError", inputs.engine.last_error()},
            {"health", engine_health}}},
      {"ollama", OllamaSupervisor::instance().status()},
      {"python", inputs.python.status()},
      {"contentStudio", inputs.content_studio.status()},
      {"sidecar", inputs.sidecar.status()},
      {"mediaCapabilities", media_caps},
      {"modelLoadProgress", inputs.model_load_progress.snapshot()},
      {"mcp", inputs.mcp_clients.status_list()},
      {"gateway", inputs.gateway.list_statuses()},
      {"routerModels", inputs.router_models.status()},
      {"officeVisualization", inputs.office_viz.status()}};
}

}  // namespace omega::runtime

#include "omega/runtime/finetune/finetune_runner.hpp"

#include "omega/runtime/paths.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <signal.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace fs = std::filesystem;
using json = nlohmann::json;

namespace omega::runtime {

namespace {

std::mutex g_proc_mu;
#ifdef _WIN32
using ProcHandle = HANDLE;
constexpr ProcHandle kInvalidProc = nullptr;
#else
using ProcHandle = pid_t;
constexpr ProcHandle kInvalidProc = -1;
#endif
std::unordered_map<std::string, ProcHandle> g_active;

#ifdef _WIN32
ProcHandle spawn_training(const std::string& job_id, const std::string& py, const std::string& script,
                          const std::string& config_path) {
  std::string cmd = "\"" + py + "\" \"" + script + "\" \"" + config_path + "\"";
  STARTUPINFOA si{};
  si.cb = sizeof(si);
  si.dwFlags = STARTF_USESHOWWINDOW;
  si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi{};
  std::vector<char> cmd_buf(cmd.begin(), cmd.end());
  cmd_buf.push_back('\0');
  if (!CreateProcessA(nullptr, cmd_buf.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr,
                      nullptr, &si, &pi)) {
    throw std::runtime_error("failed to start finetune worker");
  }
  CloseHandle(pi.hThread);
  std::lock_guard lock(g_proc_mu);
  g_active[job_id] = pi.hProcess;
  return pi.hProcess;
}

int wait_training(ProcHandle proc) {
  WaitForSingleObject(proc, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(proc, &code);
  CloseHandle(proc);
  return static_cast<int>(code);
}

void kill_training(ProcHandle proc) {
  TerminateProcess(proc, 0);
  WaitForSingleObject(proc, 5000);
  CloseHandle(proc);
}
#else
ProcHandle spawn_training(const std::string& job_id, const std::string& py, const std::string& script,
                          const std::string& config_path) {
  const pid_t child = fork();
  if (child < 0) throw std::runtime_error("failed to fork finetune worker");
  if (child == 0) {
    setpgid(0, 0);
    execl(py.c_str(), py.c_str(), script.c_str(), config_path.c_str(), static_cast<char*>(nullptr));
    _exit(127);
  }
  std::lock_guard lock(g_proc_mu);
  g_active[job_id] = child;
  return child;
}

int wait_training(ProcHandle proc) {
  int status = 0;
  waitpid(proc, &status, 0);
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 1;
}

void kill_training(ProcHandle proc) {
  kill(-proc, SIGTERM);
  int status = 0;
  for (int i = 0; i < 30; ++i) {
    const pid_t r = waitpid(proc, &status, WNOHANG);
    if (r == proc || r == -1) return;
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  kill(-proc, SIGKILL);
  waitpid(proc, &status, 0);
}
#endif

void finish_job(FinetuneStore& store, EventBus& events, const std::string& job_id, int code) {
  const char* status = code == 0 ? "completed" : "failed";
  const char* message = code == 0 ? "Training finished" : "Training failed";
  try {
    store.update(job_id, json{{"status", status},
                              {"percent", code == 0 ? 100 : 0},
                              {"message", message}});
  } catch (...) {
  }
  events.publish("omega:finetune:progress",
                 json{{"jobId", job_id},
                      {"status", status},
                      {"percent", code == 0 ? 100 : 0},
                      {"message", message}});
}

}  // namespace

FinetuneRunner::FinetuneRunner(FinetuneStore& store) : store_(store) {}

std::string FinetuneRunner::script_path() const {
  const fs::path candidates[] = {
      fs::path("apps") / "desktop" / "scripts" / "finetune_train.py",
      fs::path("..") / "apps" / "desktop" / "scripts" / "finetune_train.py",
      fs::path("resources") / "scripts" / "finetune_train.py",
      fs::path(runtime_executable_dir()) / ".." / "resources" / "scripts" / "finetune_train.py"};
  for (const auto& c : candidates) {
    std::error_code ec;
    const fs::path abs = fs::absolute(c, ec);
    if (!ec && fs::exists(abs)) return abs.string();
  }
  return (fs::path("apps") / "desktop" / "scripts" / "finetune_train.py").string();
}

json FinetuneRunner::start(const std::string& job_id, EventBus& events) {
  const auto job_opt = store_.get(job_id);
  if (!job_opt) throw std::runtime_error("job not found: " + job_id);
  json job = *job_opt;
  if (!job.contains("dataset") || !job["dataset"].is_object() ||
      !job["dataset"].contains("trainPath") ||
      job["dataset"]["trainPath"].get<std::string>().empty()) {
    throw std::runtime_error("Dataset not prepared — set sources and prepare first");
  }

  const std::string py = resolve_unified_python();
  if (!fs::exists(py)) {
    throw std::runtime_error("unified python venv missing — run POST /v1/python/setup first");
  }
  const std::string script = script_path();
  if (!fs::exists(script)) throw std::runtime_error("finetune_train.py not found");

  const std::string output_dir =
      (fs::path(omega_home()) / "finetune" / "runs" / job_id).string();
  fs::create_directories(output_dir);

  const fs::path config_path = fs::path(output_dir) / "job-config.json";
  {
    std::ofstream out(config_path);
    out << json{{"jobId", job_id},
                {"modelId", job.value("modelId", "")},
                {"modality", job.value("modality", "text")},
                {"hyperparams", job.value("hyperparams", json::object())},
                {"dataset", job["dataset"]},
                {"outputDir", output_dir}}
               .dump(2);
  }

  job = store_.update(job_id, json{{"outputDir", output_dir},
                                   {"status", "running"},
                                   {"percent", 5},
                                   {"message", "Starting training worker…"},
                                   {"startedAt", std::chrono::duration_cast<std::chrono::milliseconds>(
                                                       std::chrono::system_clock::now().time_since_epoch())
                                                       .count()}});

  events.publish("omega:finetune:progress",
                 json{{"jobId", job_id},
                      {"status", "running"},
                      {"percent", 5},
                      {"message", "Starting training worker…"}});

  const ProcHandle proc =
      spawn_training(job_id, py, script, config_path.string());

  std::thread([this, proc, job_id, &events]() {
    const int code = wait_training(proc);
    {
      std::lock_guard lock(g_proc_mu);
      const auto it = g_active.find(job_id);
      if (it != g_active.end() && it->second == proc) g_active.erase(it);
    }
    finish_job(store_, events, job_id, code);
  }).detach();

  return job;
}

void FinetuneRunner::abort(const std::string& job_id) {
  ProcHandle proc = kInvalidProc;
  {
    std::lock_guard lock(g_proc_mu);
    const auto it = g_active.find(job_id);
    if (it != g_active.end()) {
      proc = it->second;
      g_active.erase(it);
    }
  }
  if (proc != kInvalidProc) kill_training(proc);

  try {
    store_.update(job_id, json{{"status", "cancelled"}, {"message", "Cancelled by user"}});
  } catch (...) {
  }
}

}  // namespace omega::runtime

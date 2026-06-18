#include "omega/runtime/services/content_studio_native_status.hpp"

#include "omega/runtime/paths.hpp"

#include <sqlite3.h>

#include <cctype>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <thread>

#ifndef _WIN32
#include <signal.h>
#endif

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <Windows.h>
#endif

namespace fs = std::filesystem;
namespace omega::runtime {

namespace {

using json = nlohmann::json;

fs::path content_studio_db_path() {
  return fs::path(resolve_content_studio_data_dir()) / "media_auto.db";
}

fs::path workers_dir() {
  return fs::path(resolve_content_studio_storage()).parent_path() / "workers";
}

bool pid_alive(int pid) {
  if (pid <= 0) return false;
#ifdef _WIN32
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(pid));
  if (!h) return false;
  DWORD code = 0;
  const BOOL ok = GetExitCodeProcess(h, &code);
  CloseHandle(h);
  return ok && code == STILL_ACTIVE;
#else
  return kill(pid, 0) == 0;
#endif
}

void prune_stale_worker_pid_files() {
  std::error_code ec;
  const fs::path dir = workers_dir();
  if (!fs::exists(dir, ec)) return;
  for (const auto& ent : fs::directory_iterator(dir, ec)) {
    if (ec || !ent.is_regular_file(ec)) continue;
    if (ent.path().extension() != ".pid") continue;
    try {
      std::ifstream in(ent.path());
      int pid = 0;
      in >> pid;
      if (!pid_alive(pid)) fs::remove(ent.path(), ec);
    } catch (...) {
      fs::remove(ent.path(), ec);
    }
  }
}

bool worker_running_for_job(const std::string& job_id) {
  prune_stale_worker_pid_files();
  const fs::path pid_path = workers_dir() / (job_id + ".pid");
  if (!fs::exists(pid_path)) return false;
  try {
    std::ifstream in(pid_path);
    int pid = 0;
    in >> pid;
    if (!pid_alive(pid)) {
      std::error_code ec;
      fs::remove(pid_path, ec);
      return false;
    }
    return true;
  } catch (...) {
    return false;
  }
}

bool any_live_worker_pid_files() {
  prune_stale_worker_pid_files();
  std::error_code ec;
  const fs::path dir = workers_dir();
  if (!fs::exists(dir, ec)) return false;
  for (const auto& ent : fs::directory_iterator(dir, ec)) {
    if (ec || !ent.is_regular_file(ec)) continue;
    if (ent.path().extension() != ".pid") continue;
    try {
      std::ifstream in(ent.path());
      int pid = 0;
      in >> pid;
      if (pid_alive(pid)) return true;
      fs::remove(ent.path(), ec);
    } catch (...) {
      fs::remove(ent.path(), ec);
    }
  }
  return false;
}

std::optional<std::string> mp4_relative(const std::string& project_id, const std::string& job_id) {
  if (project_id.empty() || job_id.empty()) return std::nullopt;
  const fs::path path =
      fs::path(resolve_content_studio_storage()) / project_id / job_id / "final.mp4";
  std::error_code ec;
  if (!fs::exists(path, ec) || !fs::is_regular_file(path, ec)) return std::nullopt;
  if (fs::file_size(path, ec) < 512) return std::nullopt;
  return project_id + "/" + job_id + "/final.mp4";
}

struct JobRow {
  std::string id;
  std::string project_id;
  std::string status;
};

std::optional<JobRow> read_job_row(const std::string& job_id) {
  const fs::path db_path = content_studio_db_path();
  if (!fs::exists(db_path)) return std::nullopt;
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(db_path.string().c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) {
    if (db) sqlite3_close(db);
    return std::nullopt;
  }
  sqlite3_busy_timeout(db, 3000);

  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "SELECT id, project_id, status FROM job_queue WHERE id = ? LIMIT 1";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    sqlite3_close(db);
    return std::nullopt;
  }
  sqlite3_bind_text(stmt, 1, job_id.c_str(), -1, SQLITE_TRANSIENT);

  std::optional<JobRow> row;
  if (sqlite3_step(stmt) == SQLITE_ROW) {
    JobRow r;
    r.id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    r.project_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
    r.status = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
    row = std::move(r);
  }
  sqlite3_finalize(stmt);
  sqlite3_close(db);
  return row;
}

int count_active_jobs_in_db() {
  const fs::path db_path = content_studio_db_path();
  if (!fs::exists(db_path)) return 0;
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(db_path.string().c_str(), &db, SQLITE_OPEN_READONLY, nullptr) != SQLITE_OK) {
    if (db) sqlite3_close(db);
    return 0;
  }
  sqlite3_busy_timeout(db, 3000);
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db,
                       "SELECT COUNT(*) FROM job_queue WHERE status IN ('queued','running')", -1,
                       &stmt, nullptr) != SQLITE_OK) {
    sqlite3_close(db);
    return 0;
  }
  int count = 0;
  if (sqlite3_step(stmt) == SQLITE_ROW) count = sqlite3_column_int(stmt, 0);
  sqlite3_finalize(stmt);
  sqlite3_close(db);
  return count;
}

}  // namespace

std::optional<json> get_content_studio_run_status_native(const std::string& job_id) {
  if (job_id.empty()) return std::nullopt;
  const auto row = read_job_row(job_id);
  if (!row) return std::nullopt;

  const bool worker_running = worker_running_for_job(job_id);
  std::string status = row->status;
  for (auto& c : status) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

  std::optional<std::string> mp4;
  if (status == "succeeded" && !worker_running) {
    mp4 = mp4_relative(row->project_id, job_id);
  }
  if (status == "succeeded" && worker_running) {
    mp4.reset();
  }
  if (status == "succeeded" && !worker_running && !mp4) {
    status = "failed";
  }

  json out{{"job_id", row->id},
           {"project_id", row->project_id},
           {"status", status},
           {"worker_running", worker_running},
           {"video_ready", mp4.has_value()},
           {"logs", json::array()}};
  if (mp4) out["mp4_path"] = *mp4;
  return out;
}

bool is_content_studio_pipeline_idle_native() {
  if (count_active_jobs_in_db() > 0) return false;
  return !any_live_worker_pid_files();
}

bool wait_for_job_worker_exit(const std::string& job_id, int timeout_ms) {
  if (job_id.empty()) return is_content_studio_pipeline_idle_native();
  const int step_ms = 200;
  int elapsed = 0;
  while (elapsed < timeout_ms) {
    prune_stale_worker_pid_files();
    if (!worker_running_for_job(job_id)) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(step_ms));
    elapsed += step_ms;
  }
  prune_stale_worker_pid_files();
  return !worker_running_for_job(job_id);
}

}  // namespace omega::runtime

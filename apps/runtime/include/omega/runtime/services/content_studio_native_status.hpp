#pragma once

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

/** Read CS job status from media_auto.db + worker pid files — no Python subprocess. */
std::optional<nlohmann::json> get_content_studio_run_status_native(const std::string& job_id);

/** True when no queued/running jobs and no live worker pid files remain. */
bool is_content_studio_pipeline_idle_native();

/** Wait until a job's pipeline worker process has exited (pid file gone or stale). */
bool wait_for_job_worker_exit(const std::string& job_id, int timeout_ms = 120000);

}  // namespace omega::runtime

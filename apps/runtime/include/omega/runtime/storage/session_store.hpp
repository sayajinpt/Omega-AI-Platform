#pragma once

#include "omega/runtime/storage/database.hpp"

#include <nlohmann/json.hpp>
#include <functional>
#include <mutex>
#include <optional>
#include <string>

namespace omega::runtime {

class SessionStore {
 public:
  explicit SessionStore(Database& db);

  nlohmann::json list_sessions();
  nlohmann::json create_session(const std::string& title, const std::string& model_id,
                                const std::string& system_prompt);
  void delete_session(const std::string& id);
  void update_title(const std::string& id, const std::string& title);
  void update_model_id(const std::string& id, const std::string& model_id);
  nlohmann::json get_messages(const std::string& session_id);
  nlohmann::json search(const std::string& query, int limit = 40);
  nlohmann::json fork_session(const std::string& source_id);
  void truncate_messages(const std::string& session_id, int from_index);
  void append_message(const std::string& session_id, const std::string& role,
                      const std::string& content, const nlohmann::json& extras = nullptr);

  struct AssistantPatch {
    std::string content;
    nlohmann::json parts;
    int message_index{-1};
  };

  /** Update the assistant row that already contains a Content Studio card for `job_id`. */
  std::optional<AssistantPatch> patch_assistant_message_with_job(
      const std::string& session_id, const std::string& job_id,
      const std::function<void(nlohmann::json& parts, std::string& content)>& mutator);

  /** Update the most recent assistant row (e.g. attach a new job card after GPU submit). */
  std::optional<AssistantPatch> patch_latest_assistant_message(
      const std::string& session_id,
      const std::function<void(nlohmann::json& parts, std::string& content)>& mutator);

  /** Remove Content Studio card parts from every assistant message in the session. */
  void strip_content_studio_parts(const std::string& session_id);

 private:
  [[nodiscard]] std::lock_guard<std::recursive_mutex> db_lock() const {
    return std::lock_guard<std::recursive_mutex>(db_.mutex());
  }
  void index_session_fts(const std::string& session_id, const std::string& title,
                         const std::string& body);
  std::string escape_fts_query(const std::string& query) const;
  int64_t now_ms() const;

  Database& db_;
};

}  // namespace omega::runtime

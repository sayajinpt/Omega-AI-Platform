#pragma once

#include "omega/runtime/storage/project_store.hpp"

#include <nlohmann/json.hpp>
#include <optional>
#include <string>

namespace omega::runtime {

class MediaPlayerService;
class SessionStore;

/** Strip optional ``media/`` prefix; refs are filenames under the session ``media/`` folder. */
std::string normalize_session_media_ref(const std::string& ref);

/** Reject path traversal and nested paths after normalization. */
bool is_session_media_ref_safe(const std::string& ref);

/** Resolve staged media ref to an on-disk path under the session project folder. */
std::string resolve_session_media_path(const std::string& session_id, const std::string& ref,
                                       ProjectStore& projects);

/** Find a playable video part in session messages (optional Content Studio job filter). */
std::optional<nlohmann::json> find_session_video_part(SessionStore& sessions,
                                                      ProjectStore& projects,
                                                      const std::string& session_id,
                                                      const std::string& job_id = "");

/** Locate session video and open the in-chat media review panel. */
nlohmann::json reopen_session_video(SessionStore& sessions, ProjectStore& projects,
                                    MediaPlayerService& media, const nlohmann::json& body);

/**
 * Hydrate messages for inference: imagePaths for vision, inline text for code/docs,
 * attachment manifest in content. Merges top-level req.attachments into the last user turn.
 */
nlohmann::json prepare_chat_messages_for_inference(const nlohmann::json& messages,
                                                 const std::string& session_id,
                                                 ProjectStore& projects,
                                                 const nlohmann::json& top_attachments,
                                                 const nlohmann::json& config = {});

/** Summary for PROMPT_1 / PROMPT_2 (orchestrator) describing non-text attachments. */
std::string format_attachment_context_for_prompt(const nlohmann::json& messages,
                                               const std::string& session_id,
                                               ProjectStore& projects);

/** Extras blob for SessionStore::append_message on the user turn. */
nlohmann::json user_message_persist_extras(const nlohmann::json& user_message);

}  // namespace omega::runtime

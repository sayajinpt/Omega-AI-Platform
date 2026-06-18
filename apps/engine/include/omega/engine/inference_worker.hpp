#pragma once

#include <atomic>
#include <condition_variable>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <thread>

#include "omega/engine/command.hpp"
#include "omega/engine/inference_service.hpp"

namespace omega::engine {

class EventBus;
class ModelRegistry;

struct GenerateWork {
  Command cmd;
  std::string model_id;
  std::string prompt;
  SamplingOptions sampling;
};

struct EmbedWork {
  Command cmd;
  std::string model_id;
  std::string text;
};

struct SendWork {
  Command cmd;
  std::string model_id;
  std::vector<ChatMessage> messages;
  SamplingOptions sampling;
  bool enable_thinking = false;
  bool use_simple_prompt = false;
  LoadOptions load_options;
};

struct LoadWork {
  Command cmd;
  std::string model_id;
  std::string path;
  LoadOptions options;
};

struct UnloadWork {
  Command cmd;
  std::string model_id;
  bool unload_all = false;
};

/** Dedicated inference thread: load, generate, embed, chat.send — Phase 6. */
class InferenceWorker {
 public:
  using WriteLineFn = std::function<void(const std::string&)>;

  InferenceWorker(InferenceService& infer, ModelRegistry& registry, EventBus& events,
                  WriteLineFn write_line);
  ~InferenceWorker();

  InferenceWorker(const InferenceWorker&) = delete;
  InferenceWorker& operator=(const InferenceWorker&) = delete;

  void start();
  void stop();
  void enqueue_generate(GenerateWork work);
  void enqueue_embed(EmbedWork work);
  void enqueue_send(SendWork work);
  void enqueue_load(LoadWork work);
  void enqueue_unload(UnloadWork work);
  void abort(const std::string& cmd_id);

  std::size_t queue_depth() const;
  bool is_busy() const;

 private:
  struct Job {
    enum class Kind { Load, Unload, Generate, Embed, Send } kind;
    LoadWork load;
    UnloadWork unload;
    GenerateWork generate;
    EmbedWork embed;
    SendWork send;
  };

  InferenceService& infer_;
  ModelRegistry& registry_;
  EventBus& events_;
  WriteLineFn write_line_;

  std::thread thread_;
  mutable std::mutex queue_mutex_;
  std::condition_variable queue_cv_;
  std::queue<Job> queue_;
  std::atomic<bool> stop_{false};

  std::mutex active_mutex_;
  std::string active_cmd_id_;
  std::atomic<bool> cancel_flag_{false};
  std::atomic<bool> busy_{false};

  void run();
  void process_load(const LoadWork& work);
  void process_unload(const UnloadWork& work);
  void process_generate(const GenerateWork& work);
  void process_embed(const EmbedWork& work);
  void process_send(const SendWork& work);
  void emit_chunk(const std::string& session_id, const std::string& text, int index,
                  const GenerationStats* stats = nullptr, const char* phase = nullptr);
  void emit_load_progress(const std::string& model_id, int percent, const std::string& message);
  void write_response(const CommandResponse& resp);
};

}  // namespace omega::engine

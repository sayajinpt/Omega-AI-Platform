#pragma once

#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace omega::engine {

class ThreadPool;

struct ModelMetadata {
  std::string architecture;
  std::string quantization;
  int context_len = 0;
  int64_t param_count = 0;
};

struct ModelRecord {
  std::string id;
  std::string path;
  int64_t size_bytes = 0;
  ModelMetadata metadata;
};

/** File-backed GGUF index rooted at a models directory. */
class ModelRegistry {
 public:
  explicit ModelRegistry(std::string dir);

  const std::string& dir() const { return dir_; }

  void rescan();
  /** Refresh cache on the service pool without blocking IPC. */
  void schedule_rescan(class ThreadPool& pool);
  std::vector<ModelRecord> list() const;
  bool get(const std::string& id, ModelRecord& out) const;
  bool remove(const std::string& id, std::string& error);

  static bool is_auxiliary_gguf(const std::string& filename);

 private:
  std::string dir_;
  mutable std::mutex mutex_;
  std::map<std::string, ModelRecord> cache_;

  static ModelRecord build_record(const std::string& path, const std::string& pack_id);
};

}  // namespace omega::engine

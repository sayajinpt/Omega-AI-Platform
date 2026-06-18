#include "omega/runtime/models/gguf_metadata.hpp"

#include <cstdint>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>

namespace omega::runtime {

namespace {

constexpr uint32_t kGgufMagic = 0x46554747;  // "GGUF"

enum GgufType : uint32_t {
  Uint8 = 0,
  Int8 = 1,
  Uint16 = 2,
  Int16 = 3,
  Uint32 = 4,
  Int32 = 5,
  Float32 = 6,
  Bool = 7,
  String = 8,
  Array = 9,
  Uint64 = 10,
  Int64 = 11,
  Float64 = 12
};

class GgufReader {
 public:
  explicit GgufReader(std::ifstream& in) : in_(in) {}

  uint32_t read_u32() {
    uint32_t v = 0;
    read_bytes(&v, 4);
    return v;
  }

  uint64_t read_u64() {
    uint64_t v = 0;
    read_bytes(&v, 8);
    return v;
  }

  std::string read_string() {
    const uint64_t n = read_u64();
    if (n > 1 << 20) throw std::runtime_error("gguf: string too large");
    if (n == 0) return {};
    std::string out(static_cast<size_t>(n), '\0');
    read_bytes(out.data(), static_cast<size_t>(n));
    return out;
  }

  void skip_typed(uint32_t type) {
    switch (type) {
      case Uint8:
      case Int8:
      case Bool:
        skip_bytes(1);
        return;
      case Uint16:
      case Int16:
        skip_bytes(2);
        return;
      case Uint32:
      case Int32:
      case Float32:
        skip_bytes(4);
        return;
      case Uint64:
      case Int64:
      case Float64:
        skip_bytes(8);
        return;
      case String: {
        const uint64_t n = read_u64();
        skip_bytes(static_cast<size_t>(n));
        return;
      }
      case Array: {
        const uint32_t elem = read_u32();
        const uint64_t count = read_u64();
        for (uint64_t i = 0; i < count; ++i) skip_typed(elem);
        return;
      }
      default:
        throw std::runtime_error("gguf: unknown type");
    }
  }

  std::string read_scalar_string(uint32_t type) {
    if (type == String) return read_string();
    skip_typed(type);
    return {};
  }

  double read_scalar_number(uint32_t type) {
    switch (type) {
      case Uint8: {
        uint8_t v = 0;
        read_bytes(&v, 1);
        return v;
      }
      case Int8: {
        int8_t v = 0;
        read_bytes(&v, 1);
        return v;
      }
      case Uint16: {
        uint16_t v = 0;
        read_bytes(&v, 2);
        return v;
      }
      case Int16: {
        int16_t v = 0;
        read_bytes(&v, 2);
        return v;
      }
      case Uint32:
        return read_u32();
      case Int32: {
        int32_t v = 0;
        read_bytes(&v, 4);
        return v;
      }
      case Float32: {
        float v = 0;
        read_bytes(&v, 4);
        return v;
      }
      case Uint64:
        return static_cast<double>(read_u64());
      case Int64: {
        int64_t v = 0;
        read_bytes(&v, 8);
        return static_cast<double>(v);
      }
      case Float64: {
        double v = 0;
        read_bytes(&v, 8);
        return v;
      }
      default:
        skip_typed(type);
        return 0;
    }
  }

 private:
  std::ifstream& in_;

  void read_bytes(void* dst, size_t n) {
    in_.read(static_cast<char*>(dst), static_cast<std::streamsize>(n));
    if (!in_) throw std::runtime_error("gguf: unexpected EOF");
  }

  void skip_bytes(size_t n) {
    in_.seekg(static_cast<std::streamoff>(n), std::ios::cur);
    if (!in_) throw std::runtime_error("gguf: skip failed");
  }
};

std::string infer_arch_from_key(const std::string& key) {
  const auto dot = key.find('.');
  if (dot == std::string::npos || dot + 1 >= key.size()) return {};
  return key.substr(0, dot);
}

void apply_key(SafeGgufMetadata& meta, const std::string& key, uint32_t type, GgufReader& r) {
  if (key == "general.architecture") {
    meta.architecture = r.read_scalar_string(type);
    return;
  }
  if (key == "general.quantization_version" || key == "general.file_type") {
    meta.quantization = std::to_string(static_cast<int>(r.read_scalar_number(type)));
    return;
  }
  if (key == "general.parameter_count") {
    meta.parameter_count = r.read_scalar_number(type);
    return;
  }
  if (key.rfind("tokenizer.", 0) == 0) {
    meta.skipped_large_tokenizer = true;
    r.skip_typed(type);
    return;
  }
  if (!meta.architecture.empty()) {
    const std::string arch = meta.architecture;
    if (key == arch + ".block_count") meta.total_layers = static_cast<int>(r.read_scalar_number(type));
    else if (key == arch + ".context_length") meta.context_length_max = static_cast<int>(r.read_scalar_number(type));
    else if (key == arch + ".embedding_length") meta.embedding_length = static_cast<int>(r.read_scalar_number(type));
    else r.skip_typed(type);
    return;
  }
  const std::string arch = infer_arch_from_key(key);
  if (!arch.empty() && meta.architecture.empty()) meta.architecture = arch;
  if (!arch.empty()) {
    if (key == arch + ".block_count") meta.total_layers = static_cast<int>(r.read_scalar_number(type));
    else if (key == arch + ".context_length") meta.context_length_max = static_cast<int>(r.read_scalar_number(type));
    else if (key == arch + ".embedding_length") meta.embedding_length = static_cast<int>(r.read_scalar_number(type));
    else r.skip_typed(type);
    return;
  }
  r.skip_typed(type);
}

}  // namespace

std::optional<SafeGgufMetadata> read_safe_gguf_metadata(const std::string& path) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return std::nullopt;
  GgufReader r(in);
  if (r.read_u32() != kGgufMagic) return std::nullopt;
  (void)r.read_u32();  // version
  const uint64_t tensor_count = r.read_u64();
  const uint64_t kv_count = r.read_u64();
  (void)tensor_count;

  SafeGgufMetadata meta;
  for (uint64_t i = 0; i < kv_count; ++i) {
    const std::string key = r.read_string();
    const uint32_t type = r.read_u32();
    apply_key(meta, key, type, r);
  }
  return meta;
}

}  // namespace omega::runtime

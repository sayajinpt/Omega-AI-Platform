#pragma once

#include <nlohmann/json.hpp>
#include <string>

namespace omega::runtime {

class EditorService {
 public:
  static std::string read_file(const std::string& path);
  static void write_file(const std::string& path, const std::string& content);
  static void delete_file(const std::string& path);
  static nlohmann::json open_files(const nlohmann::json& body);
  static nlohmann::json save_as(const nlohmann::json& body);
  static std::string language_from_path(const std::string& path);
  static std::string title_from_path(const std::string& path);
};

}  // namespace omega::runtime

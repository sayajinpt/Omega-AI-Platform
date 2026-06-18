#include "omega/runtime/models/gpu_probe.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <cstdio>
#include <sstream>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace omega::runtime {

namespace {

#ifdef _WIN32
std::string pipe_output(const std::string& cmd) {
  std::string out;
  FILE* pipe = _popen(cmd.c_str(), "r");
  if (!pipe) return out;
  char buf[512];
  while (fgets(buf, sizeof(buf), pipe)) out += buf;
  _pclose(pipe);
  return out;
}

int parse_memory_mb(const std::string& raw) {
  std::string s = raw;
  while (!s.empty() && (s.back() == ' ' || s.back() == '\r' || s.back() == '\n')) s.pop_back();
  try {
    return std::stoi(s);
  } catch (...) {
    return 0;
  }
}
#endif

json cpu_device() {
#ifdef _WIN32
  SYSTEM_INFO si{};
  GetSystemInfo(&si);
  (void)si;
  MEMORYSTATUSEX mem{};
  mem.dwLength = sizeof(mem);
  GlobalMemoryStatusEx(&mem);
  return json{{"kind", "cpu"},
              {"index", 0},
              {"name", "CPU"},
              {"memory_mb", static_cast<int>(mem.ullTotalPhys / (1024 * 1024))}};
#else
  return json{{"kind", "cpu"}, {"index", 0}, {"name", "CPU"}, {"memory_mb", 0}};
#endif
}

}  // namespace

json list_gpu_devices() {
  json devices = json::array();
#ifdef _WIN32
  const std::string out = pipe_output(
      "nvidia-smi --query-gpu=index,name,memory.total,driver_version --format=csv,noheader,nounits");
  std::istringstream in(out);
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    std::vector<std::string> fields;
    std::string cell;
    std::istringstream lline(line);
    while (std::getline(lline, cell, ',')) {
      while (!cell.empty() && cell.front() == ' ') cell.erase(cell.begin());
      while (!cell.empty() && cell.back() == ' ') cell.pop_back();
      fields.push_back(cell);
    }
    if (fields.size() < 3) continue;
    try {
      json row{{"kind", "cuda"},
               {"index", std::stoi(fields[0])},
               {"name", fields[1]},
               {"memory_mb", parse_memory_mb(fields[2])}};
      if (fields.size() >= 4 && !fields[3].empty()) row["driver_version"] = fields[3];
      devices.push_back(std::move(row));
    } catch (...) {
      continue;
    }
  }
#endif
  devices.push_back(cpu_device());
  return devices;
}

}  // namespace omega::runtime

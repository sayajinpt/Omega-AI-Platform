#pragma once

#include <random>
#include <string>

namespace omega::runtime {

inline std::string random_uuid() {
  static std::mt19937 rng{std::random_device{}()};
  static const char* hex = "0123456789abcdef";
  std::string out;
  out.reserve(36);
  for (int i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      out.push_back('-');
      continue;
    }
    out.push_back(hex[rng() % 16]);
  }
  return out;
}

}  // namespace omega::runtime

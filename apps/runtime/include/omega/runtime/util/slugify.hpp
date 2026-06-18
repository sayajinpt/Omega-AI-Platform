#pragma once

#include <algorithm>
#include <cctype>
#include <string>

namespace omega::runtime {

inline std::string slugify(std::string s, size_t max_len = 60) {
  for (char& c : s) {
    if (!std::isalnum(static_cast<unsigned char>(c))) c = '-';
    else c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }
  while (!s.empty() && s.front() == '-') s.erase(s.begin());
  while (!s.empty() && s.back() == '-') s.pop_back();
  if (s.size() > max_len) s.resize(max_len);
  while (!s.empty() && s.back() == '-') s.pop_back();
  return s;
}

}  // namespace omega::runtime

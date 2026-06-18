#pragma once

#include <nlohmann/json.hpp>
#include <optional>

namespace omega::shell {

struct ShellContext;

/** Full-screen snip overlay + GDI region capture (Electron screen-snip parity). */
class ScreenSnipService {
 public:
  explicit ScreenSnipService(ShellContext& ctx);
  ~ScreenSnipService();

  nlohmann::json capture();
  nlohmann::json get_bounds() const;
  nlohmann::json submit(const nlohmann::json& rect);
  nlohmann::json cancel();
  nlohmann::json save(const nlohmann::json& body);

 private:
  ShellContext& ctx_;
};

}  // namespace omega::shell

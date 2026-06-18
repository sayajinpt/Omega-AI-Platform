#include "omega/shell/screen_snip_service.hpp"

#include "omega/shell/embedded_browser.hpp"
#include "omega/shell/platform_window.hpp"
#include "omega/shell/shell_context.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <objidl.h>
#include <gdiplus.h>

#include "omega/shell/overlay_window.hpp"
#include <shlobj.h>

#include <array>
#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
namespace omega::shell {

using json = nlohmann::json;

namespace {

struct DesktopBounds {
  int x{0};
  int y{0};
  int width{1920};
  int height{1080};
};

struct CaptureState {
  std::mutex mu;
  std::condition_variable cv;
  bool active{false};
  bool done{false};
  json result{nullptr};
  DesktopBounds bounds{};
};

CaptureState g_capture;

ULONG_PTR gdiplus_token{0};

void ensure_gdiplus() {
  if (gdiplus_token) return;
  Gdiplus::GdiplusStartupInput input;
  Gdiplus::GdiplusStartup(&gdiplus_token, &input, nullptr);
}

BOOL CALLBACK monitor_enum(HMONITOR, HDC, LPRECT rc, LPARAM lp) {
  auto* a = reinterpret_cast<DesktopBounds*>(lp);
  if (a->width == 1920 && a->height == 1080 && a->x == 0 && a->y == 0) {
    a->x = static_cast<int>(rc->left);
    a->y = static_cast<int>(rc->top);
    a->width = static_cast<int>(rc->right - rc->left);
    a->height = static_cast<int>(rc->bottom - rc->top);
    return TRUE;
  }
  const int left = std::min(a->x, static_cast<int>(rc->left));
  const int top = std::min(a->y, static_cast<int>(rc->top));
  const int right = std::max(a->x + a->width, static_cast<int>(rc->right));
  const int bottom = std::max(a->y + a->height, static_cast<int>(rc->bottom));
  a->x = left;
  a->y = top;
  a->width = right - left;
  a->height = bottom - top;
  return TRUE;
}

DesktopBounds virtual_desktop_bounds() {
  DesktopBounds b{0, 0, 1920, 1080};
  EnumDisplayMonitors(nullptr, nullptr, monitor_enum, reinterpret_cast<LPARAM>(&b));
  return b;
}

json bounds_json(const DesktopBounds& b) {
  return json{{"x", b.x}, {"y", b.y}, {"width", b.width}, {"height", b.height}};
}

std::string base64_encode(const std::vector<uint8_t>& data) {
  static const char* kAlphabet =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((data.size() + 2) / 3) * 4);
  for (size_t i = 0; i < data.size(); i += 3) {
    const uint32_t n = (static_cast<uint32_t>(data[i]) << 16) |
                       ((i + 1 < data.size() ? data[i + 1] : 0) << 8) |
                       (i + 2 < data.size() ? data[i + 2] : 0);
    out.push_back(kAlphabet[(n >> 18) & 63]);
    out.push_back(kAlphabet[(n >> 12) & 63]);
    out.push_back(i + 1 < data.size() ? kAlphabet[(n >> 6) & 63] : '=');
    out.push_back(i + 2 < data.size() ? kAlphabet[n & 63] : '=');
  }
  return out;
}

int clamp_dim(int v) { return std::max(1, v); }

json capture_rect(const json& rect) {
  ensure_gdiplus();
  const int x = rect.value("x", 0);
  const int y = rect.value("y", 0);
  const int w = clamp_dim(static_cast<int>(rect.value("width", 1)));
  const int h = clamp_dim(static_cast<int>(rect.value("height", 1)));

  HDC screen_dc = GetDC(nullptr);
  HDC mem_dc = CreateCompatibleDC(screen_dc);
  HBITMAP bmp = CreateCompatibleBitmap(screen_dc, w, h);
  HGDIOBJ old = SelectObject(mem_dc, bmp);
  BitBlt(mem_dc, 0, 0, w, h, screen_dc, x, y, SRCCOPY);
  SelectObject(mem_dc, old);

  Gdiplus::Bitmap bitmap(bmp, nullptr);
  DeleteObject(bmp);
  DeleteDC(mem_dc);
  ReleaseDC(nullptr, screen_dc);

  const fs::path dir = fs::temp_directory_path() / ("omega-snip-" + std::to_string(GetTickCount64()));
  fs::create_directories(dir);
  const fs::path temp_path = dir / ("capture-" + std::to_string(GetTickCount64()) + ".png");
  const std::wstring wpath = temp_path.wstring();

  CLSID png_clsid{};
  UINT num = 0, size = 0;
  Gdiplus::GetImageEncodersSize(&num, &size);
  std::vector<uint8_t> enc_buf(size);
  auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(enc_buf.data());
  Gdiplus::GetImageEncoders(num, size, encoders);
  for (UINT i = 0; i < num; ++i) {
    if (wcscmp(encoders[i].MimeType, L"image/png") == 0) {
      png_clsid = encoders[i].Clsid;
      break;
    }
  }
  if (bitmap.Save(wpath.c_str(), &png_clsid, nullptr) != Gdiplus::Ok) {
    throw std::runtime_error("Failed to save PNG capture");
  }

  std::ifstream in(temp_path, std::ios::binary);
  std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  const std::string b64 = base64_encode(bytes);

  return json{{"tempPath", temp_path.string()},
              {"previewDataUrl", "data:image/png;base64," + b64},
              {"width", w},
              {"height", h}};
}

void hide_main(ShellContext& ctx) {
  if (ctx.main_window) hide_main_window(ctx.main_window);
  if (ctx.browser) ctx.browser->hide();
}

void show_main(ShellContext& ctx) {
  if (ctx.main_window) {
    show_main_window(ctx.main_window);
    focus_main_window(ctx.main_window);
  }
}

void finish_capture(json result) {
  std::lock_guard lock(g_capture.mu);
  g_capture.result = std::move(result);
  g_capture.done = true;
  g_capture.active = false;
  g_capture.cv.notify_all();
}

void post_init(ShellContext& ctx, const DesktopBounds& bounds) {
  if (!ctx.sniper_overlay) return;
  const std::string payload = bounds_json(bounds).dump();
  ctx.sniper_overlay->post_shell_event("omega:screen-snip:init", payload);
}

}  // namespace

ScreenSnipService::ScreenSnipService(ShellContext& ctx) : ctx_(ctx) {
  if (!ctx_.sniper_overlay) {
    ctx_.sniper_overlay = std::make_unique<OverlayWindow>();
  }
}

ScreenSnipService::~ScreenSnipService() = default;

json ScreenSnipService::get_bounds() const {
  std::lock_guard lock(g_capture.mu);
  if (g_capture.active) {
    return json{{"bounds", bounds_json(g_capture.bounds)}};
  }
  return json{{"bounds", bounds_json(virtual_desktop_bounds())}};
}

json ScreenSnipService::capture() {
  {
    std::lock_guard lock(g_capture.mu);
    if (g_capture.active) {
      g_capture.done = true;
      g_capture.result = nullptr;
      g_capture.cv.notify_all();
    }
    g_capture.active = true;
    g_capture.done = false;
    g_capture.result = nullptr;
    g_capture.bounds = virtual_desktop_bounds();
  }

  hide_main(ctx_);
  Sleep(120);

  const auto& b = g_capture.bounds;
  ctx_.sniper_overlay->show(ctx_.ui_page_url("screen-snip.html"), b.x, b.y, b.width, b.height);
  post_init(ctx_, b);

  json result = nullptr;
  {
    std::unique_lock lock(g_capture.mu);
    g_capture.cv.wait_for(lock, std::chrono::minutes(10), [] { return g_capture.done; });
    result = g_capture.result;
  }

  ctx_.sniper_overlay->hide();
  show_main(ctx_);
  return result;
}

json ScreenSnipService::submit(const json& rect) {
  bool active = false;
  {
    std::lock_guard lock(g_capture.mu);
    active = g_capture.active;
  }

  if (active) {
    ctx_.sniper_overlay->hide();
    Sleep(120);
  }

  try {
    const json capture_result = capture_rect(rect);
    if (active) finish_capture(capture_result);
    return capture_result;
  } catch (...) {
    if (active) finish_capture(nullptr);
    throw;
  }
}

json ScreenSnipService::cancel() {
  finish_capture(nullptr);
  return json{{"cancelled", true}};
}

json ScreenSnipService::save(const json& body) {
  const std::string temp_path = body.value("tempPath", body.value("temp_path", ""));
  if (temp_path.empty() || !fs::exists(temp_path)) {
    throw std::runtime_error("tempPath required");
  }

  wchar_t file[MAX_PATH] = L"omega-capture.png";
  OPENFILENAMEW ofn{};
  ofn.lStructSize = sizeof(ofn);
  ofn.lpstrFilter = L"PNG image\0*.png\0";
  ofn.lpstrFile = file;
  ofn.nMaxFile = MAX_PATH;
  ofn.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST;
  ofn.lpstrDefExt = L"png";
  if (!GetSaveFileNameW(&ofn)) {
    return json{{"saved", false}};
  }
  fs::copy_file(temp_path, file, fs::copy_options::overwrite_existing);
  return json{{"saved", true}, {"path", fs::path(file).string()}};
}

}  // namespace omega::shell

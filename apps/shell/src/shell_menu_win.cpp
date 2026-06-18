#include "omega/shell/shell_menu.hpp"

#include "omega/shell/shell_menu.hpp"
#include "omega/shell/webview_host.hpp"

#include <Windows.h>

#include <string>

namespace omega::shell {

namespace {

constexpr int kIdNewChat = 1001;
constexpr int kIdClearChat = 1002;
constexpr int kIdForkChat = 1003;
constexpr int kIdDeleteChat = 1004;
constexpr int kIdSettings = 1005;
constexpr int kIdFind = 1006;
constexpr int kIdEditMessage = 1007;
constexpr int kIdQuit = 1008;
constexpr int kIdCut = 1009;
constexpr int kIdCopy = 1010;
constexpr int kIdPaste = 1011;
constexpr int kIdNavBase = 1100;

WebViewHost* g_webview = nullptr;
ACCEL g_accel[32]{};
int g_accel_count = 0;
HACCEL g_accel_table = nullptr;

void add_accel(WORD key, WORD cmd, bool ctrl = true, bool shift = false) {
  if (g_accel_count >= 32) return;
  BYTE fvirt = FCONTROL | FVIRTKEY;
  if (shift) fvirt |= FSHIFT;
  g_accel[g_accel_count++] = ACCEL{fvirt, key, static_cast<WORD>(cmd)};
}

void post_shortcut(const char* json_payload) {
  if (!g_webview) return;
  g_webview->post_shell_event("omega:shortcut", json_payload);
}

void post_nav(const char* page) {
  std::string payload = R"({"action":"nav","page":")";
  payload += page;
  payload += R"("})";
  post_shortcut(payload.c_str());
}

HMENU build_menu() {
  HMENU bar = CreateMenu();
  HMENU file = CreatePopupMenu();
  AppendMenuW(file, MF_STRING, kIdNewChat, L"New Chat\tCtrl+N");
  AppendMenuW(file, MF_STRING, kIdClearChat, L"Clear Chat\tCtrl+L");
  AppendMenuW(file, MF_STRING, kIdForkChat, L"Fork Chat\tCtrl+Shift+D");
  AppendMenuW(file, MF_STRING, kIdDeleteChat, L"Delete Chat\tCtrl+Shift+Backspace");
  AppendMenuW(file, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(file, MF_STRING, kIdSettings, L"Settings\tCtrl+,");
  AppendMenuW(file, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(file, MF_STRING, kIdQuit, L"E&xit Omega");
  AppendMenuW(bar, MF_POPUP, reinterpret_cast<UINT_PTR>(file), L"&File");

  HMENU edit = CreatePopupMenu();
  AppendMenuW(edit, MF_STRING, kIdCut, L"Cu&t\tCtrl+X");
  AppendMenuW(edit, MF_STRING, kIdCopy, L"&Copy\tCtrl+C");
  AppendMenuW(edit, MF_STRING, kIdPaste, L"&Paste\tCtrl+V");
  AppendMenuW(edit, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(edit, MF_STRING, kIdFind, L"Find Chats\tCtrl+F");
  AppendMenuW(edit, MF_STRING, kIdEditMessage, L"Edit Message\tCtrl+E");
  AppendMenuW(bar, MF_POPUP, reinterpret_cast<UINT_PTR>(edit), L"&Edit");

  HMENU nav = CreatePopupMenu();
  const wchar_t* pages[] = {L"Chat", L"Browser", L"Content Studio", L"Finetune",
                            L"Installed Models", L"Models", L"Engines", L"Agent",
                            L"Workflows", L"Kanban", L"Memory", L"Tools", L"Settings"};
  const char* page_ids[] = {"chat", "browser", "content-studio", "finetune",
                              "installed-models", "models", "engines", "agent",
                              "workflows", "kanban", "memory", "tools", "settings"};
  for (int i = 0; i < 13; ++i) {
    wchar_t label[64];
    swprintf_s(label, L"%s\tCtrl+%d", pages[i], i + 1);
    AppendMenuW(nav, MF_STRING, kIdNavBase + i, label);
  }
  AppendMenuW(bar, MF_POPUP, reinterpret_cast<UINT_PTR>(nav), L"&Navigate");

  return bar;
}

void handle_command(int id) {
  switch (id) {
    case kIdNewChat:
      post_shortcut(R"({"action":"new-chat"})");
      break;
    case kIdClearChat:
      post_shortcut(R"({"action":"clear-chat"})");
      break;
    case kIdForkChat:
      post_shortcut(R"({"action":"fork-chat"})");
      break;
    case kIdDeleteChat:
      post_shortcut(R"({"action":"delete-chat"})");
      break;
    case kIdSettings:
      post_shortcut(R"({"action":"open-settings"})");
      break;
    case kIdFind:
      post_shortcut(R"({"action":"find"})");
      break;
    case kIdCut:
      if (g_webview) g_webview->exec_editing_command("cut");
      break;
    case kIdCopy:
      if (g_webview) g_webview->exec_editing_command("copy");
      break;
    case kIdPaste:
      if (g_webview) g_webview->exec_editing_command("paste");
      break;
    case kIdEditMessage:
      post_shortcut(R"({"action":"edit-message"})");
      break;
    case kIdQuit:
      shell_tray_quit_app();
      break;
    default:
      if (id >= kIdNavBase && id < kIdNavBase + 13) {
        const char* pages[] = {"chat", "browser", "content-studio", "finetune",
                               "installed-models", "models", "engines", "agent",
                               "workflows", "kanban", "memory", "tools", "settings"};
        post_nav(pages[id - kIdNavBase]);
      }
      break;
  }
}

}  // namespace

void install_shell_menu(NativeWindow hwnd, WebViewHost* webview) {
  g_webview = webview;
  SetMenu(reinterpret_cast<HWND>(hwnd), build_menu());

  add_accel('N', kIdNewChat);
  add_accel('L', kIdClearChat);
  add_accel('D', kIdForkChat, true, true);
  add_accel(VK_BACK, kIdDeleteChat, true, true);
  add_accel(',', kIdSettings);
  add_accel('X', kIdCut);
  add_accel('C', kIdCopy);
  add_accel('V', kIdPaste);
  add_accel('F', kIdFind);
  add_accel('E', kIdEditMessage);
  for (int i = 0; i < 13; ++i) {
    add_accel(static_cast<WORD>('1' + i), kIdNavBase + i);
  }
  if (g_accel_table) DestroyAcceleratorTable(g_accel_table);
  g_accel_table = CreateAcceleratorTableW(g_accel, g_accel_count);
}

bool shell_menu_translate_accel(NativeWindow hwnd, MSG* msg) {
  if (!g_accel_table) return false;
  return TranslateAcceleratorW(reinterpret_cast<HWND>(hwnd), g_accel_table, msg) != 0;
}

void shell_menu_handle_command(int command_id) { handle_command(command_id); }

}  // namespace omega::shell

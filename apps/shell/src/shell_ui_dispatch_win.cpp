#include "omega/shell/shell_ui_dispatch.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

#include <memory>

namespace omega::shell {

namespace {

struct UiWork {
  std::function<void()> fn;
  HANDLE done_event{nullptr};
};

DWORD window_thread_id(HWND hwnd) {
  DWORD tid = 0;
  GetWindowThreadProcessId(hwnd, &tid);
  return tid;
}

void run_work(UiWork* work) {
  if (!work) return;
  if (work->fn) work->fn();
  if (work->done_event) SetEvent(work->done_event);
  delete work;
}

bool post_work(HWND hwnd, UiWork* work) {
  if (!hwnd || !IsWindow(hwnd)) {
    delete work;
    return false;
  }
  if (!PostMessageW(hwnd, kShellUiMessage, 0, reinterpret_cast<LPARAM>(work))) {
    delete work;
    return false;
  }
  return true;
}

}  // namespace

bool shell_ui_dispatch_message(unsigned msg, std::uintptr_t wparam, std::intptr_t lparam) {
  (void)wparam;
  if (msg != kShellUiMessage) return false;
  run_work(reinterpret_cast<UiWork*>(lparam));
  return true;
}

void shell_ui_run_sync(NativeWindow main_window, std::function<void()> work) {
  HWND hwnd = reinterpret_cast<HWND>(main_window);
  if (!hwnd || !work) return;
  if (GetCurrentThreadId() == window_thread_id(hwnd)) {
    work();
    return;
  }
  auto* job = new UiWork{std::move(work), CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  if (!job->done_event) {
    delete job;
    return;
  }
  if (!post_work(hwnd, job)) {
    CloseHandle(job->done_event);
    return;
  }
  WaitForSingleObject(job->done_event, INFINITE);
  CloseHandle(job->done_event);
}

void shell_ui_run_async(NativeWindow main_window, std::function<void()> work) {
  HWND hwnd = reinterpret_cast<HWND>(main_window);
  if (!hwnd || !work) return;
  if (GetCurrentThreadId() == window_thread_id(hwnd)) {
    work();
    return;
  }
  post_work(hwnd, new UiWork{std::move(work), nullptr});
}

}  // namespace omega::shell

#else

namespace omega::shell {

bool shell_ui_dispatch_message(unsigned, std::uintptr_t, std::intptr_t) { return false; }

void shell_ui_run_sync(NativeWindow, std::function<void()> work) {
  if (work) work();
}

void shell_ui_run_async(NativeWindow, std::function<void()> work) {
  if (work) work();
}

}  // namespace omega::shell

#endif

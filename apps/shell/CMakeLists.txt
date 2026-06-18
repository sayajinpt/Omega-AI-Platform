cmake_minimum_required(VERSION 3.20)
project(omega_desktop CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
  nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_Declare(
  httplib
  GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
  GIT_TAG v0.15.3
)
set(HTTPLIB_REQUIRE_OPENSSL OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(nlohmann_json httplib)

set(SHELL_SHARED
  src/shell_context.cpp
  src/static_server.cpp
  src/shell_http_server.cpp
  src/shell_ui_dispatch_win.cpp
)

if(WIN32)
  set(WEBVIEW2_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/webview2")
  set(WEBVIEW2_INCLUDE "${WEBVIEW2_DIR}/build/native/include")
  set(WEBVIEW2_LOADER "${WEBVIEW2_DIR}/build/native/x64/WebView2LoaderStatic.lib")
  if(NOT EXISTS "${WEBVIEW2_INCLUDE}/WebView2.h")
    message(FATAL_ERROR "WebView2 SDK missing — run: node scripts/fetch-webview2-sdk.mjs")
  endif()

  add_executable(omega-desktop WIN32
    ${SHELL_SHARED}
    src/main.cpp
    src/app_paths.cpp
    src/runtime_supervisor.cpp
    src/webview_env_win.cpp
    src/webview_host_win.cpp
    src/embedded_browser.cpp
    src/overlay_window.cpp
    src/screen_snip_service.cpp
    src/shell_menu_win.cpp
    src/shell_tray_win.cpp
    src/platform_window_win.cpp
  )

  set(OMEGA_ICON "${CMAKE_CURRENT_SOURCE_DIR}/../desktop/resources/icon.ico")
  if(EXISTS "${OMEGA_ICON}")
    target_sources(omega-desktop PRIVATE resources/omega_desktop.rc)
    target_compile_definitions(omega-desktop PRIVATE IDI_ICON1=101)
  endif()

  target_include_directories(omega-desktop PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${WEBVIEW2_INCLUDE}
  )

  target_link_libraries(omega-desktop PRIVATE
    nlohmann_json::nlohmann_json
    httplib::httplib
    ${WEBVIEW2_LOADER}
    winhttp
    ole32
    shell32
    shcore
    user32
    gdi32
    gdiplus
    comdlg32
  )

  if(MSVC)
    target_compile_options(omega-desktop PRIVATE /utf-8 /W4)
    target_compile_definitions(omega-desktop PRIVATE UNICODE _UNICODE)
  endif()

elseif(APPLE)
  enable_language(OBJCXX)
  add_executable(omega-desktop MACOSX_BUNDLE
    ${SHELL_SHARED}
    src/main_mac.mm
    src/app_paths_unix.cpp
    src/runtime_supervisor_posix.cpp
    src/webview_host_mac.mm
    src/embedded_browser_mac.mm
    src/overlay_window_mac.mm
    src/screen_snip_mac.mm
    src/shell_menu_mac.mm
    src/shell_tray_mac.mm
    src/platform_window_mac.mm
  )

  target_include_directories(omega-desktop PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/include)
  target_link_libraries(omega-desktop PRIVATE
    nlohmann_json::nlohmann_json
    httplib::httplib
    "-framework Cocoa"
    "-framework WebKit"
  )
  set_target_properties(omega-desktop PROPERTIES
    OUTPUT_NAME "omega-desktop"
    MACOSX_BUNDLE_BUNDLE_NAME "Omega"
    MACOSX_BUNDLE_GUI_IDENTIFIER "com.omega.desktop"
  )

else()
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(GTK3 REQUIRED gtk+-3.0)
  pkg_check_modules(WEBKIT2 REQUIRED webkit2gtk-4.1)

  add_executable(omega-desktop
    ${SHELL_SHARED}
    src/main_linux.cpp
    src/app_paths_unix.cpp
    src/runtime_supervisor_posix.cpp
    src/webview_host_linux.cpp
    src/embedded_browser_linux.cpp
    src/overlay_window_linux.cpp
    src/screen_snip_linux.cpp
    src/shell_menu_linux.cpp
    src/shell_tray_linux.cpp
    src/platform_window_unix.cpp
  )

  target_include_directories(omega-desktop PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${GTK3_INCLUDE_DIRS}
    ${WEBKIT2_INCLUDE_DIRS}
  )
  target_link_libraries(omega-desktop PRIVATE
    nlohmann_json::nlohmann_json
    httplib::httplib
    ${GTK3_LIBRARIES}
    ${WEBKIT2_LIBRARIES}
  )
  target_compile_options(omega-desktop PRIVATE ${GTK3_CFLAGS_OTHER} ${WEBKIT2_CFLAGS_OTHER})
endif()

set_target_properties(omega-desktop PROPERTIES OUTPUT_NAME "omega-desktop")

#include "omega/shell/app_paths.hpp"
#include "omega/shell/embedded_browser.hpp"
#include "omega/shell/overlay_window.hpp"
#include "omega/shell/runtime_supervisor.hpp"
#include "omega/shell/screen_snip_service.hpp"
#include "omega/shell/shell_context.hpp"
#include "omega/shell/shell_http_server.hpp"
#include "omega/shell/shell_menu.hpp"
#include "omega/shell/static_server.hpp"
#include "omega/shell/webview_host.hpp"

#include <gtk/gtk.h>

#include <memory>
#include <string>

namespace {

constexpr int kUiPort = 9777;

struct AppState {
  omega::shell::ShellContext shell;
  omega::shell::RuntimeSupervisor runtime;
  omega::shell::StaticServer ui_server;
  omega::shell::WebViewHost webview;
  GtkWidget* window{nullptr};
  GtkWidget* root_box{nullptr};
};

AppState* g_app = nullptr;

std::string ui_url(int port) { return "http://127.0.0.1:" + std::to_string(port) + "/"; }

gboolean on_delete(GtkWidget* widget, GdkEvent*, gpointer) {
  (void)widget;
  if (!g_app) return FALSE;
  if (omega::shell::shell_tray_handle_close(g_app->shell.main_window)) return TRUE;
  g_app->shell.shell_http->stop();
  g_app->ui_server.stop();
  g_app->runtime.stop();
  omega::shell::shell_tray_dispose();
  gtk_main_quit();
  return FALSE;
}

void on_resize(GtkWidget*, GdkEventConfigure* event, gpointer) {
  if (!g_app || !event) return;
  g_app->webview.resize(event->width, event->height);
}

}  // namespace

int main(int argc, char* argv[]) {
  gtk_init(&argc, &argv);
  auto app = std::make_unique<AppState>();
  g_app = app.get();

  try {
    app->runtime.start();
  } catch (const std::exception& e) {
    GtkWidget* dialog = gtk_message_dialog_new(
        nullptr, GTK_DIALOG_MODAL, GTK_MESSAGE_ERROR, GTK_BUTTONS_CLOSE, "Omega — runtime failed");
    gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s", e.what());
    gtk_dialog_run(GTK_DIALOG(dialog));
    gtk_widget_destroy(dialog);
    return 1;
  }

  const std::string ui_root = omega::shell::ui_root();
  try {
    app->ui_server.start(ui_root, kUiPort);
  } catch (const std::exception& e) {
    GtkWidget* dialog = gtk_message_dialog_new(
        nullptr, GTK_DIALOG_MODAL, GTK_MESSAGE_ERROR, GTK_BUTTONS_CLOSE, "Omega — UI server failed");
    gtk_message_dialog_format_secondary_text(GTK_MESSAGE_DIALOG(dialog), "%s", e.what());
    gtk_dialog_run(GTK_DIALOG(dialog));
    gtk_widget_destroy(dialog);
    app->runtime.stop();
    return 1;
  }

  app->shell.ui_port = kUiPort;
  app->shell.runtime_base = "http://127.0.0.1:9877";
  app->shell.browser = std::make_unique<omega::shell::EmbeddedBrowser>();
  app->shell.avatar_overlay = std::make_unique<omega::shell::OverlayWindow>();
  app->shell.screen_snip = std::make_unique<omega::shell::ScreenSnipService>(app->shell);
  app->shell.shell_http = std::make_unique<omega::shell::ShellHttpServer>();

  app->window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_title(GTK_WINDOW(app->window), "Omega");
  gtk_window_set_default_size(GTK_WINDOW(app->window), 1400, 900);
  g_signal_connect(app->window, "delete-event", G_CALLBACK(on_delete), nullptr);

  app->root_box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 0);
  gtk_container_add(GTK_CONTAINER(app->window), app->root_box);

  app->shell.main_window = app->root_box;
  app->shell.main_webview = &app->webview;
  app->shell.browser->attach(app->shell.main_window);

  app->webview.create(app->shell.main_window, ui_url(kUiPort));
  omega::shell::install_shell_menu(app->shell.main_window, &app->webview);
  omega::shell::shell_tray_init(app->shell.main_window);
  app->shell.shell_http->start(app->shell);

  g_signal_connect(app->window, "configure-event", G_CALLBACK(on_resize), nullptr);
  gtk_widget_show_all(app->window);
  gtk_main();

  g_app = nullptr;
  return 0;
}

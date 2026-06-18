#include "omega/shell/shell_menu.hpp"

#include "omega/shell/platform_window.hpp"

#include <gtk/gtk.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

namespace omega::shell {

namespace {

GtkStatusIcon* g_status_icon = nullptr;
GtkWidget* g_main_window = nullptr;
bool g_quitting = false;
bool g_close_to_tray = true;

bool fetch_close_to_tray_from_runtime() {
  httplib::Client cli("127.0.0.1", 9877);
  cli.set_connection_timeout(1, 0);
  const auto res = cli.Get("/v1/config");
  if (!res || res->status != 200) return true;
  try {
    const auto root = nlohmann::json::parse(res->body);
    const auto& cfg = root.contains("config") ? root["config"] : root;
    if (cfg.contains("closeToTray") && cfg["closeToTray"].is_boolean()) {
      return cfg["closeToTray"].get<bool>();
    }
  } catch (...) {
  }
  return true;
}

void show_main_window() {
  if (!g_main_window) return;
  gtk_widget_show_all(g_main_window);
  gtk_window_present(GTK_WINDOW(g_main_window));
}

void on_tray_activate(GtkStatusIcon*, gpointer) { show_main_window(); }

void on_tray_show(GtkMenuItem*, gpointer) { show_main_window(); }

void on_tray_quit(GtkMenuItem*, gpointer) {
  g_quitting = true;
  gtk_main_quit();
}

void on_tray_popup(GtkStatusIcon*, guint button, guint activate_time, gpointer) {
  GtkWidget* menu = gtk_menu_new();
  GtkWidget* show_item = gtk_menu_item_new_with_label("Show Omega");
  GtkWidget* quit_item = gtk_menu_item_new_with_label("Quit Omega");
  g_signal_connect(show_item, "activate", G_CALLBACK(on_tray_show), nullptr);
  g_signal_connect(quit_item, "activate", G_CALLBACK(on_tray_quit), nullptr);
  gtk_menu_shell_append(GTK_MENU_SHELL(menu), show_item);
  gtk_menu_shell_append(GTK_MENU_SHELL(menu), quit_item);
  gtk_widget_show_all(menu);
  gtk_menu_popup_at_pointer(GTK_MENU(menu), nullptr);
  (void)button;
  (void)activate_time;
}

}  // namespace

void shell_tray_init(NativeWindow main_window) {
  g_main_window = static_cast<GtkWidget*>(main_window);
  while (g_main_window && !GTK_IS_WINDOW(g_main_window)) {
    g_main_window = gtk_widget_get_parent(g_main_window);
  }
  g_close_to_tray = fetch_close_to_tray_from_runtime();

  g_status_icon = gtk_status_icon_new_from_icon_name("application-default-icon");
  g_signal_connect(g_status_icon, "activate", G_CALLBACK(on_tray_activate), nullptr);
  g_signal_connect(g_status_icon, "popup-menu", G_CALLBACK(on_tray_popup), nullptr);
  gtk_status_icon_set_tooltip_text(g_status_icon, "Omega");
}

void shell_tray_dispose() {
  if (g_status_icon) {
    g_object_unref(g_status_icon);
    g_status_icon = nullptr;
  }
  g_main_window = nullptr;
}

bool shell_tray_close_to_tray_enabled() { return g_close_to_tray; }

bool shell_tray_handle_close(NativeWindow main_window) {
  if (g_quitting || !g_close_to_tray) return false;
  GtkWidget* widget = static_cast<GtkWidget*>(main_window);
  while (widget && !GTK_IS_WINDOW(widget)) widget = gtk_widget_get_parent(widget);
  if (widget) gtk_widget_hide(widget);
  return true;
}

bool shell_tray_handle_message(NativeWindow, unsigned, unsigned long long, long long) { return false; }

void shell_tray_show_main_window() { show_main_window(); }

void shell_tray_force_quit() { g_quitting = true; }

void shell_tray_quit_app() {
  g_quitting = true;
  gtk_main_quit();
}

}  // namespace omega::shell

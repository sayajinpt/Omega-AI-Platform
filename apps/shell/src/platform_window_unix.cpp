#include "omega/shell/platform_window.hpp"

#include <cstdlib>
#include <string>

#if defined(__linux__)
#include <gtk/gtk.h>
#endif

namespace omega::shell {

bool open_url_in_browser(const std::string& url) {
  if (url.empty()) return false;
#if defined(__linux__)
  const std::string cmd = "xdg-open '" + url + "'";
  return std::system(cmd.c_str()) == 0;
#else
  return false;
#endif
}

void show_main_window(NativeWindow window) {
#if defined(__linux__)
  GtkWidget* widget = static_cast<GtkWidget*>(window);
  GtkWidget* toplevel = gtk_widget_get_toplevel(widget);
  if (GTK_IS_WINDOW(toplevel)) gtk_window_present(GTK_WINDOW(toplevel));
#else
  (void)window;
#endif
}

void hide_main_window(NativeWindow window) {
#if defined(__linux__)
  GtkWidget* widget = static_cast<GtkWidget*>(window);
  GtkWidget* toplevel = gtk_widget_get_toplevel(widget);
  if (GTK_IS_WINDOW(toplevel)) gtk_widget_hide(toplevel);
#else
  (void)window;
#endif
}

void focus_main_window(NativeWindow window) { show_main_window(window); }

}  // namespace omega::shell

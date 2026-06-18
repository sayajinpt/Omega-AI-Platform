#include "omega/shell/shell_menu.hpp"
#include "omega/shell/webview_host.hpp"

#include <gtk/gtk.h>

namespace omega::shell {

namespace {

WebViewHost* g_webview = nullptr;

void on_cut(GtkWidget*, gpointer) {
  if (g_webview) g_webview->exec_editing_command("cut");
}
void on_copy(GtkWidget*, gpointer) {
  if (g_webview) g_webview->exec_editing_command("copy");
}
void on_paste(GtkWidget*, gpointer) {
  if (g_webview) g_webview->exec_editing_command("paste");
}

}  // namespace

void install_shell_menu(NativeWindow, WebViewHost* webview) {
  g_webview = webview;
  GtkWidget* bar = gtk_menu_bar_new();
  GtkWidget* file_menu = gtk_menu_new();
  GtkWidget* file_item = gtk_menu_item_new_with_label("File");
  gtk_menu_item_set_submenu(GTK_MENU_ITEM(file_item), file_menu);
  gtk_menu_shell_append(GTK_MENU_SHELL(bar), file_item);

  GtkWidget* edit_menu = gtk_menu_new();
  GtkWidget* edit_item = gtk_menu_item_new_with_label("Edit");
  GtkWidget* cut = gtk_menu_item_new_with_label("Cut");
  GtkWidget* copy = gtk_menu_item_new_with_label("Copy");
  GtkWidget* paste = gtk_menu_item_new_with_label("Paste");
  g_signal_connect(cut, "activate", G_CALLBACK(on_cut), nullptr);
  g_signal_connect(copy, "activate", G_CALLBACK(on_copy), nullptr);
  g_signal_connect(paste, "activate", G_CALLBACK(on_paste), nullptr);
  gtk_menu_shell_append(GTK_MENU_SHELL(edit_menu), cut);
  gtk_menu_shell_append(GTK_MENU_SHELL(edit_menu), copy);
  gtk_menu_shell_append(GTK_MENU_SHELL(edit_menu), paste);
  gtk_menu_item_set_submenu(GTK_MENU_ITEM(edit_item), edit_menu);
  gtk_menu_shell_append(GTK_MENU_SHELL(bar), edit_item);
  (void)bar;
}

void shell_menu_handle_command(int) {}
bool shell_menu_translate_accel(NativeWindow, omega::shell::ShellAccelMsg*) { return false; }

}  // namespace omega::shell

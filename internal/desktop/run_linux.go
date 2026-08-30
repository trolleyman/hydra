//go:build linux && cgo && hydra_desktop

package desktop

/*
#cgo pkg-config: gtk4 webkitgtk-6.0

#include <gtk/gtk.h>
#include <stdlib.h>
#include <string.h>
#include <webkit/webkit.h>

typedef struct HydraDesktop HydraDesktop;
static gboolean hydra_keep_running = TRUE;

typedef struct {
	HydraDesktop *desktop;
	GtkWidget *window;
	WebKitWebView *web_view;
	char *project_id;
	char *agent_id;
	gboolean active_turn;
	gboolean image_paste_target;
	gboolean force_close;
} HydraWindow;

struct HydraDesktop {
	GtkApplication *app;
	GtkWindow *primary_window;
	const char *uri;
	GUri *origin;
	gboolean keep_running;
};

typedef struct {
	WebKitWebView *web_view;
	char *request_id;
} HydraFolderRequest;

typedef struct {
	WebKitWebView *web_view;
} HydraImagePasteRequest;

static void hydra_open_window_at(HydraDesktop *desktop, const char *uri);

static void hydra_show_main_window(HydraDesktop *desktop) {
	if (desktop->primary_window != NULL) {
		gtk_window_present(desktop->primary_window);
		return;
	}
	hydra_open_window_at(desktop, desktop->uri);
	desktop->primary_window = gtk_application_get_active_window(desktop->app);
}

static char *hydra_string_property(JSCValue *value, const char *name) {
	JSCValue *property = jsc_value_object_get_property(value, name);
	char *result = jsc_value_is_string(property) ? jsc_value_to_string(property) : NULL;
	g_object_unref(property);
	return result;
}

static gboolean hydra_boolean_property(JSCValue *value, const char *name) {
	JSCValue *property = jsc_value_object_get_property(value, name);
	gboolean result = jsc_value_is_boolean(property) && jsc_value_to_boolean(property);
	g_object_unref(property);
	return result;
}

static gboolean hydra_same_origin(HydraDesktop *desktop, const char *candidate) {
	GUri *uri = g_uri_parse(candidate, G_URI_FLAGS_NONE, NULL);
	if (uri == NULL) return FALSE;
	const char *left_scheme = g_uri_get_scheme(desktop->origin);
	const char *right_scheme = g_uri_get_scheme(uri);
	const char *left_host = g_uri_get_host(desktop->origin);
	const char *right_host = g_uri_get_host(uri);
	gboolean same = left_scheme != NULL && right_scheme != NULL && left_host != NULL && right_host != NULL &&
		g_ascii_strcasecmp(left_scheme, right_scheme) == 0 &&
		g_ascii_strcasecmp(left_host, right_host) == 0 &&
		g_uri_get_port(desktop->origin) == g_uri_get_port(uri);
	g_uri_unref(uri);
	return same;
}

static char *hydra_origin_url(HydraDesktop *desktop, const char *path) {
	const char *scheme = g_uri_get_scheme(desktop->origin);
	const char *host = g_uri_get_host(desktop->origin);
	int port = g_uri_get_port(desktop->origin);
	if (port >= 0) return g_strdup_printf("%s://%s:%d%s", scheme, host, port, path);
	return g_strdup_printf("%s://%s%s", scheme, host, path);
}

static void hydra_dispatch_command(WebKitWebView *web_view, const char *type) {
	char *script = g_strdup_printf(
		"window.dispatchEvent(new CustomEvent('hydra-desktop-command',{detail:{type:'%s'}}))", type);
	webkit_web_view_evaluate_javascript(web_view, script, -1, NULL, NULL, NULL, NULL, NULL);
	g_free(script);
}

static void hydra_image_paste_ready(GObject *source, GAsyncResult *result, gpointer data) {
	HydraImagePasteRequest *request = data;
	GError *error = NULL;
	GdkTexture *texture = gdk_clipboard_read_texture_finish(GDK_CLIPBOARD(source), result, &error);
	if (texture != NULL) {
		GBytes *png = gdk_texture_save_to_png_bytes(texture);
		gsize size = 0;
		const guchar *bytes = g_bytes_get_data(png, &size);
		char *encoded = g_base64_encode(bytes, size);
		char *script = g_strdup_printf(
			"window.dispatchEvent(new CustomEvent('hydra-desktop-image-paste',{detail:{base64:'%s',mediaType:'image/png',name:'image.png'}}))",
			encoded);
		webkit_web_view_evaluate_javascript(request->web_view, script, -1, NULL, NULL, NULL, NULL, NULL);
		g_free(script);
		g_free(encoded);
		g_bytes_unref(png);
		g_object_unref(texture);
	}
	g_clear_error(&error);
	g_object_unref(request->web_view);
	g_free(request);
}

static gboolean hydra_clipboard_has_image(GdkClipboard *clipboard) {
	GdkContentFormats *formats = gdk_clipboard_get_formats(clipboard);
	if (gdk_content_formats_contain_gtype(formats, GDK_TYPE_TEXTURE)) return TRUE;
	gsize count = 0;
	const char * const *types = gdk_content_formats_get_mime_types(formats, &count);
	for (gsize i = 0; i < count; i++) {
		if (g_str_has_prefix(types[i], "image/")) return TRUE;
	}
	return FALSE;
}

static gboolean hydra_key_pressed(GtkEventControllerKey *controller, guint keyval,
	guint keycode, GdkModifierType modifiers, gpointer data) {
	HydraWindow *window = data;
	if (!window->image_paste_target || gdk_keyval_to_lower(keyval) != GDK_KEY_v ||
		(modifiers & GDK_CONTROL_MASK) == 0 || (modifiers & (GDK_ALT_MASK | GDK_SHIFT_MASK)) != 0)
		return FALSE;
	GdkClipboard *clipboard = gtk_widget_get_clipboard(GTK_WIDGET(window->web_view));
	if (!hydra_clipboard_has_image(clipboard)) return FALSE;
	HydraImagePasteRequest *request = g_new0(HydraImagePasteRequest, 1);
	request->web_view = g_object_ref(window->web_view);
	gdk_clipboard_read_texture_async(clipboard, NULL, hydra_image_paste_ready, request);
	return TRUE;
}

static void hydra_folder_response(HydraFolderRequest *request, const char *path, const char *error) {
	char *escaped_id = g_strescape(request->request_id, NULL);
	char *escaped_path = path == NULL ? NULL : g_strescape(path, NULL);
	char *escaped_error = error == NULL ? NULL : g_strescape(error, NULL);
	char *path_value = escaped_path == NULL ? g_strdup("null") : g_strdup_printf("'%s'", escaped_path);
	char *error_value = escaped_error == NULL ? g_strdup("null") : g_strdup_printf("'%s'", escaped_error);
	char *script = g_strdup_printf(
		"window.dispatchEvent(new CustomEvent('hydra-desktop-folder-picked',{detail:{requestId:'%s',path:%s,error:%s}}))",
		escaped_id, path_value, error_value);
	webkit_web_view_evaluate_javascript(request->web_view, script, -1, NULL, NULL, NULL, NULL, NULL);
	g_free(script);
	g_free(escaped_id);
	g_free(escaped_path);
	g_free(escaped_error);
	g_free(path_value);
	g_free(error_value);
	g_object_unref(request->web_view);
	g_free(request->request_id);
	g_free(request);
}

static void hydra_folder_selected(GObject *source, GAsyncResult *result, gpointer data) {
	HydraFolderRequest *request = data;
	GError *error = NULL;
	GFile *folder = gtk_file_dialog_select_folder_finish(GTK_FILE_DIALOG(source), result, &error);
	if (folder != NULL) {
		char *path = g_file_get_path(folder);
		hydra_folder_response(request, path, NULL);
		g_free(path);
		g_object_unref(folder);
	} else if (g_error_matches(error, GTK_DIALOG_ERROR, GTK_DIALOG_ERROR_DISMISSED) ||
		g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
		hydra_folder_response(request, NULL, NULL);
	} else {
		hydra_folder_response(request, NULL, error == NULL ? "folder selection failed" : error->message);
	}
	g_clear_error(&error);
}

static void hydra_pick_folder(HydraWindow *window, const char *request_id) {
	GtkFileDialog *dialog = gtk_file_dialog_new();
	gtk_file_dialog_set_title(dialog, "Choose a project folder");
	HydraFolderRequest *request = g_new0(HydraFolderRequest, 1);
	request->web_view = g_object_ref(window->web_view);
	request->request_id = g_strdup(request_id);
	gtk_file_dialog_select_folder(dialog, GTK_WINDOW(window->window), NULL, hydra_folder_selected, request);
	g_object_unref(dialog);
}

static void hydra_notification_open(GSimpleAction *action, GVariant *parameter, gpointer data) {
	HydraDesktop *desktop = data;
	const char *uri = g_variant_get_string(parameter, NULL);
	if (hydra_same_origin(desktop, uri)) hydra_open_window_at(desktop, uri);
}

static void hydra_show_notification(HydraWindow *window, JSCValue *value) {
	char *title = hydra_string_property(value, "title");
	char *body = hydra_string_property(value, "body");
	char *tag = hydra_string_property(value, "tag");
	char *uri = hydra_string_property(value, "url");
	if (title != NULL && body != NULL && tag != NULL && uri != NULL && hydra_same_origin(window->desktop, uri)) {
		GNotification *notification = g_notification_new(title);
		g_notification_set_body(notification, body);
		g_notification_set_default_action_and_target(notification, "app.open-uri", "s", uri);
		g_application_send_notification(G_APPLICATION(window->desktop->app), tag, notification);
		g_object_unref(notification);
	}
	g_free(title); g_free(body); g_free(tag); g_free(uri);
}

static void hydra_close_choice(GObject *source, GAsyncResult *result, gpointer data) {
	HydraWindow *window = data;
	GError *error = NULL;
	int choice = gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(source), result, &error);
	if (error == NULL && choice > 0) {
		window->force_close = TRUE;
		if (choice == 2) hydra_dispatch_command(window->web_view, "stop-and-close");
		else gtk_window_destroy(GTK_WINDOW(window->window));
	}
	g_clear_error(&error);
}

static gboolean hydra_close_request(GtkWindow *gtk_window, gpointer data) {
	HydraWindow *window = data;
	if (window->force_close || !window->active_turn) return FALSE;
	GtkAlertDialog *dialog = gtk_alert_dialog_new("This agent is still running");
	gtk_alert_dialog_set_detail(dialog, "Closing the window can leave the agent running in the background.");
	const char *buttons[] = { "Cancel", "Close and leave running", "Stop and close", NULL };
	gtk_alert_dialog_set_buttons(dialog, buttons);
	gtk_alert_dialog_set_cancel_button(dialog, 0);
	gtk_alert_dialog_set_default_button(dialog, 1);
	gtk_alert_dialog_choose(dialog, gtk_window, NULL, hydra_close_choice, window);
	g_object_unref(dialog);
	return TRUE;
}

static void hydra_script_message(WebKitUserContentManager *manager, JSCValue *value, gpointer data) {
	HydraWindow *window = data;
	char *type = hydra_string_property(value, "type");
	if (g_strcmp0(type, "show-main-window") == 0) {
		hydra_show_main_window(window->desktop);
	} else if (g_strcmp0(type, "new-chat-window") == 0) {
		char *project = hydra_string_property(value, "projectId");
		char *agent = hydra_string_property(value, "agentId");
		if (project == NULL) project = g_strdup(window->project_id);
		if (project != NULL) {
			char *escaped = g_uri_escape_string(project, NULL, FALSE);
			char *escaped_agent = agent == NULL ? NULL : g_uri_escape_string(agent, NULL, FALSE);
			char *path = escaped_agent == NULL
				? g_strdup_printf("/focused/%s", escaped)
				: g_strdup_printf("/project/%s/agent/%s", escaped, escaped_agent);
			char *uri = hydra_origin_url(window->desktop, path);
			hydra_open_window_at(window->desktop, uri);
			g_free(uri); g_free(path); g_free(escaped); g_free(escaped_agent);
		}
		g_free(project); g_free(agent);
	} else if (g_strcmp0(type, "active-project") == 0) {
		g_free(window->project_id);
		window->project_id = hydra_string_property(value, "projectId");
	} else if (g_strcmp0(type, "window-state") == 0) {
		g_free(window->project_id); g_free(window->agent_id);
		window->project_id = hydra_string_property(value, "projectId");
		window->agent_id = hydra_string_property(value, "agentId");
		window->active_turn = hydra_boolean_property(value, "activeTurn");
	} else if (g_strcmp0(type, "image-paste-target") == 0) {
		window->image_paste_target = hydra_boolean_property(value, "enabled");
	} else if (g_strcmp0(type, "close-window") == 0) {
		window->force_close = hydra_boolean_property(value, "force");
		gtk_window_close(GTK_WINDOW(window->window));
	} else if (g_strcmp0(type, "show-notification") == 0) {
		hydra_show_notification(window, value);
	} else if (g_strcmp0(type, "dismiss-notification") == 0) {
		char *tag = hydra_string_property(value, "tag");
		if (tag != NULL) g_application_withdraw_notification(G_APPLICATION(window->desktop->app), tag);
		g_free(tag);
	} else if (g_strcmp0(type, "pick-folder") == 0) {
		char *request_id = hydra_string_property(value, "requestId");
		if (request_id != NULL) hydra_pick_folder(window, request_id);
		g_free(request_id);
	} else if (g_strcmp0(type, "keep-running") == 0) {
		window->desktop->keep_running = hydra_boolean_property(value, "enabled");
		hydra_keep_running = window->desktop->keep_running;
	}
	g_free(type);
}

static gboolean hydra_decide_policy(WebKitWebView *web_view, WebKitPolicyDecision *decision,
	WebKitPolicyDecisionType type, gpointer data) {
	HydraDesktop *desktop = data;
	if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION &&
		type != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) return FALSE;
	WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(
		WEBKIT_NAVIGATION_POLICY_DECISION(decision));
	const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
	if (hydra_same_origin(desktop, uri)) return FALSE;
	if (webkit_navigation_action_get_navigation_type(action) == WEBKIT_NAVIGATION_TYPE_LINK_CLICKED &&
		(g_str_has_prefix(uri, "http://") || g_str_has_prefix(uri, "https://")))
		g_app_info_launch_default_for_uri(uri, NULL, NULL);
	webkit_policy_decision_ignore(decision);
	return TRUE;
}

static void hydra_window_destroy(GtkWidget *widget, gpointer data) {
	HydraWindow *window = data;
	if (window->desktop->primary_window == GTK_WINDOW(widget)) window->desktop->primary_window = NULL;
	g_free(window->project_id);
	g_free(window->agent_id);
	g_free(window);
}

static void hydra_open_window_at(HydraDesktop *desktop, const char *uri) {
	GtkWidget *window = gtk_application_window_new(desktop->app);
	gtk_window_set_title(GTK_WINDOW(window), "Hydra");
	gtk_window_set_default_size(GTK_WINDOW(window), 1280, 820);

	WebKitUserContentManager *manager = webkit_user_content_manager_new();
	WebKitUserScript *capabilities = webkit_user_script_new(
		"window.hydraDesktopCapabilities={nativeNotifications:true,nativeFolderPicker:true};"
		"document.addEventListener('focusin',event=>window.webkit.messageHandlers.hydra.postMessage({type:'image-paste-target',enabled:!!event.target?.hasAttribute?.('data-desktop-image-paste')}),true);"
		"document.addEventListener('focusout',()=>queueMicrotask(()=>window.webkit.messageHandlers.hydra.postMessage({type:'image-paste-target',enabled:!!document.activeElement?.hasAttribute?.('data-desktop-image-paste')})),true);"
		"window.addEventListener('DOMContentLoaded',()=>window.webkit.messageHandlers.hydra.postMessage({type:'keep-running',enabled:localStorage.getItem('hydra-desktop-keep-running')!=='0'}))",
		WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, NULL, NULL);
	webkit_user_content_manager_add_script(manager, capabilities);
	webkit_user_script_unref(capabilities);
	WebKitWebView *web_view = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW,
		"user-content-manager", manager, NULL));
	g_object_unref(manager);

	HydraWindow *state = g_new0(HydraWindow, 1);
	state->desktop = desktop;
	state->window = window;
	state->web_view = web_view;
	g_object_set_data(G_OBJECT(window), "hydra-window", state);
	webkit_user_content_manager_register_script_message_handler(
		webkit_web_view_get_user_content_manager(web_view), "hydra", NULL);
	g_signal_connect(webkit_web_view_get_user_content_manager(web_view),
		"script-message-received::hydra", G_CALLBACK(hydra_script_message), state);
	g_signal_connect(window, "close-request", G_CALLBACK(hydra_close_request), state);
	g_signal_connect(window, "destroy", G_CALLBACK(hydra_window_destroy), state);
	g_signal_connect(web_view, "decide-policy", G_CALLBACK(hydra_decide_policy), desktop);
	GtkEventController *keys = gtk_event_controller_key_new();
	gtk_event_controller_set_propagation_phase(keys, GTK_PHASE_CAPTURE);
	g_signal_connect(keys, "key-pressed", G_CALLBACK(hydra_key_pressed), state);
	gtk_widget_add_controller(GTK_WIDGET(web_view), keys);
	gtk_window_set_child(GTK_WINDOW(window), GTK_WIDGET(web_view));
	webkit_web_view_load_uri(web_view, uri);
	gtk_window_present(GTK_WINDOW(window));
}

static void hydra_new_window(GSimpleAction *action, GVariant *parameter, gpointer data) {
	HydraDesktop *desktop = data;
	hydra_show_main_window(desktop);
}

static void hydra_new_chat(GSimpleAction *action, GVariant *parameter, gpointer data) {
	HydraDesktop *desktop = data;
	GtkWindow *active = gtk_application_get_active_window(desktop->app);
	if (active == NULL) return;
	HydraWindow *window = g_object_get_data(G_OBJECT(active), "hydra-window");
	if (window == NULL || window->project_id == NULL) return;
	char *escaped = g_uri_escape_string(window->project_id, NULL, FALSE);
	char *path = g_strdup_printf("/focused/%s", escaped);
	char *uri = hydra_origin_url(desktop, path);
	hydra_open_window_at(desktop, uri);
	g_free(uri); g_free(path); g_free(escaped);
}

static void hydra_settings(GSimpleAction *action, GVariant *parameter, gpointer data) {
	HydraDesktop *desktop = data;
	char *uri = hydra_origin_url(desktop, "/settings");
	hydra_open_window_at(desktop, uri);
	g_free(uri);
}

static void hydra_quit_choice(GObject *source, GAsyncResult *result, gpointer data) {
	HydraDesktop *desktop = data;
	GError *error = NULL;
	int choice = gtk_alert_dialog_choose_finish(GTK_ALERT_DIALOG(source), result, &error);
	if (error == NULL && choice == 1) g_application_quit(G_APPLICATION(desktop->app));
	g_clear_error(&error);
}

static void hydra_quit(GSimpleAction *action, GVariant *parameter, gpointer data) {
	HydraDesktop *desktop = data;
	gboolean active = FALSE;
	for (GList *item = gtk_application_get_windows(desktop->app); item != NULL; item = item->next) {
		HydraWindow *window = g_object_get_data(G_OBJECT(item->data), "hydra-window");
		if (window != NULL && window->active_turn) { active = TRUE; break; }
	}
	if (!active) { g_application_quit(G_APPLICATION(desktop->app)); return; }
	GtkAlertDialog *dialog = gtk_alert_dialog_new("Agents are still running");
	gtk_alert_dialog_set_detail(dialog, "Quitting closes Hydra windows but leaves the shared backend and agents running.");
	const char *buttons[] = { "Cancel", "Quit and leave running", NULL };
	gtk_alert_dialog_set_buttons(dialog, buttons);
	gtk_alert_dialog_set_cancel_button(dialog, 0);
	gtk_alert_dialog_choose(dialog, gtk_application_get_active_window(desktop->app), NULL, hydra_quit_choice, desktop);
	g_object_unref(dialog);
}

static void hydra_activate(GtkApplication *app, gpointer data) {
	HydraDesktop *desktop = data;
	desktop->app = app;
	GtkWindow *active = gtk_application_get_active_window(app);
	if (active != NULL) gtk_window_present(active);
	else hydra_show_main_window(desktop);
}

static int hydra_command_line(GApplication *application, GApplicationCommandLine *command_line, gpointer data) {
	HydraDesktop *desktop = data;
	desktop->app = GTK_APPLICATION(application);
	int argc = 0;
	char **argv = g_application_command_line_get_arguments(command_line, &argc);
	const char *uri = argc > 1 && hydra_same_origin(desktop, argv[1]) ? argv[1] : desktop->uri;
	if (g_strcmp0(uri, desktop->uri) == 0) hydra_show_main_window(desktop);
	else hydra_open_window_at(desktop, uri);
	g_strfreev(argv);
	return 0;
}

static void hydra_startup(GApplication *application, gpointer data) {
	HydraDesktop *desktop = data;
	desktop->app = GTK_APPLICATION(application);
	const GActionEntry actions[] = {
		{ "new-window", hydra_new_window, NULL, NULL, NULL },
		{ "new-chat", hydra_new_chat, NULL, NULL, NULL },
		{ "settings", hydra_settings, NULL, NULL, NULL },
		{ "open-uri", hydra_notification_open, "s", NULL, NULL },
		{ "quit", hydra_quit, NULL, NULL, NULL },
	};
	g_action_map_add_action_entries(G_ACTION_MAP(application), actions, G_N_ELEMENTS(actions), desktop);
	const char *new_window[] = { "<Primary>n", NULL };
	const char *new_chat[] = { "<Primary><Shift>n", NULL };
	const char *settings[] = { "<Primary>comma", NULL };
	const char *quit[] = { "<Primary>q", NULL };
	gtk_application_set_accels_for_action(desktop->app, "app.new-window", new_window);
	gtk_application_set_accels_for_action(desktop->app, "app.new-chat", new_chat);
	gtk_application_set_accels_for_action(desktop->app, "app.settings", settings);
	gtk_application_set_accels_for_action(desktop->app, "app.quit", quit);
	GMenu *menu = g_menu_new();
	g_menu_append(menu, "New window", "app.new-window");
	g_menu_append(menu, "New chat", "app.new-chat");
	g_menu_append(menu, "Settings", "app.settings");
	g_menu_append(menu, "Quit", "app.quit");
	gtk_application_set_menubar(desktop->app, G_MENU_MODEL(menu));
	g_object_unref(menu);
}

static int hydra_desktop_run(const char *uri) {
	HydraDesktop desktop = { .uri = uri, .origin = g_uri_parse(uri, G_URI_FLAGS_NONE, NULL), .keep_running = TRUE };
	if (desktop.origin == NULL) return 2;
	GtkApplication *app = gtk_application_new("dev.hydra.Hydra", G_APPLICATION_HANDLES_COMMAND_LINE);
	g_signal_connect(app, "startup", G_CALLBACK(hydra_startup), &desktop);
	g_signal_connect(app, "activate", G_CALLBACK(hydra_activate), &desktop);
	g_signal_connect(app, "command-line", G_CALLBACK(hydra_command_line), &desktop);
	char *argv[] = { "hydra-desktop", (char *)uri, NULL };
	int status = g_application_run(G_APPLICATION(app), 2, argv);
	g_object_unref(app);
	g_uri_unref(desktop.origin);
	return status;
}

static gboolean hydra_desktop_keep_running(void) { return hydra_keep_running; }

static unsigned hydra_gtk_major(void) { return gtk_get_major_version(); }
static unsigned hydra_gtk_minor(void) { return gtk_get_minor_version(); }
static unsigned hydra_gtk_micro(void) { return gtk_get_micro_version(); }
static unsigned hydra_webkit_major(void) { return webkit_get_major_version(); }
static unsigned hydra_webkit_minor(void) { return webkit_get_minor_version(); }
static unsigned hydra_webkit_micro(void) { return webkit_get_micro_version(); }
*/
import "C"

import (
	"context"
	"fmt"
	"runtime"
	"time"
	"unsafe"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/daemon"
)

func run(rawURL string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	uri := C.CString(rawURL)
	defer C.free(unsafe.Pointer(uri))
	if status := C.hydra_desktop_run(uri); status != 0 {
		return errtrace.Wrap(fmt.Errorf("native application exited with status %d", int(status)))
	}
	if C.hydra_desktop_keep_running() == 0 && daemon.IsDesktopManaged("") {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := daemon.StopDaemon(ctx, ""); err != nil {
			return errtrace.Wrap(fmt.Errorf("stop desktop backend: %w", err))
		}
	}
	return nil
}

func nativeRuntimeDiagnostics() map[string]string {
	return map[string]string{
		"gtk":       fmt.Sprintf("%d.%d.%d", C.hydra_gtk_major(), C.hydra_gtk_minor(), C.hydra_gtk_micro()),
		"webkitgtk": fmt.Sprintf("%d.%d.%d", C.hydra_webkit_major(), C.hydra_webkit_minor(), C.hydra_webkit_micro()),
	}
}

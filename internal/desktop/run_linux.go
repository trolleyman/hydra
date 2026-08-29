//go:build linux && cgo && hydra_desktop

package desktop

/*
#cgo pkg-config: gtk4 webkitgtk-6.0

#include <gtk/gtk.h>
#include <stdlib.h>
#include <webkit/webkit.h>

typedef struct {
	GtkApplication *app;
	const char *uri;
	GUri *origin;
} HydraDesktop;

static gboolean hydra_same_origin(HydraDesktop *desktop, const char *candidate) {
	GUri *uri = g_uri_parse(candidate, G_URI_FLAGS_NONE, NULL);
	if (uri == NULL) return FALSE;
	const char *left_scheme = g_uri_get_scheme(desktop->origin);
	const char *right_scheme = g_uri_get_scheme(uri);
	const char *left_host = g_uri_get_host(desktop->origin);
	const char *right_host = g_uri_get_host(uri);
	gboolean same = g_strcmp0(left_scheme, right_scheme) == 0 &&
		g_ascii_strcasecmp(left_host, right_host) == 0 &&
		g_uri_get_port(desktop->origin) == g_uri_get_port(uri);
	g_uri_unref(uri);
	return same;
}

static gboolean hydra_decide_policy(WebKitWebView *web_view, WebKitPolicyDecision *decision,
	WebKitPolicyDecisionType type, gpointer data) {
	HydraDesktop *desktop = (HydraDesktop *)data;
	if (type != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION &&
		type != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) return FALSE;
	WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(
		WEBKIT_NAVIGATION_POLICY_DECISION(decision));
	WebKitURIRequest *request = webkit_navigation_action_get_request(action);
	const char *uri = webkit_uri_request_get_uri(request);
	if (hydra_same_origin(desktop, uri)) return FALSE;
	if (webkit_navigation_action_get_navigation_type(action) == WEBKIT_NAVIGATION_TYPE_LINK_CLICKED &&
		(g_str_has_prefix(uri, "http://") || g_str_has_prefix(uri, "https://"))) {
		g_app_info_launch_default_for_uri(uri, NULL, NULL);
	}
	webkit_policy_decision_ignore(decision);
	return TRUE;
}

static void hydra_open_window(HydraDesktop *desktop) {
	GtkApplication *app = desktop->app;
	GtkWidget *window = gtk_application_window_new(app);
	gtk_window_set_title(GTK_WINDOW(window), "Hydra");
	gtk_window_set_default_size(GTK_WINDOW(window), 1280, 820);

	WebKitWebView *web_view = WEBKIT_WEB_VIEW(webkit_web_view_new());
	g_signal_connect(web_view, "decide-policy", G_CALLBACK(hydra_decide_policy), desktop);
	gtk_window_set_child(GTK_WINDOW(window), GTK_WIDGET(web_view));
	webkit_web_view_load_uri(web_view, desktop->uri);
	gtk_window_present(GTK_WINDOW(window));
}

static void hydra_activate(GtkApplication *app, gpointer data) {
	HydraDesktop *desktop = (HydraDesktop *)data;
	desktop->app = app;
	hydra_open_window(desktop);
}

static void hydra_new_window(GSimpleAction *action, GVariant *parameter, gpointer data) {
	hydra_open_window((HydraDesktop *)data);
}

static int hydra_desktop_run(const char *uri) {
	HydraDesktop desktop = {
		.uri = uri,
		.origin = g_uri_parse(uri, G_URI_FLAGS_NONE, NULL),
	};
	if (desktop.origin == NULL) return 2;
	GtkApplication *app = gtk_application_new(
		"dev.hydra.Hydra",
		G_APPLICATION_DEFAULT_FLAGS
	);
	const GActionEntry actions[] = {
		{ "new-window", hydra_new_window, NULL, NULL, NULL },
	};
	g_action_map_add_action_entries(G_ACTION_MAP(app), actions, G_N_ELEMENTS(actions), &desktop);
	const char *new_window_accels[] = { "<Primary>n", NULL };
	gtk_application_set_accels_for_action(app, "app.new-window", new_window_accels);
	g_signal_connect(app, "activate", G_CALLBACK(hydra_activate), &desktop);
	int status = g_application_run(G_APPLICATION(app), 0, NULL);
	g_object_unref(app);
	g_uri_unref(desktop.origin);
	return status;
}
*/
import "C"

import (
	"braces.dev/errtrace"
	"fmt"
	"runtime"
	"unsafe"
)

func run(rawURL string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	uri := C.CString(rawURL)
	defer C.free(unsafe.Pointer(uri))
	if status := C.hydra_desktop_run(uri); status != 0 {
		return errtrace.Wrap(fmt.Errorf("native application exited with status %d", int(status)))
	}
	return nil
}

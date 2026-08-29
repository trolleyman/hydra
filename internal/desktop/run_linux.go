//go:build linux && cgo && hydra_desktop

package desktop

/*
#cgo pkg-config: gtk4 webkitgtk-6.0

#include <gtk/gtk.h>
#include <stdlib.h>
#include <webkit/webkit.h>

static void hydra_activate(GtkApplication *app, gpointer data) {
	const char *uri = (const char *)data;
	GtkWidget *window = gtk_application_window_new(app);
	gtk_window_set_title(GTK_WINDOW(window), "Hydra");
	gtk_window_set_default_size(GTK_WINDOW(window), 1280, 820);

	WebKitWebView *web_view = WEBKIT_WEB_VIEW(webkit_web_view_new());
	gtk_window_set_child(GTK_WINDOW(window), GTK_WIDGET(web_view));
	webkit_web_view_load_uri(web_view, uri);
	gtk_window_present(GTK_WINDOW(window));
}

static int hydra_desktop_run(const char *uri) {
	GtkApplication *app = gtk_application_new(
		"dev.hydra.Hydra",
		G_APPLICATION_DEFAULT_FLAGS
	);
	g_signal_connect(app, "activate", G_CALLBACK(hydra_activate), (gpointer)uri);
	int status = g_application_run(G_APPLICATION(app), 0, NULL);
	g_object_unref(app);
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

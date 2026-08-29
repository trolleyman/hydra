package desktop

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// DiagnosticReport is a machine-readable preflight report for support and
// package validation. Detail values explain how to restore missing capability.
type DiagnosticReport struct {
	OS            string                `json:"os"`
	Architecture  string                `json:"architecture"`
	Session       string                `json:"session,omitempty"`
	Display       string                `json:"display,omitempty"`
	NativeRuntime map[string]string     `json:"native_runtime"`
	Capabilities  map[string]Diagnostic `json:"capabilities"`
}

type Diagnostic struct {
	Available bool   `json:"available"`
	Detail    string `json:"detail"`
}

// Diagnostics reports dependencies the shell can inspect without starting the
// backend or opening a window.
func Diagnostics() DiagnosticReport {
	bus := os.Getenv("DBUS_SESSION_BUS_ADDRESS")
	notifications := Diagnostic{Available: bus != "", Detail: "DBUS_SESSION_BUS_ADDRESS is unavailable; native notifications require a desktop session bus"}
	if notifications.Available {
		notifications.Detail = "desktop session bus is available"
	}
	portal := portalDiagnostic(bus)
	return DiagnosticReport{
		OS: runtime.GOOS, Architecture: runtime.GOARCH,
		Session: os.Getenv("XDG_SESSION_TYPE"), Display: firstNonempty(os.Getenv("WAYLAND_DISPLAY"), os.Getenv("DISPLAY")),
		NativeRuntime: nativeRuntimeDiagnostics(),
		Capabilities:  map[string]Diagnostic{"folder_portal": portal, "notifications": notifications},
	}
}

func portalDiagnostic(bus string) Diagnostic {
	missing := Diagnostic{Detail: "the org.freedesktop.portal.Desktop session service is unavailable; install xdg-desktop-portal and the backend for your desktop"}
	if bus == "" {
		return missing
	}
	gdbus, err := exec.LookPath("gdbus")
	if err != nil {
		missing.Detail = "gdbus is unavailable, so the desktop portal could not be probed"
		return missing
	}
	output, err := exec.Command(gdbus, "call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.NameHasOwner", "org.freedesktop.portal.Desktop").CombinedOutput()
	if err == nil && strings.Contains(string(output), "true") {
		return Diagnostic{Available: true, Detail: "org.freedesktop.portal.Desktop is available"}
	}
	return missing
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

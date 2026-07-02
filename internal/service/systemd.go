// Package service renders the OS service definitions that `mage deploy:service`
// installs so a project's Hydra server comes up headless (on login/boot) instead
// of only in a foreground terminal. Today that's a systemd --user unit; the
// rendering is a pure function kept here (not in the magefile) so it can be
// unit-tested — the mage target itself does the file IO and can't be run in CI.
package service

import (
	"fmt"
	"sort"
	"strings"
)

// UnitOpts describes the systemd unit to render.
type UnitOpts struct {
	// ProjectRoot is the working directory hydra resolves its project from.
	ProjectRoot string
	// BinPath is the absolute path to the installed hydra binary.
	BinPath string
	// Description is a short human label (usually the project dir name).
	Description string
	// Env is the set of Environment= entries (HYDRA_API_ADDR, HYDRA_PASTA, PATH,
	// ...). Rendered in sorted key order for a stable, diffable unit file.
	Env map[string]string
}

// RenderSystemdUnit returns the contents of a systemd --user service unit that
// runs `hydra server` for one project, restarts on failure, and is wanted by the
// default (login/linger) target. It waits for the network so the 0.0.0.0 bind
// succeeds at boot.
func RenderSystemdUnit(o UnitOpts) string {
	keys := make([]string, 0, len(o.Env))
	for k := range o.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var env strings.Builder
	for _, k := range keys {
		fmt.Fprintf(&env, "Environment=%s\n", systemdEnvValue(k, o.Env[k]))
	}

	return fmt.Sprintf(`[Unit]
Description=Hydra AI orchestration server (%s)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%s
ExecStart=%s server
%sRestart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`, o.Description, o.ProjectRoot, o.BinPath, env.String())
}

// systemdEnvValue formats a KEY=VALUE for an Environment= line, quoting the value
// when it contains whitespace so systemd doesn't split it into multiple
// assignments. (PATH normally has none, but WorkingDirectory-derived values might.)
func systemdEnvValue(key, value string) string {
	if strings.ContainsAny(value, " \t") {
		return fmt.Sprintf("%s=%q", key, value)
	}
	return key + "=" + value
}

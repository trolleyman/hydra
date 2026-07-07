package service

import (
	"strings"
	"testing"
)

func TestRenderSystemdUnit(t *testing.T) {
	unit := RenderSystemdUnit(UnitOpts{
		ProjectRoot: "/home/me/code/hydra",
		BinPath:     "/home/me/.local/bin/hydra",
		Description: "hydra",
		Env: map[string]string{
			"HYDRA_API_ADDR": "0.0.0.0:26600",
			"HYDRA_PASTA":    "/home/me/code/hydra/.hydra/local/bin/pasta",
			"PATH":           "/home/me/.local/bin:/usr/bin",
		},
	})

	for _, want := range []string{
		"ExecStart=/home/me/.local/bin/hydra server",
		"WorkingDirectory=/home/me/code/hydra",
		"Environment=HYDRA_API_ADDR=0.0.0.0:26600",
		"Environment=HYDRA_PASTA=/home/me/code/hydra/.hydra/local/bin/pasta",
		"Environment=PATH=/home/me/.local/bin:/usr/bin",
		"Restart=on-failure",
		"WantedBy=default.target",
	} {
		if !strings.Contains(unit, want) {
			t.Errorf("unit missing %q:\n%s", want, unit)
		}
	}

	// Env must be sorted for a stable, diffable file.
	addr := strings.Index(unit, "HYDRA_API_ADDR")
	pasta := strings.Index(unit, "HYDRA_PASTA")
	path := strings.Index(unit, "Environment=PATH")
	if !(addr < pasta && pasta < path) {
		t.Errorf("Environment entries not in sorted order: %s", unit)
	}
}

func TestRenderSystemdUnitQuotesSpaces(t *testing.T) {
	unit := RenderSystemdUnit(UnitOpts{
		ProjectRoot: "/tmp/p",
		BinPath:     "/tmp/hydra",
		Description: "p",
		Env:         map[string]string{"HYDRA_PASTA": "/opt/my tools/pasta"},
	})
	if !strings.Contains(unit, `Environment=HYDRA_PASTA="/opt/my tools/pasta"`) {
		t.Errorf("value with a space must be quoted:\n%s", unit)
	}
}

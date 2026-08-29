package http

import (
	"testing"

	"github.com/trolleyman/hydra/internal/config"
)

func TestShouldAutoRun(t *testing.T) {
	tests := []struct {
		name    string
		mode    config.AutoRunMode
		running bool
		want    bool
	}{
		{name: "default while running", running: true, want: true},
		{name: "always while running", mode: config.AutoRunAlways, running: true, want: true},
		{name: "settled while running", mode: config.AutoRunSettled, running: true, want: false},
		{name: "settled after run", mode: config.AutoRunSettled, want: true},
		{name: "never while running", mode: config.AutoRunNever, running: true, want: false},
		{name: "never after run", mode: config.AutoRunNever, want: false},
		{name: "unknown is safe default", mode: "typo", running: true, want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldAutoRun(tt.mode, tt.running); got != tt.want {
				t.Fatalf("shouldAutoRun(%q, %t) = %t, want %t", tt.mode, tt.running, got, tt.want)
			}
		})
	}
}

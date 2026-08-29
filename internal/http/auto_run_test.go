package http

import "testing"

func TestShouldAutoRun(t *testing.T) {
	tests := []struct {
		name    string
		mode    string
		running bool
		want    bool
	}{
		{name: "default while running", running: true, want: true},
		{name: "always while running", mode: "always", running: true, want: true},
		{name: "settled while running", mode: "settled", running: true, want: false},
		{name: "settled after run", mode: "settled", want: true},
		{name: "never while running", mode: "never", running: true, want: false},
		{name: "never after run", mode: "never", want: false},
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

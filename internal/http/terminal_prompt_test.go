package http

import "testing"

func TestIsTerminalPromptSubmit(t *testing.T) {
	for _, tc := range []struct {
		name string
		data []byte
		want bool
	}{
		{name: "enter", data: []byte{'\r'}, want: true},
		{name: "shift enter", data: []byte{'\x1b', '\r'}},
		{name: "newline", data: []byte{'\n'}},
		{name: "pasted trailing enter", data: []byte("hello\r")},
		{name: "empty"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := isTerminalPromptSubmit(tc.data); got != tc.want {
				t.Fatalf("isTerminalPromptSubmit(%q) = %v, want %v", tc.data, got, tc.want)
			}
		})
	}
}

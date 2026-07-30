package selfupdate

import (
	"encoding/json"
	"testing"
)

// A log frame must always carry its `line`, even when the line is blank. The
// browser reads these frames as the ServerUpdateFrame union, where a log frame's
// `line` is REQUIRED - so an `omitempty` here (the generated default for an
// optional property, suppressed by x-omitempty in api/openapi.yaml) sends
// `{"kind":"log"}` for a blank line of `mage build` output, the client appends
// undefined to its log, and rendering that threw and took the whole app down.
func TestLogEventAlwaysCarriesLine(t *testing.T) {
	for _, tc := range []struct {
		name string
		ev   Event
		want string
	}{
		{"blank line", Event{Kind: KindLog, Line: ""}, `{"kind":"log","line":""}`},
		{"normal line", Event{Kind: KindLog, Line: "$ mage build"}, `{"kind":"log","line":"$ mage build"}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, err := json.Marshal(tc.ev)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(b) != tc.want {
				t.Errorf("got %s, want %s", b, tc.want)
			}
		})
	}
}

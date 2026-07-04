package config

import (
	"strings"
	"testing"
)

// TestIconRoundTrip checks that a top-level icon survives a render -> parse
// round-trip.
func TestIconRoundTrip(t *testing.T) {
	cfg := Config{Icon: strPtr("🚀")}

	out := renderConfig(nil, cfg)
	if !strings.Contains(out, `icon = "🚀"`) {
		t.Fatalf("rendered config missing icon:\n%s", out)
	}

	parsed, err := decodeConfig([]byte(out))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if parsed.Icon == nil || *parsed.Icon != "🚀" {
		t.Fatalf("round-tripped icon mismatch: %+v", parsed.Icon)
	}
}

// TestIconSurvivesUnrelatedSave checks that a hand-set icon is preserved by a
// save that doesn't carry it (e.g. the Settings UI's structured config save,
// which never sends the icon) - mirroring resume_prompt's preserve-if-nil rule.
func TestIconSurvivesUnrelatedSave(t *testing.T) {
	existing := []byte(strings.Join([]string{
		`icon = "Rocket"`,
		"",
		"[claude]",
		`model = "opus"`,
		"",
	}, "\n"))

	// A config save that doesn't carry the icon (Icon == nil) must not drop it.
	out := renderConfig(existing, Config{})
	if !strings.Contains(out, `icon = "Rocket"`) {
		t.Errorf("icon dropped on unrelated re-render:\n%s", out)
	}
}

// TestIconClear checks that an explicit empty icon is written (clearing it),
// rather than preserving the previous value.
func TestIconClear(t *testing.T) {
	existing := []byte("icon = \"Rocket\"\n")
	out := renderConfig(existing, Config{Icon: strPtr("")})
	if !strings.Contains(out, `icon = ""`) {
		t.Errorf("cleared icon not written as empty:\n%s", out)
	}
	if strings.Contains(out, `icon = "Rocket"`) {
		t.Errorf("cleared icon still shows old value:\n%s", out)
	}
}

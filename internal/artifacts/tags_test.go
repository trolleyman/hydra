package artifacts

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeTags(t *testing.T) {
	tests := []struct {
		name     string
		in       []string
		wantTags []string
		wantWarn int // number of warnings expected
	}{
		{
			name:     "free-form deduped and sorted",
			in:       []string{"wip", "needs-review", "wip", "  ", ""},
			wantTags: []string{"needs-review", "wip"},
		},
		{
			name:     "scoped last value wins, with warning",
			in:       []string{"theme::light", "theme::dark"},
			wantTags: []string{"theme::dark"},
			wantWarn: 1,
		},
		{
			name:     "single scoped value, no warning",
			in:       []string{"viewport::phone"},
			wantTags: []string{"viewport::phone"},
		},
		{
			name:     "mixed scoped + free",
			in:       []string{"viewport::desktop", "new", "theme::light"},
			wantTags: []string{"new", "theme::light", "viewport::desktop"},
		},
		{
			name:     "whitespace around scope is trimmed",
			in:       []string{" theme :: dark "},
			wantTags: []string{"theme::dark"},
		},
		{
			name:     "malformed scoped tag kept as free-form",
			in:       []string{"theme::", "::dark"},
			wantTags: []string{"::dark", "theme::"},
		},
		{
			name:     "distinct categories independent",
			in:       []string{"theme::dark", "viewport::phone", "theme::light"},
			wantTags: []string{"theme::light", "viewport::phone"},
			wantWarn: 1, // only the theme category conflicts
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tags, warnings := normalizeTags(tt.in)
			if !reflect.DeepEqual(tags, tt.wantTags) {
				t.Errorf("tags = %#v, want %#v", tags, tt.wantTags)
			}
			if len(warnings) != tt.wantWarn {
				t.Errorf("warnings = %d (%v), want %d", len(warnings), warnings, tt.wantWarn)
			}
		})
	}
}

// TestScanOutputsReadsTagSidecars checks that scanOutputs attaches tags from a
// sibling <file>.meta JSON, surfaces a warning for a scoped-label conflict, and
// leaves a tagless file with no tags.
func TestScanOutputsReadsTagSidecars(t *testing.T) {
	m := NewManager(t.TempDir())
	const script, key = "shot", "cabc"
	dir := m.entryDir(script, key)

	writeArtifact(t, m, script, key, "home.png", []byte("PNG"))
	writeArtifact(t, m, script, key, "about.png", []byte("PNG"))
	// home.png is tagged (with a deliberate theme conflict to exercise the warning);
	// about.png is left untagged.
	if err := os.WriteFile(filepath.Join(dir, "home.png.meta"),
		[]byte(`{"tags": ["theme::light", "theme::dark", "viewport::desktop"]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	files, warnings, err := scanOutputs(dir)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string][]string{}
	for _, f := range files {
		byName[f.Name] = f.Tags
	}
	// The .meta sidecar must not be collected as an artifact file.
	if _, ok := byName["home.png.meta"]; ok {
		t.Error("sidecar .meta file was collected as an artifact")
	}
	if want := []string{"theme::dark", "viewport::desktop"}; !reflect.DeepEqual(byName["home.png"], want) {
		t.Errorf("home.png tags = %#v, want %#v", byName["home.png"], want)
	}
	if len(byName["about.png"]) != 0 {
		t.Errorf("about.png should have no tags, got %#v", byName["about.png"])
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "home.png") || !strings.Contains(warnings[0], "theme") {
		t.Errorf("want one warning mentioning home.png + theme, got %v", warnings)
	}
}

// TestScanOutputsMalformedSidecar checks that invalid sidecar JSON warns rather
// than failing the scan, and the file still appears (untagged).
func TestScanOutputsMalformedSidecar(t *testing.T) {
	m := NewManager(t.TempDir())
	const script, key = "shot", "cdef"
	dir := m.entryDir(script, key)

	writeArtifact(t, m, script, key, "home.png", []byte("PNG"))
	if err := os.WriteFile(filepath.Join(dir, "home.png.meta"), []byte(`{not json`), 0o644); err != nil {
		t.Fatal(err)
	}

	files, warnings, err := scanOutputs(dir)
	if err != nil {
		t.Fatalf("scan should not fail on bad sidecar: %v", err)
	}
	if len(files) != 1 || files[0].Name != "home.png" || len(files[0].Tags) != 0 {
		t.Errorf("want one untagged home.png, got %#v", files)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "malformed") {
		t.Errorf("want one 'malformed' warning, got %v", warnings)
	}
}

// TestCompareTagsPreferHead checks that a file present on both sides takes its
// tags from the head (right) side, and a removed file falls back to the base.
func TestCompareTagsPreferHead(t *testing.T) {
	left := []FileMeta{
		{Name: "home.png", Hash: "a", Tags: []string{"theme::light"}},
		{Name: "gone.png", Hash: "b", Tags: []string{"theme::light"}},
	}
	right := []FileMeta{
		{Name: "home.png", Hash: "a", Tags: []string{"theme::dark"}},
	}
	tagsByName := map[string][]string{}
	for _, d := range Compare(left, right) {
		tagsByName[d.Name] = d.Tags
	}
	if got := tagsByName["home.png"]; !reflect.DeepEqual(got, []string{"theme::dark"}) {
		t.Errorf("home.png tags = %#v, want head side [theme::dark]", got)
	}
	if got := tagsByName["gone.png"]; !reflect.DeepEqual(got, []string{"theme::light"}) {
		t.Errorf("gone.png tags = %#v, want base side [theme::light]", got)
	}
}

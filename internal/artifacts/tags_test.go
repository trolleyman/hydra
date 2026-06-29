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
	const script, key = "shot", "commit/abc"
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
	const script, key = "shot", "commit/def"
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

// TestCompareTagsMerge checks that a file's diff tags are the union of both
// sides: a shared scoped category resolves to the head (right) value, a category
// present on only one side is kept, free-form tags from either side are unioned,
// and a one-sided file passes its tags through.
func TestCompareTagsMerge(t *testing.T) {
	left := []FileMeta{
		// home.png is re-themed and loses a free-form tag the base had; it keeps the
		// base-only viewport category and the head-only "new" tag.
		{Name: "home.png", Hash: "a", Tags: []string{"theme::light", "viewport::phone", "wip"}},
		{Name: "gone.png", Hash: "b", Tags: []string{"theme::light"}},
	}
	right := []FileMeta{
		{Name: "home.png", Hash: "a", Tags: []string{"theme::dark", "new"}},
		{Name: "added.png", Hash: "c", Tags: []string{"theme::dark"}},
	}
	tagsByName := map[string][]string{}
	for _, d := range Compare(left, right) {
		tagsByName[d.Name] = d.Tags
	}
	if got, want := tagsByName["home.png"], []string{"new", "theme::dark", "viewport::phone", "wip"}; !reflect.DeepEqual(got, want) {
		t.Errorf("home.png tags = %#v, want union with head-scoped winner %#v", got, want)
	}
	if got := tagsByName["gone.png"]; !reflect.DeepEqual(got, []string{"theme::light"}) {
		t.Errorf("gone.png tags = %#v, want base side [theme::light]", got)
	}
	if got := tagsByName["added.png"]; !reflect.DeepEqual(got, []string{"theme::dark"}) {
		t.Errorf("added.png tags = %#v, want head side [theme::dark]", got)
	}
}

// TestScanOutputsReadsFps checks that scanOutputs picks up an fps from the sidecar,
// leaves it zero when absent, and warns on (and ignores) a non-positive value.
func TestScanOutputsReadsFps(t *testing.T) {
	m := NewManager(t.TempDir())
	const script, key = "shot", "commit/fps"
	dir := m.entryDir(script, key)

	writeArtifact(t, m, script, key, "anim.webm", []byte("WEBM"))
	writeArtifact(t, m, script, key, "still.webm", []byte("WEBM"))
	writeArtifact(t, m, script, key, "bad.webm", []byte("WEBM"))
	if err := os.WriteFile(filepath.Join(dir, "anim.webm.meta"), []byte(`{"fps": 60}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// still.webm has a sidecar with no fps → fps stays zero (unset).
	if err := os.WriteFile(filepath.Join(dir, "still.webm.meta"), []byte(`{"tags": ["wip"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bad.webm.meta"), []byte(`{"fps": -5}`), 0o644); err != nil {
		t.Fatal(err)
	}

	files, warnings, err := scanOutputs(dir)
	if err != nil {
		t.Fatal(err)
	}
	fpsByName := map[string]float64{}
	for _, f := range files {
		fpsByName[f.Name] = f.Fps
	}
	if fpsByName["anim.webm"] != 60 {
		t.Errorf("anim.webm fps = %v, want 60", fpsByName["anim.webm"])
	}
	if fpsByName["still.webm"] != 0 {
		t.Errorf("still.webm fps = %v, want 0 (unset)", fpsByName["still.webm"])
	}
	if fpsByName["bad.webm"] != 0 {
		t.Errorf("bad.webm fps = %v, want 0 (non-positive ignored)", fpsByName["bad.webm"])
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "bad.webm") || !strings.Contains(warnings[0], "fps") {
		t.Errorf("want one warning mentioning bad.webm + fps, got %v", warnings)
	}
}

// TestCompareFps checks the diff fps prefers the head side, falls back to the
// base, and passes a one-sided file's value through.
func TestCompareFps(t *testing.T) {
	left := []FileMeta{
		{Name: "both.webm", Hash: "a", Fps: 30},
		{Name: "base-only.webm", Hash: "b", Fps: 24},
		{Name: "base-has-fps.webm", Hash: "x", Fps: 25},
	}
	right := []FileMeta{
		{Name: "both.webm", Hash: "a", Fps: 60},
		{Name: "head-only.webm", Hash: "c", Fps: 50},
		// head re-encode dropped the sidecar fps → falls back to the base's.
		{Name: "base-has-fps.webm", Hash: "y"},
	}
	fpsByName := map[string]float64{}
	for _, d := range Compare(left, right) {
		fpsByName[d.Name] = d.Fps
	}
	for name, want := range map[string]float64{
		"both.webm":         60, // head wins
		"base-only.webm":    24, // base passes through
		"head-only.webm":    50, // head passes through
		"base-has-fps.webm": 25, // head unset → base fallback
	} {
		if fpsByName[name] != want {
			t.Errorf("%s fps = %v, want %v", name, fpsByName[name], want)
		}
	}
}

// TestScanOutputsReadsDpi checks that scanOutputs picks up a dpi from the sidecar,
// leaves it zero when absent, and warns on (and ignores) a non-positive value.
func TestScanOutputsReadsDpi(t *testing.T) {
	m := NewManager(t.TempDir())
	const script, key = "shot", "commit/dpi"
	dir := m.entryDir(script, key)

	writeArtifact(t, m, script, key, "retina.webm", []byte("WEBM"))
	writeArtifact(t, m, script, key, "plain.webm", []byte("WEBM"))
	writeArtifact(t, m, script, key, "bad.webm", []byte("WEBM"))
	if err := os.WriteFile(filepath.Join(dir, "retina.webm.meta"), []byte(`{"dpi": 2}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// plain.webm has a sidecar with no dpi → dpi stays zero (unset → treated as 1).
	if err := os.WriteFile(filepath.Join(dir, "plain.webm.meta"), []byte(`{"tags": ["wip"]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "bad.webm.meta"), []byte(`{"dpi": -1}`), 0o644); err != nil {
		t.Fatal(err)
	}

	files, warnings, err := scanOutputs(dir)
	if err != nil {
		t.Fatal(err)
	}
	dpiByName := map[string]float64{}
	for _, f := range files {
		dpiByName[f.Name] = f.Dpi
	}
	if dpiByName["retina.webm"] != 2 {
		t.Errorf("retina.webm dpi = %v, want 2", dpiByName["retina.webm"])
	}
	if dpiByName["plain.webm"] != 0 {
		t.Errorf("plain.webm dpi = %v, want 0 (unset)", dpiByName["plain.webm"])
	}
	if dpiByName["bad.webm"] != 0 {
		t.Errorf("bad.webm dpi = %v, want 0 (non-positive ignored)", dpiByName["bad.webm"])
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "bad.webm") || !strings.Contains(warnings[0], "dpi") {
		t.Errorf("want one warning mentioning bad.webm + dpi, got %v", warnings)
	}
}

// TestCompareDpi checks the diff dpi prefers the head side, falls back to the base,
// and passes a one-sided file's value through.
func TestCompareDpi(t *testing.T) {
	left := []FileMeta{
		{Name: "both.png", Hash: "a", Dpi: 1},
		{Name: "base-only.png", Hash: "b", Dpi: 2},
		{Name: "base-has-dpi.png", Hash: "x", Dpi: 2},
	}
	right := []FileMeta{
		{Name: "both.png", Hash: "a", Dpi: 2},
		{Name: "head-only.png", Hash: "c", Dpi: 2},
		// head re-render dropped the sidecar dpi → falls back to the base's.
		{Name: "base-has-dpi.png", Hash: "y"},
	}
	dpiByName := map[string]float64{}
	for _, d := range Compare(left, right) {
		dpiByName[d.Name] = d.Dpi
	}
	for name, want := range map[string]float64{
		"both.png":         2, // head wins
		"base-only.png":    2, // base passes through
		"head-only.png":    2, // head passes through
		"base-has-dpi.png": 2, // head unset → base fallback
	} {
		if dpiByName[name] != want {
			t.Errorf("%s dpi = %v, want %v", name, dpiByName[name], want)
		}
	}
}

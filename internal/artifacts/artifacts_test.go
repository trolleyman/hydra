package artifacts

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/sandbox"
)

func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@e",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@e")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hi\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", ".")
	run("commit", "-q", "-m", "init")
	return dir
}

// waitReady polls Get until the entry leaves the generating state.
func waitReady(t *testing.T, m *Manager, spec config.ArtifactScript, v Version) Meta {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for {
		meta, err := m.Get(spec, v)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if meta.Status != StatusGenerating {
			return meta
		}
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for artifact generation")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestGenerateAndCache(t *testing.T) {
	repo := initRepo(t)
	m := NewManager(repo)
	// This test exercises generation/caching/cleanup, not confinement, so it runs
	// the command on the host (UnsafeHost) to stay independent of whether bwrap
	// can create a sandbox here. The sandboxed path is covered by
	// TestGenerateSandboxed.
	spec := config.ArtifactScript{
		Name:       "shots",
		Command:    `printf 'PNGDATA' > "$HYDRA_ARTIFACT_OUTPUT/home.png"`,
		UnsafeHost: true,
	}

	meta := waitReady(t, m, spec, Version{Ref: "HEAD"})
	if meta.Status != StatusReady {
		t.Fatalf("status = %s, error = %s", meta.Status, meta.Error)
	}
	if len(meta.Files) != 1 || meta.Files[0].Name != "home.png" {
		t.Fatalf("files = %+v", meta.Files)
	}
	if meta.Files[0].Hash == "" || meta.Files[0].Size != 7 {
		t.Fatalf("file meta = %+v", meta.Files[0])
	}

	// Second call is a cache hit (ready immediately, no generation).
	again, err := m.Get(spec, Version{Ref: "HEAD"})
	if err != nil {
		t.Fatal(err)
	}
	if again.Status != StatusReady {
		t.Fatalf("expected cache hit ready, got %s", again.Status)
	}

	// The ephemeral checkout subdir must be cleaned up (the .gitignore stays).
	entries, _ := os.ReadDir(m.checkoutsDir())
	for _, e := range entries {
		if e.IsDir() {
			t.Errorf("checkout not cleaned: %s", e.Name())
		}
	}
}

func TestGenerateError(t *testing.T) {
	repo := initRepo(t)
	m := NewManager(repo)
	spec := config.ArtifactScript{Name: "broken", Command: "echo boom >&2; exit 3", UnsafeHost: true}

	meta := waitReady(t, m, spec, Version{Ref: "HEAD"})
	if meta.Status != StatusError {
		t.Fatalf("expected error status, got %s", meta.Status)
	}
	if meta.Error == "" {
		t.Error("expected error message")
	}
}

// TestInvalidateRegenerates verifies that a cached failure is discarded by
// Invalidate so the next Get re-runs the script (the "refresh" path), and that a
// successful result regenerates the same way.
func TestInvalidateRegenerates(t *testing.T) {
	repo := initRepo(t)
	m := NewManager(repo)
	v := Version{Ref: "HEAD"}

	// First run fails and the failure is cached on disk.
	failSpec := config.ArtifactScript{Name: "shots", Command: "exit 3", UnsafeHost: true}
	if meta := waitReady(t, m, failSpec, v); meta.Status != StatusError {
		t.Fatalf("expected cached error, got %s", meta.Status)
	}
	key, _, err := m.versionKey(v)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := readMeta(m.entryDir("shots", key)); !ok {
		t.Fatal("expected meta on disk after failed generation")
	}

	// Invalidate drops the cached entry...
	if err := m.Invalidate("shots", v); err != nil {
		t.Fatalf("Invalidate: %v", err)
	}
	if _, ok := readMeta(m.entryDir("shots", key)); ok {
		t.Fatal("expected cache entry removed after Invalidate")
	}

	// ...so the next Get regenerates. Use a now-succeeding command (same name) to
	// confirm the result is freshly produced, not served from the stale failure.
	okSpec := config.ArtifactScript{Name: "shots", Command: `printf 'PNGDATA' > "$HYDRA_ARTIFACT_OUTPUT/home.png"`, UnsafeHost: true}
	if meta := waitReady(t, m, okSpec, v); meta.Status != StatusReady {
		t.Fatalf("expected ready after refresh, got %s (%s)", meta.Status, meta.Error)
	}

	// Invalidating a never-generated script is a no-op, not an error.
	if err := m.Invalidate("nope", v); err != nil {
		t.Fatalf("Invalidate of absent entry: %v", err)
	}
}

// TestGenerateSandboxed exercises the default (sandboxed) path: the command runs
// inside bwrap with the output dir bound writable. Skipped where unprivileged
// user namespaces are unavailable (e.g. nested sandboxes / hardened kernels).
func TestGenerateSandboxed(t *testing.T) {
	if ok, why := sandbox.Available(); !ok {
		t.Skipf("sandbox unavailable: %s", why)
	}
	repo := initRepo(t)
	m := NewManager(repo)
	spec := config.ArtifactScript{
		Name:    "shots",
		Command: `printf 'PNGDATA' > "$HYDRA_ARTIFACT_OUTPUT/home.png"`,
	}

	meta := waitReady(t, m, spec, Version{Ref: "HEAD"})
	if meta.Status != StatusReady {
		t.Fatalf("status = %s, error = %s", meta.Status, meta.Error)
	}
	if len(meta.Files) != 1 || meta.Files[0].Name != "home.png" || meta.Files[0].Size != 7 {
		t.Fatalf("files = %+v", meta.Files)
	}
}

func TestBlobPath(t *testing.T) {
	m := NewManager(t.TempDir())

	// Valid request resolves to a path inside the entry dir.
	got, ct, err := m.BlobPath("shots", "cabc123", "sub/home.png")
	if err != nil {
		t.Fatalf("valid blob path rejected: %v", err)
	}
	if ct != "image/png" {
		t.Errorf("content type = %q", ct)
	}
	base := m.entryDir("shots", "cabc123")
	if rel, _ := filepath.Rel(base, got); rel != filepath.FromSlash("sub/home.png") {
		t.Errorf("resolved outside base: %q", got)
	}

	// Rejections.
	if _, _, err := m.BlobPath("shots", "nothex!", "home.png"); err == nil {
		t.Error("expected bad-key rejection")
	}
	if _, _, err := m.BlobPath("shots", "cabc123", "home.txt"); err == nil {
		t.Error("expected unsupported-type rejection")
	}

	// Traversal attempts must stay contained within the entry dir (rooted, not escaping).
	for _, file := range []string{"../../etc/passwd.png", "/etc/passwd.png", "a/../../b.png"} {
		p, _, err := m.BlobPath("shots", "cabc123", file)
		if err != nil {
			continue // rejected outright is also fine
		}
		if rel, _ := filepath.Rel(base, p); rel == ".." || filepath.IsAbs(rel) || hasDotDotPrefix(rel) {
			t.Errorf("traversal %q escaped base: %q", file, p)
		}
	}
}

func hasDotDotPrefix(rel string) bool {
	return rel == ".." || (len(rel) >= 3 && rel[:3] == ".."+string(filepath.Separator))
}

func TestCompare(t *testing.T) {
	left := []FileMeta{
		{Name: "a.png", Hash: "1"},
		{Name: "b.png", Hash: "2"},
		{Name: "c.png", Hash: "3"},
	}
	right := []FileMeta{
		{Name: "a.png", Hash: "1"}, // unchanged
		{Name: "b.png", Hash: "9"}, // modified
		{Name: "d.png", Hash: "4"}, // added (c removed)
	}
	deltas := Compare(left, right)
	got := map[string]ChangeType{}
	for _, d := range deltas {
		got[d.Name] = d.Change
	}
	want := map[string]ChangeType{
		"a.png": ChangeUnchanged,
		"b.png": ChangeModified,
		"c.png": ChangeRemoved,
		"d.png": ChangeAdded,
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s: got %s want %s", name, got[name], w)
		}
	}
	if !AnyChanged(deltas) {
		t.Error("expected AnyChanged true")
	}
	if AnyChanged(Compare(left, left)) {
		t.Error("expected AnyChanged false for identical lists")
	}
}

func encodePNG(t *testing.T, img image.Image, level png.CompressionLevel) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: level}
	if err := enc.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func writeArtifact(t *testing.T, m *Manager, script, key, name string, data []byte) {
	t.Helper()
	dir := m.entryDir(script, key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestManagerComparePixelEqual checks that a file whose bytes differ but whose
// decoded pixels are identical is reported as unchanged, while genuinely
// different pixels (and non-decodable files) stay modified.
func TestManagerComparePixelEqual(t *testing.T) {
	m := NewManager(t.TempDir())
	const script = "shot"

	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for y := range 8 {
		for x := range 8 {
			img.Set(x, y, color.RGBA{uint8(x * 32), uint8(y * 32), 64, 255})
		}
	}
	// Same pixels, different bytes (different compression level).
	defaultPNG := encodePNG(t, img, png.DefaultCompression)
	fastPNG := encodePNG(t, img, png.BestSpeed)
	if bytes.Equal(defaultPNG, fastPNG) {
		t.Fatal("expected differing PNG bytes for the two compression levels")
	}

	// A genuinely different image.
	other := image.NewRGBA(image.Rect(0, 0, 8, 8))
	otherPNG := encodePNG(t, other, png.DefaultCompression)

	writeArtifact(t, m, script, "cleft", "same.png", defaultPNG)
	writeArtifact(t, m, script, "cleft", "diff.png", defaultPNG)
	writeArtifact(t, m, script, "cleft", "note.svg", []byte("<svg>a</svg>"))
	writeArtifact(t, m, script, "cright", "same.png", fastPNG)
	writeArtifact(t, m, script, "cright", "diff.png", otherPNG)
	writeArtifact(t, m, script, "cright", "note.svg", []byte("<svg>b</svg>"))

	leftFiles, err := scanOutputs(m.entryDir(script, "cleft"))
	if err != nil {
		t.Fatal(err)
	}
	rightFiles, err := scanOutputs(m.entryDir(script, "cright"))
	if err != nil {
		t.Fatal(err)
	}
	left := Meta{Script: script, Key: "cleft", Files: leftFiles}
	right := Meta{Script: script, Key: "cright", Files: rightFiles}

	got := map[string]ChangeType{}
	for _, d := range m.Compare(left, right) {
		got[d.Name] = d.Change
	}
	want := map[string]ChangeType{
		"same.png": ChangeUnchanged, // byte-different, pixel-identical
		"diff.png": ChangeModified,  // pixels differ
		"note.svg": ChangeModified,  // not decodable, byte hash differs
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s: got %s want %s", name, got[name], w)
		}
	}
}

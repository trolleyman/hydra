// Package artifacts generates, caches, and serves per-project "visual
// artifacts" (e.g. screenshots) for the diff viewer.
//
// A project configures one or more [config.ArtifactScript]s. For a given side
// of a diff (a commit ref, or the head's uncommitted working tree) the manager
// checks out the relevant source, runs the script against it, and collects the
// image files it writes. Results are cached on disk under
// .hydra/artifacts/out/<script>/<version-key> (gitignored, never committed) and
// keyed by an immutable version identifier (the resolved commit SHA, or a hash
// of the working-tree state), so repeat views are free.
//
// Generation runs in the background: Get returns immediately with a
// "generating" status while a goroutine does the (potentially slow) work, a
// per-entry lock collapses duplicate concurrent requests for the same version,
// and a semaphore bounds how many generations run at once.
//
// Security note: scripts run *inside the OS sandbox* (the same bubblewrap /
// sandbox-exec confinement agents get), not on the host. The command string is
// trusted (it comes from the project's live config, not the checked-out ref),
// but it executes against an attacker-controllable checkout — build tooling and
// package lifecycle scripts run the diffed ref's own code — so confining it is
// what keeps a malicious branch from escaping onto the host. The checkout dir,
// the artifact output dir, the dev caches and the git common dir are writable;
// credentials are masked; network is on (cold installs need it). A script can
// opt out with `unsafe_host = true` in config, which runs it unconfined on the
// host — only safe for self-contained, audited commands. See buildCommandSpec.
package artifacts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	_ "image/gif"  // register GIF decoder for pixel comparison
	_ "image/jpeg" // register JPEG decoder for pixel comparison
	_ "image/png"  // register PNG decoder for pixel comparison
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
)

const (
	metaFile       = "meta.json"
	defaultTimeout = 5 * time.Minute
	// DefaultMaxAge and DefaultMaxBytes bound the on-disk artifact cache.
	DefaultMaxAge   = 7 * 24 * time.Hour
	DefaultMaxBytes = int64(2) << 30 // 2 GiB
	// maxConcurrentGen caps how many generations run at once. Generations are
	// heavy (a full build per ref) and run untrusted ref code, so distinct refs
	// must not fan out without bound. A normal diff view (left+right of one
	// script) saturates this; further requests queue behind the per-entry lock.
	maxConcurrentGen = 2
)

// imageExts maps collectible output extensions to their content types.
var imageExts = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg":  "image/svg+xml",
	".bmp":  "image/bmp",
	".pdf":  "application/pdf",
}

// Status is the generation state of a cache entry.
type Status string

const (
	StatusReady      Status = "ready"
	StatusGenerating Status = "generating"
	StatusError      Status = "error"
)

// FileMeta describes a single generated artifact file.
type FileMeta struct {
	Name string `json:"name"` // path relative to the entry dir, forward-slashed
	Size int64  `json:"size"`
	Hash string `json:"hash"` // sha256 hex of the file contents
}

// Meta is the persisted (and returned) description of one cache entry.
type Meta struct {
	Script    string     `json:"script"`
	Key       string     `json:"key"`
	Ref       string     `json:"ref,omitempty"`
	Status    Status     `json:"status"`
	Error     string     `json:"error,omitempty"`
	Files     []FileMeta `json:"files,omitempty"`
	UpdatedAt int64      `json:"updated_at"`
}

// ChangeType classifies an artifact file across the two compared versions.
type ChangeType string

const (
	ChangeAdded     ChangeType = "added"     // present only on the right
	ChangeRemoved   ChangeType = "removed"   // present only on the left
	ChangeModified  ChangeType = "modified"  // present on both, contents differ
	ChangeUnchanged ChangeType = "unchanged" // present on both, identical
)

// FileDelta is the result of matching one artifact file (by name) across the
// left and right versions.
type FileDelta struct {
	Name    string
	Change  ChangeType
	InLeft  bool
	InRight bool
}

// Compare matches files by name across two versions' file lists and classifies
// each as added/removed/modified/unchanged. The result is sorted by name.
func Compare(left, right []FileMeta) []FileDelta {
	leftHash := make(map[string]string, len(left))
	rightHash := make(map[string]string, len(right))
	names := map[string]struct{}{}
	for _, f := range left {
		leftHash[f.Name] = f.Hash
		names[f.Name] = struct{}{}
	}
	for _, f := range right {
		rightHash[f.Name] = f.Hash
		names[f.Name] = struct{}{}
	}
	ordered := make([]string, 0, len(names))
	for n := range names {
		ordered = append(ordered, n)
	}
	sort.Strings(ordered)

	out := make([]FileDelta, 0, len(ordered))
	for _, name := range ordered {
		lh, inLeft := leftHash[name]
		rh, inRight := rightHash[name]
		d := FileDelta{Name: name, InLeft: inLeft, InRight: inRight}
		switch {
		case inLeft && !inRight:
			d.Change = ChangeRemoved
		case !inLeft && inRight:
			d.Change = ChangeAdded
		case lh != rh:
			d.Change = ChangeModified
		default:
			d.Change = ChangeUnchanged
		}
		out = append(out, d)
	}
	return out
}

// AnyChanged reports whether any file differs between the two versions.
func AnyChanged(deltas []FileDelta) bool {
	for _, d := range deltas {
		if d.Change != ChangeUnchanged {
			return true
		}
	}
	return false
}

// Compare classifies artifact files across two cache entries like the package
// [Compare], but refines the byte-hash verdict with a pixel-level check: a file
// flagged ChangeModified is downgraded to ChangeUnchanged when both sides decode
// to images with identical dimensions and pixels. This keeps cosmetic
// re-encodings (different compression level, added metadata/EXIF, timestamp
// chunks) from surfacing as visual changes while still catching any real pixel
// difference.
//
// Only formats the standard library can decode (PNG, JPEG, GIF) get the pixel
// check; other types — and any file that fails to decode — keep the byte-hash
// verdict.
func (m *Manager) Compare(left, right Meta) []FileDelta {
	deltas := Compare(left.Files, right.Files)
	for i := range deltas {
		d := &deltas[i]
		if d.Change != ChangeModified {
			continue
		}
		lp := filepath.Join(m.entryDir(left.Script, left.Key), filepath.FromSlash(d.Name))
		rp := filepath.Join(m.entryDir(right.Script, right.Key), filepath.FromSlash(d.Name))
		if equal, err := imagesPixelEqual(lp, rp); err == nil && equal {
			d.Change = ChangeUnchanged
		}
	}
	return deltas
}

// imagesPixelEqual reports whether two image files decode to the same dimensions
// and pixels. A decode failure (unsupported format, corrupt file) returns an
// error so the caller can fall back to the byte-hash verdict.
func imagesPixelEqual(leftPath, rightPath string) (bool, error) {
	la, err := decodeImage(leftPath)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	ra, err := decodeImage(rightPath)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	lb, rb := la.Bounds(), ra.Bounds()
	if lb.Dx() != rb.Dx() || lb.Dy() != rb.Dy() {
		return false, nil
	}
	// Fast path: same concrete type with byte-identical pixel buffers.
	if equalRawPix(la, ra) {
		return true, nil
	}
	// General path: compare pixel-by-pixel in RGBA space, aligning the two
	// (possibly differently-originated) coordinate systems.
	ox, oy := rb.Min.X-lb.Min.X, rb.Min.Y-lb.Min.Y
	for y := lb.Min.Y; y < lb.Max.Y; y++ {
		for x := lb.Min.X; x < lb.Max.X; x++ {
			lr, lg, lbl, laa := la.At(x, y).RGBA()
			rr, rg, rbl, raa := ra.At(x+ox, y+oy).RGBA()
			if lr != rr || lg != rg || lbl != rbl || laa != raa {
				return false, nil
			}
		}
	}
	return true, nil
}

func decodeImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, errtrace.Wrap(err)
}

// equalRawPix is a fast path that reports true only when two images share the
// same concrete pixel type and byte-identical pixel buffers. A false result
// means "unknown" — the caller falls back to the general per-pixel comparison.
func equalRawPix(a, b image.Image) bool {
	switch av := a.(type) {
	case *image.RGBA:
		if bv, ok := b.(*image.RGBA); ok {
			return av.Stride == bv.Stride && av.Rect == bv.Rect && bytes.Equal(av.Pix, bv.Pix)
		}
	case *image.NRGBA:
		if bv, ok := b.(*image.NRGBA); ok {
			return av.Stride == bv.Stride && av.Rect == bv.Rect && bytes.Equal(av.Pix, bv.Pix)
		}
	case *image.Gray:
		if bv, ok := b.(*image.Gray); ok {
			return av.Stride == bv.Stride && av.Rect == bv.Rect && bytes.Equal(av.Pix, bv.Pix)
		}
	}
	return false
}

// Version identifies one side of a comparison: either a committed ref (checked
// out into an ephemeral worktree) or an existing working-tree directory (run in
// place, for uncommitted changes).
type Version struct {
	Ref         string
	WorktreeDir string
}

// Manager owns artifact generation, caching, locking, and pruning for a project.
type Manager struct {
	projectRoot string

	mu   sync.Mutex
	gens map[string]struct{} // entry dirs with an in-flight generation
	sem  chan struct{}       // bounds concurrent generations (maxConcurrentGen)
}

// NewManager returns a Manager for the given project root.
func NewManager(projectRoot string) *Manager {
	m := &Manager{
		projectRoot: projectRoot,
		gens:        map[string]struct{}{},
		sem:         make(chan struct{}, maxConcurrentGen),
	}
	_ = paths.CreateGitignoreAllInDir(m.root())
	return m
}

func (m *Manager) root() string         { return paths.GetArtifactsDirFromProjectRoot(m.projectRoot) }
func (m *Manager) outDir() string       { return filepath.Join(m.root(), "out") }
func (m *Manager) checkoutsDir() string { return filepath.Join(m.root(), "checkouts") }

func (m *Manager) entryDir(script, key string) string {
	return filepath.Join(m.outDir(), sanitizeName(script), key)
}

// versionKey resolves a Version to a stable cache key and a human-readable ref.
func (m *Manager) versionKey(v Version) (key, ref string, err error) {
	if v.WorktreeDir != "" {
		h, err := git.WorktreeStateHash(v.WorktreeDir)
		if err != nil {
			return "", "", errtrace.Wrap(err)
		}
		return "w" + h, "working tree", nil
	}
	sha, err := git.ResolveRef(m.projectRoot, v.Ref)
	if err != nil {
		return "", "", errtrace.Wrap(err)
	}
	return "c" + sha, sha, nil
}

// Get returns the cache entry for (spec, v), starting a background generation
// if it is neither cached nor already in flight. A returned Meta with status
// StatusGenerating means the caller should poll again shortly.
func (m *Manager) Get(spec config.ArtifactScript, v Version) (Meta, error) {
	key, ref, err := m.versionKey(v)
	if err != nil {
		return Meta{}, errtrace.Wrap(err)
	}
	dir := m.entryDir(spec.Name, key)

	m.mu.Lock()
	// Cache hit on disk takes precedence (survives restarts).
	if meta, ok := readMeta(dir); ok {
		m.mu.Unlock()
		return meta, nil
	}
	if _, inFlight := m.gens[dir]; inFlight {
		m.mu.Unlock()
		return Meta{Script: spec.Name, Key: key, Ref: ref, Status: StatusGenerating}, nil
	}
	m.gens[dir] = struct{}{}
	m.mu.Unlock()

	go func() {
		// Bound concurrent generations. The entry stays marked in-flight while
		// queued, so duplicate requests keep getting StatusGenerating instead of
		// piling up more builds.
		m.sem <- struct{}{}
		defer func() { <-m.sem }()

		meta := m.generate(spec, v, key, ref)
		if err := writeMeta(dir, meta); err != nil {
			// Best-effort: a failed write just means the next request regenerates.
			_ = err
		}
		m.mu.Lock()
		delete(m.gens, dir)
		m.mu.Unlock()
	}()

	return Meta{Script: spec.Name, Key: key, Ref: ref, Status: StatusGenerating}, nil
}

// generate runs the script for one version and returns the resulting Meta.
func (m *Manager) generate(spec config.ArtifactScript, v Version, key, ref string) Meta {
	meta := Meta{Script: spec.Name, Key: key, Ref: ref, UpdatedAt: time.Now().Unix()}

	_ = paths.CreateGitignoreAllInDir(m.root())
	dir := m.entryDir(spec.Name, key)
	if err := os.RemoveAll(dir); err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}

	// Resolve the directory the script runs in.
	runDir := v.WorktreeDir
	if runDir == "" {
		co := filepath.Join(m.checkoutsDir(), key)
		_ = git.RemoveWorktree(m.projectRoot, co) // clear any stale checkout
		_ = os.RemoveAll(co)
		if err := git.AddDetachedWorktree(m.projectRoot, co, ref); err != nil {
			meta.Status, meta.Error = StatusError, fmt.Sprintf("checkout %s: %v", ref, err)
			return meta
		}
		defer func() {
			_ = git.RemoveWorktree(m.projectRoot, co)
			_ = os.RemoveAll(co)
		}()
		runDir = co
	}

	timeout := defaultTimeout
	if spec.TimeoutSec > 0 {
		timeout = time.Duration(spec.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	launch, err := m.buildCommandSpec(spec, runDir, dir, ref)
	if err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	defer launch.Cleanup()

	cmd := exec.CommandContext(ctx, launch.Path, launch.Args[1:]...) //errtrace:skip
	cmd.Dir = launch.Dir
	cmd.Env = launch.Env
	cmd.ExtraFiles = launch.ExtraFiles
	var stderr bytes.Buffer
	cmd.Stdout = io.Discard
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := err.Error()
		if ctx.Err() == context.DeadlineExceeded {
			msg = "timed out after " + timeout.String()
		}
		if tail := strings.TrimSpace(stderr.String()); tail != "" {
			msg += ": " + lastLines(tail, 15)
		}
		meta.Status, meta.Error = StatusError, msg
		return meta
	}

	files, err := scanOutputs(dir)
	if err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	meta.Files = files
	meta.Status = StatusReady
	meta.UpdatedAt = time.Now().Unix()
	return meta
}

// buildCommandSpec resolves the script command into a launch spec. By default
// it runs inside the OS sandbox (the same confinement agents get), because the
// command executes against an attacker-controllable checkout — the diffed ref's
// build tooling and package lifecycle scripts run its code. runDir (the
// checkout/working tree) and outputDir (HYDRA_ARTIFACT_OUTPUT) are writable
// along with the dev caches and the git common dir; credentials are masked; the
// network is on (cold `bun install`/`go mod download` need it, warm caches stay
// mostly offline) — matching the agent default. When spec.UnsafeHost is set the
// command runs unconfined on the host instead (sandbox.Options.NoSandbox).
func (m *Manager) buildCommandSpec(spec config.ArtifactScript, runDir, outputDir, ref string) (*sandbox.Spec, error) {
	home, _ := os.UserHomeDir()

	env := append([]string{}, os.Environ()...)
	if home != "" {
		env = append(env, "HOME="+home)
	}
	env = append(env,
		"HYDRA_ARTIFACT_OUTPUT="+outputDir,
		"HYDRA_ARTIFACT_SOURCE="+runDir,
		"HYDRA_ARTIFACT_REF="+ref,
	)
	// Trust the checkout's copied mise config when the host trusts the project's,
	// so mise-managed toolchains (go, bun, …) resolve inside the run dir.
	env = append(env, sandbox.MiseTrustEnv(m.projectRoot, runDir)...)

	opts := sandbox.Options{
		AgentType:    sandbox.AgentTypeBash, // a plain command, not an agent
		WorktreePath: runDir,                // always writable + chdir target
		Home:         home,
		Env:          env,
		Argv:         []string{"sh", "-c", spec.Command},
		NoSandbox:    spec.UnsafeHost,
	}

	if !spec.UnsafeHost {
		cfg, _ := config.Load(m.projectRoot)
		writable, masked, restore, _ := cfg.ResolveSandboxOptions("")
		// The artifact output dir lives outside the checkout, so make it writable
		// explicitly (the checkout itself is covered by WorktreePath).
		writable = append(writable, outputDir)
		if gcd, err := git.GetCommonDir(m.projectRoot); err == nil {
			opts.GitCommonDir = gcd // ephemeral worktree git metadata lives here
		}
		opts.WritablePaths = writable
		opts.MaskedPaths = masked
		opts.RestoreRO = restore
		opts.Network = sandbox.NetworkPolicy{Enabled: true}
		opts.HardenGUI = true
		opts.Seccomp = true
	}

	return errtrace.Wrap2(sandbox.BuildSpec(opts))
}

// keyRe matches valid cache keys produced by versionKey.
var keyRe = regexp.MustCompile(`^[cw][0-9a-f]+$`)

// BlobPath validates a (script, key, file) triple and returns the absolute
// on-disk path of the artifact file plus its content type. It guards against
// path traversal: the resolved path is guaranteed to stay within the entry dir.
func (m *Manager) BlobPath(script, key, file string) (path, contentType string, err error) {
	if !keyRe.MatchString(key) {
		return "", "", errtrace.Wrap(fmt.Errorf("invalid key"))
	}
	ext := strings.ToLower(filepath.Ext(file))
	ct, ok := imageExts[ext]
	if !ok {
		return "", "", errtrace.Wrap(fmt.Errorf("unsupported artifact type %q", ext))
	}
	base := m.entryDir(script, key)
	full := filepath.Join(base, filepath.FromSlash(filepath.Clean("/"+file)))
	rel, err := filepath.Rel(base, full)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", errtrace.Wrap(fmt.Errorf("invalid file path"))
	}
	return full, ct, nil
}

// CleanCheckouts removes leftover ephemeral checkouts. Safe to call on boot,
// before any generation is in flight.
func (m *Manager) CleanCheckouts() {
	_, _ = exec.Command("git", "-C", m.projectRoot, "worktree", "prune").Output()
	_ = os.RemoveAll(m.checkoutsDir())
}

// PruneStale removes cache entries older than maxAge, then removes the oldest
// remaining entries until the total cache size is under maxBytes. Entries with
// an in-flight generation are never touched.
func (m *Manager) PruneStale(maxAge time.Duration, maxBytes int64) error {
	type entry struct {
		dir     string
		modTime time.Time
		size    int64
	}
	var entries []entry

	scriptDirs, err := os.ReadDir(m.outDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return errtrace.Wrap(err)
	}

	m.mu.Lock()
	inFlight := make(map[string]struct{}, len(m.gens))
	for d := range m.gens {
		inFlight[d] = struct{}{}
	}
	m.mu.Unlock()

	cutoff := time.Now().Add(-maxAge)
	for _, sd := range scriptDirs {
		if !sd.IsDir() {
			continue
		}
		scriptPath := filepath.Join(m.outDir(), sd.Name())
		keyDirs, err := os.ReadDir(scriptPath)
		if err != nil {
			continue
		}
		for _, kd := range keyDirs {
			if !kd.IsDir() {
				continue
			}
			dir := filepath.Join(scriptPath, kd.Name())
			if _, busy := inFlight[dir]; busy {
				continue
			}
			size, modTime := dirStats(dir)
			if maxAge > 0 && modTime.Before(cutoff) {
				_ = os.RemoveAll(dir)
				continue
			}
			entries = append(entries, entry{dir: dir, modTime: modTime, size: size})
		}
	}

	if maxBytes > 0 {
		var total int64
		for _, e := range entries {
			total += e.size
		}
		if total > maxBytes {
			// Evict oldest-first until under the cap.
			sort.Slice(entries, func(i, j int) bool { return entries[i].modTime.Before(entries[j].modTime) })
			for _, e := range entries {
				if total <= maxBytes {
					break
				}
				_ = os.RemoveAll(e.dir)
				total -= e.size
			}
		}
	}
	return nil
}

// --- helpers ---

func readMeta(dir string) (Meta, bool) {
	data, err := os.ReadFile(filepath.Join(dir, metaFile))
	if err != nil {
		return Meta{}, false
	}
	var meta Meta
	if err := json.Unmarshal(data, &meta); err != nil {
		return Meta{}, false
	}
	if meta.Status == "" {
		return Meta{}, false
	}
	return meta, true
}

func writeMeta(dir string, meta Meta) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(filepath.Join(dir, metaFile), data, 0o644))
}

func scanOutputs(dir string) ([]FileMeta, error) {
	var out []FileMeta
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || d.Name() == metaFile {
			return nil
		}
		if _, ok := imageExts[strings.ToLower(filepath.Ext(d.Name()))]; !ok {
			return nil
		}
		hash, size, err := hashFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		out = append(out, FileMeta{Name: filepath.ToSlash(rel), Size: size, Hash: hash})
		return nil
	})
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func hashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, errtrace.Wrap(err)
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, errtrace.Wrap(err)
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func dirStats(dir string) (size int64, newest time.Time) {
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			size += info.Size()
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
		return nil
	})
	return size, newest
}

var unsafeNameRe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// sanitizeName turns an arbitrary script name into a safe directory component.
func sanitizeName(name string) string {
	s := unsafeNameRe.ReplaceAllString(name, "_")
	s = strings.Trim(s, "._-")
	if s == "" {
		return "unnamed"
	}
	return s
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

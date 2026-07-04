// Package artifacts generates, caches, and serves per-project "visual
// artifacts" (e.g. screenshots) for the diff viewer.
//
// A project configures one or more [config.ArtifactScript]s. For a given side
// of a diff (a commit ref, or the head's uncommitted working tree) the manager
// checks out the relevant source, runs the script against it, and collects the
// image files it writes. Results are cached on disk under
// .hydra/local/artifacts/out/<script>/<kind>/<id> (gitignored, never committed),
// keyed by an immutable version identifier: commit/<sha> for a resolved commit,
// or worktree/<hash> for a snapshot of the working-tree state. Repeat views of
// the same version are free.
//
// Generation runs in the background: Get returns immediately with a
// "generating" status while a goroutine does the (potentially slow) work, a
// per-entry lock collapses duplicate concurrent requests for the same version,
// and a semaphore bounds how many generations run at once.
//
// Security note: scripts run *inside the OS sandbox* (the same bubblewrap /
// sandbox-exec confinement agents get), not on the host. The command string may
// come from the version being rendered (each side of a diff loads [[artifacts]]
// from its own .hydra/config.toml, so a branch's edits show up - see
// internal/http/artifacts.go), and it executes against an attacker-controllable
// checkout - build tooling and package lifecycle scripts run the diffed ref's
// own code - so confining it is what keeps a malicious branch from escaping onto
// the host. The checkout dir, the artifact output dir, the dev caches and the git
// common dir are writable; credentials are masked; network is on (cold installs
// need it). A script can opt out with `unsafe_host = true` in config, which runs
// it unconfined on the host - only safe for self-contained, audited commands. So
// that a branch cannot grant *itself* host access, unsafe_host is honored only
// when the trusted live config authorizes that exact command; the gating lives in
// internal/http/artifacts.go, and buildCommandSpec just executes the decision.
package artifacts

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // register GIF decoder for pixel comparison
	_ "image/jpeg" // register JPEG decoder for pixel comparison
	_ "image/png"  // register PNG decoder for pixel comparison
	"io"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
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
	metaFile = "meta.json"
	// logFile holds one settled generation's captured output as JSON-lines (one
	// {text,stream} object per line) next to meta.json, so the build log can be
	// reopened after generation finishes. Wiped with the entry on regenerate.
	logFile        = "build.log"
	defaultTimeout = 5 * time.Minute
	// DefaultMaxAge and DefaultMaxBytes bound the on-disk artifact cache.
	DefaultMaxAge   = 7 * 24 * time.Hour
	DefaultMaxBytes = int64(2) << 30 // 2 GiB
	// Generations are heavy (a full build per ref) and run untrusted ref code, so
	// distinct refs must not fan out without bound: how many run at once is capped
	// by genScheduler, whose limit comes from config.ArtifactConcurrency (default
	// config.DefaultArtifactConcurrency). A normal diff view (left+right of one
	// script) saturates the default; further requests queue, foreground first.
	// maxLogLines bounds the in-memory live log kept per in-flight generation so
	// a chatty build can't grow it without bound. Once exceeded, oldest lines are
	// dropped (the latest output is what the UI is watching).
	maxLogLines = 5000
)

// Stream names for a captured log line.
const (
	StreamStdout = "stdout"
	StreamStderr = "stderr"
)

// ProgressMarker prefixes a stdout line a script emits to set the live progress
// header explicitly, e.g. `echo "::hydra:progress:: capturing home 3/24"`. The
// manager strips the prefix, uses the remainder as the header progress, and -
// once any marker is seen for a generation - stops treating ordinary stdout
// lines as progress, so a noisy build (bun install, vite output, ...) can't hijack
// the header. The line still lands in the full log, with the prefix stripped.
// Documented in the artifacts panel's info tooltip (web ArtifactsPanel.tsx).
const ProgressMarker = "::hydra:progress::"

// LogLine is one captured output line of an in-flight generation, tagged with
// the stream it came from so the UI can render stderr distinctly (in red).
type LogLine struct {
	Text   string `json:"text"`
	Stream string `json:"stream"`
}

// Event is broadcast to subscribers as an in-flight generation progresses, so a
// WebSocket client can update live instead of polling. It is keyed by the entry
// dir (the caller maps that back to a script + side). Kind is one of:
//   - "log":      a new line landed, carried in Line.
//   - "progress": the header progress changed, carried in Progress.
//   - "settled":  generation finished - the caller should re-read the now-written meta.
type Event struct {
	Dir      string
	Kind     string
	Line     LogLine
	Progress string
}

// mediaExts maps collectible output extensions to their content types. It covers
// still images plus animated/video formats: .webp can be an animated image and
// .webm is video, both rendered by the diff viewer's video modes. Comparison of
// video falls back to a byte-hash verdict (Compare only pixel-refines formats the
// Go stdlib can decode), so a non-deterministic encode always reads "modified" -
// produce lossless WebM (e.g. libvpx-vp9 -lossless 1) for a stable, meaningful diff.
var mediaExts = map[string]string{
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".gif":  "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".svg":  "image/svg+xml",
	".bmp":  "image/bmp",
	".pdf":  "application/pdf",
	".webm": "video/webm",
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
	// Tags are labels read from the file's sibling JSON sidecar (<file>.meta,
	// {"tags": [...]}) - see readSidecar/normalizeTags. They drive the diff
	// viewer's tag badges and filter. Already normalized: deduped, sorted, and
	// with GitLab-style scoped labels collapsed to one value per category.
	Tags []string `json:"tags,omitempty"`
	// Fps is the video frame rate from the same sidecar ({"fps": 60}). HTML5
	// video exposes no frame rate, so the viewer's frame-step buttons use this to
	// size a single-frame step. Zero when the sidecar omits it (or for images).
	Fps float64 `json:"fps,omitempty"`
	// Width and Height are the media's natural pixel dimensions, measured at scan
	// time (image header via image.DecodeConfig, or ffprobe for video) and so
	// cached in this entry's meta.json. They let the web grid size tiles without
	// downloading every file to measure it. Best-effort: both zero when the size
	// could not be determined (unsupported/corrupt file, ffprobe absent), in which
	// case the client falls back to measuring the bytes itself.
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	// Dpi is the media's pixel density (device-scale factor) from the same sidecar
	// ({"dpi": 2}) - physical pixels per logical pixel at capture time. It lets the
	// web grid size a tile by the image's *logical* width (Width / Dpi) rather than
	// its raw pixel count, so a phone shot captured at 2x doesn't lay out twice as
	// wide as the same shot at 1x. Zero/absent → treated as 1 (logical == physical).
	Dpi float64 `json:"dpi,omitempty"`
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
	// Progress is the latest non-blank stdout line of an in-flight generation,
	// surfaced live so the UI can show what the script is doing (e.g. which
	// screenshot it's on). It is transient: never persisted (only StatusGenerating
	// metas carry it, and those are never written to disk).
	Progress string `json:"-"`
	// StartedAt is the Unix time (seconds) an in-flight generation began, so the
	// UI can show how long it has been running. Transient, like Progress.
	StartedAt int64 `json:"-"`
	// Log is the captured stdout+stderr lines of an in-flight generation, surfaced
	// live so the UI can show a full scrollable log. Transient, like Progress.
	Log []LogLine `json:"-"`
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
	// Tags are the file's labels, the union of the base (left) and head (right)
	// sides: a free-form tag from either side is kept, and a scoped
	// "category::value" label shared by both is resolved in the head's favor (so
	// a re-tagged category shows its current value while one present on only one
	// side survives). See mergeTags.
	Tags []string
	// Unverified is set only on a video file left as ChangeModified because the
	// per-frame check could not run (ffmpeg missing or errored), so the verdict
	// is the raw byte-hash one and may be spurious - see Manager.Compare. The UI
	// caveats it with a badge. Always false for images and frame-verified video.
	Unverified bool
	// ChangeRatio is the fraction (0..1) of the media that differs, for a
	// ChangeModified file whose pixel/frame check ran. Images report the share of
	// differing pixels; video the share of differing frames (per-frame
	// granularity - ffmpeg hashes whole frames). 0 means identical (such a file is
	// downgraded to ChangeUnchanged), 1 a wholesale change (e.g. differing
	// dimensions). Left at 0 for added/removed/unchanged files and for video left
	// Unverified. The UI uses it to apply a "% changed" threshold below which a
	// modified file is treated as identical - see Manager.Compare.
	ChangeRatio float64
	// Fps is the video frame rate from the file's sidecar, with the head (right)
	// side preferred over the base when both declare one. Zero when neither side
	// declares it (or for images). The viewer uses it to size a frame step.
	Fps float64
	// Width and Height are the media's natural pixel dimensions, with the head
	// (right) side preferred over the base when present (so an added/removed file
	// carries its one extant side's size). Both zero when undetermined on both
	// sides - see FileMeta.Width.
	Width  int
	Height int
	// Dpi is the media's pixel density (device-scale factor), head-preferred like
	// Width/Height. Zero when neither side declares it (treated as 1). See FileMeta.Dpi.
	Dpi float64
}

// Compare matches files by name across two versions' file lists and classifies
// each as added/removed/modified/unchanged. The result is sorted by name.
func Compare(left, right []FileMeta) []FileDelta {
	leftByName := make(map[string]FileMeta, len(left))
	rightByName := make(map[string]FileMeta, len(right))
	names := map[string]struct{}{}
	for _, f := range left {
		leftByName[f.Name] = f
		names[f.Name] = struct{}{}
	}
	for _, f := range right {
		rightByName[f.Name] = f
		names[f.Name] = struct{}{}
	}
	ordered := make([]string, 0, len(names))
	for n := range names {
		ordered = append(ordered, n)
	}
	sort.Strings(ordered)

	out := make([]FileDelta, 0, len(ordered))
	for _, name := range ordered {
		lf, inLeft := leftByName[name]
		rf, inRight := rightByName[name]
		d := FileDelta{Name: name, InLeft: inLeft, InRight: inRight}
		// Union the two sides' tags, with the head winning a shared scoped
		// category. A file on only one side passes that side's tags through
		// (the other is empty).
		d.Tags = mergeTags(lf.Tags, rf.Tags)
		// Frame rate: prefer the head's, fall back to the base's. A file present
		// on only one side carries that side's value (the other is zero).
		if rf.Fps > 0 {
			d.Fps = rf.Fps
		} else {
			d.Fps = lf.Fps
		}
		// Pixel size: same head-preferred-then-base rule as fps. A removed file
		// (right side empty) thus reports its base size, an added file its head one.
		if rf.Width > 0 && rf.Height > 0 {
			d.Width, d.Height = rf.Width, rf.Height
		} else {
			d.Width, d.Height = lf.Width, lf.Height
		}
		// Dpi: head-preferred, falling back to the base side.
		if rf.Dpi > 0 {
			d.Dpi = rf.Dpi
		} else {
			d.Dpi = lf.Dpi
		}
		switch {
		case inLeft && !inRight:
			d.Change = ChangeRemoved
		case !inLeft && inRight:
			d.Change = ChangeAdded
		case lf.Hash != rf.Hash:
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
// check; other still types - and any file that fails to decode - keep the
// byte-hash verdict.
//
// Video (.webm) cannot be decoded by the stdlib, so it is refined out-of-process
// via ffmpeg (videoFramesDiffRatio): identical frames downgrade ChangeModified to
// ChangeUnchanged, which strips spurious diffs from non-deterministic container
// metadata. When ffmpeg is unavailable or errors the byte-hash verdict stands,
// but the delta is marked Unverified so the UI can caveat a possibly-spurious
// "modified".
//
// A file left ChangeModified also records the fraction of pixels (images) or
// frames (video) that differ in FileDelta.ChangeRatio, so the UI can apply a
// "% changed" threshold below which a modified file is treated as identical.
func (m *Manager) Compare(left, right Meta) []FileDelta {
	deltas := Compare(left.Files, right.Files)
	for i := range deltas {
		d := &deltas[i]
		if d.Change != ChangeModified {
			continue
		}
		lp := filepath.Join(m.entryDir(left.Script, left.Key), filepath.FromSlash(d.Name))
		rp := filepath.Join(m.entryDir(right.Script, right.Key), filepath.FromSlash(d.Name))
		if isVideoFile(d.Name) {
			ratio, err := videoFramesDiffRatio(lp, rp)
			switch {
			case err != nil:
				d.Unverified = true
			case ratio == 0:
				d.Change = ChangeUnchanged
			default:
				d.ChangeRatio = ratio
			}
			continue
		}
		if ratio, err := imagesPixelDiffRatio(lp, rp); err == nil {
			if ratio == 0 {
				d.Change = ChangeUnchanged
			} else {
				d.ChangeRatio = ratio
			}
		}
	}
	return deltas
}

// isVideoFile reports whether name's extension is one of the video media types
// (currently only .webm) - the formats that go through the ffmpeg frame check
// rather than the stdlib pixel decoder.
func isVideoFile(name string) bool {
	return strings.HasPrefix(mediaExts[strings.ToLower(filepath.Ext(name))], "video/")
}

// videoFramesDiffRatio reports the fraction (0..1) of frames that differ between
// two video files, by comparing per-frame content hashes from ffmpeg. Granularity
// is per frame, not per pixel - framemd5 yields one hash per frame, so a frame
// counts as changed if any of its pixels changed. A frame-count mismatch counts
// the surplus frames as changed. It returns 0 when the frame sequences are
// identical, and an error (so the caller falls back to the byte-hash verdict) when
// ffmpeg is not installed or fails to decode either side.
func videoFramesDiffRatio(leftPath, rightPath string) (float64, error) {
	l, err := videoFrameHashes(leftPath)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	r, err := videoFrameHashes(rightPath)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	n := max(len(l), len(r))
	if n == 0 {
		return 0, nil
	}
	diff := 0
	for i := range n {
		// A frame present on only one side, or whose hash differs, counts as changed.
		if i >= len(l) || i >= len(r) || l[i] != r[i] {
			diff++
		}
	}
	return float64(diff) / float64(n), nil
}

// videoFrameHashes returns the per-frame content hashes for the first video stream
// of path, using `ffmpeg -f framemd5`. Each entry is the md5 of that frame's
// decoded (rawvideo) pixels, so it depends only on the visual content - container
// muxing, timestamps and writing-app metadata do not affect it. Only the hash
// column is kept, so differing presentation timestamps on otherwise-identical
// frames don't register as a change.
func videoFrameHashes(path string) ([]string, error) {
	bin, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// -map 0:v:0 picks the first video stream; -an drops audio; framemd5 to
	// stdout emits one hash row per decoded frame.
	cmd := exec.CommandContext(ctx, bin, "-nostdin", "-loglevel", "error", "-i", path, "-map", "0:v:0", "-an", "-f", "framemd5", "-")
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	var hashes []string
	sc := bufio.NewScanner(&out)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		// Skip the comment header (#software, #stream metadata, ...) and blanks;
		// keep only the trailing hash field of each frame row.
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if i := strings.LastIndex(line, ","); i >= 0 {
			hashes = append(hashes, strings.TrimSpace(line[i+1:]))
		}
	}
	if err := sc.Err(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	return hashes, nil
}

// imagesPixelDiffRatio reports the fraction (0..1) of pixels that differ between
// two image files, after aligning their (possibly differently-originated)
// coordinate systems. It returns 0 when the images are pixel-identical and 1 when
// their dimensions differ (a wholesale change). A decode failure (unsupported
// format, corrupt file) returns an error so the caller can fall back to the
// byte-hash verdict.
func imagesPixelDiffRatio(leftPath, rightPath string) (float64, error) {
	la, err := decodeImage(leftPath)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	ra, err := decodeImage(rightPath)
	if err != nil {
		return 0, errtrace.Wrap(err)
	}
	lb, rb := la.Bounds(), ra.Bounds()
	if lb.Dx() != rb.Dx() || lb.Dy() != rb.Dy() {
		return 1, nil
	}
	total := lb.Dx() * lb.Dy()
	if total == 0 {
		return 0, nil
	}
	// Fast path: same concrete type with byte-identical pixel buffers.
	if equalRawPix(la, ra) {
		return 0, nil
	}
	// General path: compare pixel-by-pixel in RGBA space, counting every mismatch.
	ox, oy := rb.Min.X-lb.Min.X, rb.Min.Y-lb.Min.Y
	diff := 0
	for y := lb.Min.Y; y < lb.Max.Y; y++ {
		for x := lb.Min.X; x < lb.Max.X; x++ {
			lr, lg, lbl, laa := la.At(x, y).RGBA()
			rr, rg, rbl, raa := ra.At(x+ox, y+oy).RGBA()
			if lr != rr || lg != rg || lbl != rbl || laa != raa {
				diff++
			}
		}
	}
	return float64(diff) / float64(total), nil
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

// mediaPixelSize returns the natural pixel dimensions of an artifact file,
// best-effort. Images are measured from their header only (image.DecodeConfig -
// no full pixel decode); video is measured with ffprobe when it is on PATH. Either
// branch returns (0, 0) when the size can't be determined (unsupported/corrupt
// file, ffprobe missing/errored): the dimensions are optional cache metadata, so a
// zero result is simply omitted and the client measures the bytes itself instead.
func mediaPixelSize(path, name string) (width, height int) {
	if isVideoFile(name) {
		return videoPixelSize(path)
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

// videoPixelSize reads a video's coded frame size with `ffprobe`, best-effort.
// Returns (0, 0) when ffprobe is unavailable, times out, or yields no parseable
// "WxH" for the first video stream.
func videoPixelSize(path string) (width, height int) {
	bin, err := exec.LookPath("ffprobe")
	if err != nil {
		return 0, 0
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// -select_streams v:0 picks the first video stream; csv=s=x:p=0 prints just
	// the two values joined by 'x', e.g. "1280x720".
	cmd := exec.CommandContext(ctx, bin, "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height", "-of", "csv=s=x:p=0", path)
	out, err := cmd.Output()
	if err != nil {
		return 0, 0
	}
	wStr, hStr, ok := strings.Cut(strings.TrimSpace(string(out)), "x")
	if !ok {
		return 0, 0
	}
	w, errW := strconv.Atoi(strings.TrimSpace(wStr))
	h, errH := strconv.Atoi(strings.TrimSpace(hStr))
	if errW != nil || errH != nil || w <= 0 || h <= 0 {
		return 0, 0
	}
	return w, h
}

// equalRawPix is a fast path that reports true only when two images share the
// same concrete pixel type and byte-identical pixel buffers. A false result
// means "unknown" - the caller falls back to the general per-pixel comparison.
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

	mu         sync.Mutex
	gens       map[string]struct{}           // entry dirs with an in-flight generation
	progress   map[string]string             // entry dir -> latest progress line of its in-flight gen
	startedAt  map[string]int64              // entry dir -> Unix time its in-flight gen started
	logs       map[string][]LogLine          // entry dir -> captured log of its in-flight gen
	markerSeen map[string]bool               // entry dir -> a ProgressMarker line has been seen (stop stdout-as-progress)
	cancel     map[string]context.CancelFunc // entry dir -> cancels its in-flight gen's command tree (for preemption)
	fgWant     map[string]bool               // entry dir -> a foreground request wants it (exempt from background preemption)
	subs       map[int]chan Event            // event subscribers (live progress streaming)
	nextSub    int                           // next subscriber id

	// sched bounds concurrent generations and prioritizes foreground (a user
	// viewing a diff) over background (proactive pre-generation) work, without
	// preempting in-flight runs. Its limit comes from config.ArtifactConcurrency.
	sched *genScheduler

	// pool reuses a bounded set of detached worktrees for commit checkouts rather
	// than creating/destroying one per generation (PLAN #51).
	pool *slotPool
}

// NewManager returns a Manager for the given project root. The generation
// concurrency is read from the project's config (artifact_concurrency, default
// config.DefaultArtifactConcurrency) and can be updated later via SetConcurrency
// when the config changes.
func NewManager(projectRoot string) *Manager {
	concurrency := config.DefaultArtifactConcurrency
	if cfg, err := config.Load(projectRoot); err == nil {
		concurrency = cfg.ResolveArtifactConcurrency()
	}
	m := &Manager{
		projectRoot: projectRoot,
		gens:        map[string]struct{}{},
		progress:    map[string]string{},
		startedAt:   map[string]int64{},
		logs:        map[string][]LogLine{},
		markerSeen:  map[string]bool{},
		cancel:      map[string]context.CancelFunc{},
		fgWant:      map[string]bool{},
		subs:        map[int]chan Event{},
		sched:       newGenScheduler(concurrency),
	}
	m.pool = newSlotPool(m.projectRoot, m.slotsDir(), slotsForConcurrency(concurrency))
	_ = paths.EnsureHydraLocalIgnored(m.root())
	return m
}

// SetConcurrency updates the generation parallelism (from a config change),
// resizing both the priority scheduler and the worktree-slot pool. n is the cap,
// where 0 means unlimited (no cap). Safe to call at any time; raising it (or
// going unlimited) immediately admits queued work, lowering it lets the excess
// drain without preempting in-flight generations.
func (m *Manager) SetConcurrency(n int) {
	if n < 0 {
		n = 0
	}
	m.sched.setLimit(n)
	m.pool.setMaxSlots(slotsForConcurrency(n))
}

// slotsForConcurrency sizes the worktree-slot pool for a generation concurrency.
// Every commit-side generation holds one slot for its duration, so the pool must
// have at least `n` slots or concurrent commit-side gens would deadlock waiting
// for a slot. The +2 keeps freed slots "warm" on recently-used commits for
// zero-cost affinity reuse, and the floor of maxSlots preserves that headroom at
// the default concurrency. n == 0 (unlimited concurrency) maps to 0 (an
// unbounded pool) so commit-side gens never block on a slot.
func slotsForConcurrency(n int) int {
	if n <= 0 {
		return 0
	}
	return max(maxSlots, n+2)
}

// Subscribe registers a listener for generation events and returns the event
// channel plus a function to unsubscribe (which also closes the channel). Events
// are delivered best-effort: a slow consumer whose buffer fills drops "log"
// events, but "settled" events let the consumer recover by re-reading meta.
func (m *Manager) Subscribe() (<-chan Event, func()) {
	ch := make(chan Event, 512)
	m.mu.Lock()
	id := m.nextSub
	m.nextSub++
	m.subs[id] = ch
	m.mu.Unlock()
	return ch, func() {
		m.mu.Lock()
		if c, ok := m.subs[id]; ok {
			delete(m.subs, id)
			close(c)
		}
		m.mu.Unlock()
	}
}

// broadcastLocked delivers ev to every subscriber without blocking. Callers must
// hold m.mu - that serializes against Subscribe's close, so we never send on a
// closed channel.
func (m *Manager) broadcastLocked(ev Event) {
	for _, ch := range m.subs {
		select {
		case ch <- ev:
		default: // subscriber buffer full; drop (best-effort, see Subscribe)
		}
	}
}

// EntryDir returns the on-disk cache directory for (script, v). Exposed so the
// WS handler can map generation events (keyed by entry dir) back to a script and
// side without duplicating the version-key resolution.
func (m *Manager) EntryDir(script string, v Version) (string, error) {
	key, _, err := m.versionKey(v)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return m.entryDir(script, key), nil
}

// Registry lazily creates and caches one Manager per project root. A single
// daemon serves every registered project, but each project needs its own
// Manager: managers are stateful (in-flight generation tracking, the cache
// lives under that project's .hydra/local/artifacts) so they must be reused across
// requests for the same project rather than recreated.
type Registry struct {
	mu   sync.Mutex
	mgrs map[string]*Manager
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{mgrs: map[string]*Manager{}}
}

// Manager returns the manager for projectRoot, creating it on first use.
func (r *Registry) Manager(projectRoot string) *Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.mgrs[projectRoot]; ok {
		return m
	}
	m := NewManager(projectRoot)
	r.mgrs[projectRoot] = m
	return m
}

// Snapshot returns a copy of the currently-created managers, keyed by project
// root. Used by maintenance loops (e.g. cache pruning) that should touch only
// projects whose artifacts have actually been exercised this daemon lifetime.
func (r *Registry) Snapshot() map[string]*Manager {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]*Manager, len(r.mgrs))
	maps.Copy(out, r.mgrs)
	return out
}

func (m *Manager) root() string         { return paths.GetArtifactsDirFromProjectRoot(m.projectRoot) }
func (m *Manager) outDir() string       { return filepath.Join(m.root(), "out") }
func (m *Manager) checkoutsDir() string { return filepath.Join(m.root(), "checkouts") }
func (m *Manager) slotsDir() string     { return filepath.Join(m.root(), "slots") }

// entryDir is the on-disk cache dir for a (script, key) pair. key is a
// "<kind>/<id>" path (see versionKey), so the entry nests as
// out/<script>/<kind>/<id>/; filepath.Join treats the slash as a separator.
func (m *Manager) entryDir(script, key string) string {
	return filepath.Join(m.outDir(), sanitizeName(script), filepath.FromSlash(key))
}

// Cache-key kinds. A key is "<kind>/<id>": a commit is keyed by its resolved
// SHA, the working tree by a content fingerprint. The kind is the first path
// segment, so on disk an entry lives at out/<script>/<kind>/<id>/ - commits and
// working-tree snapshots sit in separate, self-describing subtrees.
const (
	keyKindCommit   = "commit"
	keyKindWorktree = "worktree"
)

// versionKey resolves a Version to a stable cache key and a human-readable ref.
// The key doubles as the entry's path under the script dir (see entryDir), so it
// is always "<kind>/<id>" with an id that is safe as a single path segment.
func (m *Manager) versionKey(v Version) (key, ref string, err error) {
	if v.WorktreeDir != "" {
		h, err := git.WorktreeStateHash(v.WorktreeDir)
		if err != nil {
			return "", "", errtrace.Wrap(err)
		}
		return keyKindWorktree + "/" + h, "working tree", nil
	}
	sha, err := git.ResolveRef(m.projectRoot, v.Ref)
	if err != nil {
		return "", "", errtrace.Wrap(err)
	}
	return keyKindCommit + "/" + sha, sha, nil
}

// Get returns the cache entry for (spec, v), starting a foreground generation
// if it is neither cached nor already in flight. A returned Meta with status
// StatusGenerating means the caller should poll again shortly. Foreground work
// is prioritized over background pre-generation (see Prefetch): if this entry is
// already queued as background, the call promotes it so it stops waiting behind
// other background work.
func (m *Manager) Get(spec config.ArtifactScript, v Version) (Meta, error) {
	return errtrace.Wrap2(m.get(spec, v, true))
}

// Prefetch starts a background generation for (spec, v) if it is neither cached
// nor already in flight, so a later view finds it ready instead of triggering
// the work on click. It returns immediately; the result is the cache entry it
// will populate (StatusGenerating while it runs). Background generations yield
// their slot to foreground requests in the queue but are never preempted once
// running, so the proactive work is never wasted - a subsequent Get for the same
// version reuses the in-flight run or its cached result. See the daemon's
// artifact prefetcher (internal/http/prefetch.go).
func (m *Manager) Prefetch(spec config.ArtifactScript, v Version) (Meta, error) {
	return errtrace.Wrap2(m.get(spec, v, false))
}

func (m *Manager) get(spec config.ArtifactScript, v Version, fg bool) (Meta, error) {
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
		// A foreground view claims the entry: mark it so background preemption
		// (CancelStaleBackground) won't cancel what the user is now watching, and
		// bump it ahead of other background work in the queue.
		if fg {
			m.fgWant[dir] = true
		}
		prog := m.progress[dir]
		started := m.startedAt[dir]
		logCopy := append([]LogLine(nil), m.logs[dir]...)
		m.mu.Unlock()
		if fg {
			m.sched.promote(dir)
		}
		return Meta{Script: spec.Name, Key: key, Ref: ref, Status: StatusGenerating, Progress: prog, StartedAt: started, Log: logCopy}, nil
	}
	started := time.Now().Unix()
	// A cancellable context per generation so the prefetcher can preempt a stale
	// background run (see CancelStaleBackground); generate derives its timeout from
	// it, so cancelling kills the whole sandboxed command tree.
	genCtx, genCancel := context.WithCancel(context.Background())
	m.gens[dir] = struct{}{}
	m.startedAt[dir] = started
	m.logs[dir] = nil
	m.cancel[dir] = genCancel
	if fg {
		m.fgWant[dir] = true
	}
	m.mu.Unlock()

	go func() {
		defer genCancel() // free the context on exit
		// Bound concurrent generations, foreground before background. The entry
		// stays marked in-flight while queued, so duplicate requests keep getting
		// StatusGenerating instead of piling up more builds.
		m.sched.acquire(dir, fg)
		defer m.sched.release()

		meta := m.generate(genCtx, spec, v, key, ref)
		// A cancelled generation was preempted (a newer version superseded this
		// one): don't cache the aborted run as an error - drop the entry so a later
		// request regenerates cleanly instead of serving a stale failure.
		cancelled := genCtx.Err() != nil
		if cancelled {
			_ = os.RemoveAll(dir)
		} else if err := writeMeta(dir, meta); err != nil {
			// Best-effort: a failed write just means the next request regenerates.
			_ = err
		}
		m.mu.Lock()
		// Grab the captured log before dropping it from memory, so it can be
		// persisted next to meta.json and reopened after generation finishes.
		logCopy := append([]LogLine(nil), m.logs[dir]...)
		delete(m.gens, dir)
		delete(m.progress, dir)
		delete(m.startedAt, dir)
		delete(m.logs, dir)
		delete(m.markerSeen, dir)
		delete(m.cancel, dir)
		delete(m.fgWant, dir)
		// Notify subscribers the entry settled (meta is already written above) so
		// they re-read it instead of waiting for the next poll.
		m.broadcastLocked(Event{Dir: dir, Kind: "settled"})
		m.mu.Unlock()
		if !cancelled {
			writeLogFile(dir, logCopy) // best-effort; dir exists from generate()
		}
	}()

	return Meta{Script: spec.Name, Key: key, Ref: ref, Status: StatusGenerating, StartedAt: started}, nil
}

// Invalidate drops the cached entry for (script, v) so the next Get regenerates
// it from scratch. This is how a user-initiated "refresh" busts a stale result -
// most importantly a cached StatusError, which otherwise sticks until the version
// key changes or the entry is pruned. It is a no-op when a generation for that
// entry is already in flight (that run will write a fresh result) or when nothing
// is cached.
func (m *Manager) Invalidate(script string, v Version) error {
	key, _, err := m.versionKey(v)
	if err != nil {
		return errtrace.Wrap(err)
	}
	dir := m.entryDir(script, key)
	m.mu.Lock()
	_, inFlight := m.gens[dir]
	m.mu.Unlock()
	if inFlight {
		return nil
	}
	return errtrace.Wrap(os.RemoveAll(dir))
}

// CancelStaleBackground cancels the in-flight generation for the cache entry at
// dir, but only while it is still running purely as background work - i.e. no
// foreground viewer has claimed it (see the fgWant guard). The daemon's
// prefetcher calls this when a head moves to a newer version so the now-stale
// build (e.g. a render of the head's previous working-tree state) is killed at
// once, freeing its generation slot and its (often heavy: a forked JVM, an
// emulator) build memory for the new version instead of letting a dead render run
// to completion. Cancelling tears down the whole sandboxed process tree (bwrap is
// its PID-namespace init) and the run's goroutine drops the entry rather than
// caching the aborted result. A no-op if the entry isn't in flight, already
// settled, or a foreground request wants it.
func (m *Manager) CancelStaleBackground(dir string) {
	m.mu.Lock()
	cancel := m.cancel[dir]
	fgWant := m.fgWant[dir]
	m.mu.Unlock()
	if cancel != nil && !fgWant {
		cancel()
	}
}

// appendLog records one captured output line of an in-flight generation: it
// appends to the live log (bounded by maxLogLines), updates the header progress,
// and broadcasts to subscribers. isMarker reports that the line was an explicit
// [ProgressMarker] line (already stripped of its prefix by the caller); such a
// line always becomes the progress and, from then on, disables stdout-derived
// progress for this generation so a noisy build can't hijack the header. Until
// the first marker, the latest stdout line is used (back-compat for marker-less
// scripts). It is a no-op once the entry is no longer in-flight, so a late line
// can't resurrect a settled entry.
func (m *Manager) appendLog(dir, text, stream string, isMarker bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, inFlight := m.gens[dir]; !inFlight {
		return
	}
	line := LogLine{Text: text, Stream: stream}
	m.logs[dir] = append(m.logs[dir], line)
	if over := len(m.logs[dir]) - maxLogLines; over > 0 {
		m.logs[dir] = m.logs[dir][over:]
	}
	m.broadcastLocked(Event{Dir: dir, Kind: "log", Line: line})

	switch {
	case isMarker:
		m.markerSeen[dir] = true
		m.setProgressLocked(dir, text)
	case stream == StreamStdout && !m.markerSeen[dir]:
		m.setProgressLocked(dir, text)
	}
}

// setProgressLocked updates the header progress for an in-flight entry and
// broadcasts a "progress" event when it changes. Callers must hold m.mu.
func (m *Manager) setProgressLocked(dir, text string) {
	if m.progress[dir] == text {
		return
	}
	m.progress[dir] = text
	m.broadcastLocked(Event{Dir: dir, Kind: "progress", Progress: text})
}

// generate runs the script for one version and returns the resulting Meta. The
// parent ctx is cancellable (per generation): cancelling it kills the command -
// and, because the sandbox's bwrap is the init of its own PID namespace, the
// whole process tree - so a preempted run frees its resources at once.
func (m *Manager) generate(parent context.Context, spec config.ArtifactScript, v Version, key, ref string) Meta {
	meta := Meta{Script: spec.Name, Key: key, Ref: ref, UpdatedAt: time.Now().Unix()}

	_ = paths.EnsureHydraLocalIgnored(m.root())
	dir := m.entryDir(spec.Name, key)
	if err := os.RemoveAll(dir); err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}

	// Resolve the directory the script runs in. For a commit ref (no caller-supplied
	// worktree) borrow a reusable slot from the pool - checked out at `ref` (an
	// already-resolved commit SHA) - rather than creating and destroying a full
	// worktree per generation (PLAN #51). Released for reuse when generation ends.
	runDir := v.WorktreeDir
	if runDir == "" {
		s, err := m.pool.acquire(ref, spec.CleanIgnored)
		if err != nil {
			meta.Status, meta.Error = StatusError, fmt.Sprintf("checkout %s: %v", ref, err)
			return meta
		}
		defer m.pool.release(s)
		runDir = s.path
	}

	timeout := defaultTimeout
	if spec.TimeoutSec > 0 {
		timeout = time.Duration(spec.TimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	launch, err := m.buildCommandSpec(spec, runDir, dir, ref)
	if err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	defer launch.Cleanup()

	cmd := exec.CommandContext(ctx, launch.Path, launch.Args[1:]...)
	cmd.Dir = launch.Dir
	cmd.Env = launch.Env
	cmd.ExtraFiles = launch.ExtraFiles
	// Stream both stdout and stderr line-by-line into the live log (the UI shows
	// it as a scrollable, auto-updating log, stderr in red), while still keeping
	// stderr for the error tail. The latest non-blank stdout line also becomes the
	// header progress (e.g. "wrote artifacts-ab-dark.png 7/12").
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	if err := cmd.Start(); err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	var stderrBuf bytes.Buffer
	var stderrMu sync.Mutex
	// Track the most recent non-blank stdout line so a silent failure (a strict-mode
	// errexit or a SIGKILL timeout that writes nothing to stderr) can still hint at
	// where the script stopped; guarded by its own mutex since the stdout and stderr
	// scanners run concurrently.
	var lastStdout string
	var lastStdoutMu sync.Mutex
	setLastStdout := func(s string) {
		lastStdoutMu.Lock()
		lastStdout = s
		lastStdoutMu.Unlock()
	}
	scan := func(r io.Reader, stream string) {
		sc := bufio.NewScanner(r)
		// Allow long lines (build tools can emit verbose single lines).
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := strings.TrimRight(sc.Text(), "\r")
			if stream == StreamStderr {
				stderrMu.Lock()
				stderrBuf.WriteString(line)
				stderrBuf.WriteByte('\n')
				stderrMu.Unlock()
			}
			// A stdout line tagged with the progress marker sets the header
			// progress explicitly; strip the marker so the log shows a clean line.
			if stream == StreamStdout {
				if rest, ok := strings.CutPrefix(strings.TrimSpace(line), ProgressMarker); ok {
					if text := strings.TrimSpace(rest); text != "" {
						setLastStdout(text)
						m.appendLog(dir, text, stream, true)
					}
					continue
				}
			}
			if strings.TrimSpace(line) != "" {
				if stream == StreamStdout {
					setLastStdout(strings.TrimSpace(line))
				}
				m.appendLog(dir, line, stream, false)
			}
		}
		_ = sc.Err() // best-effort: the log is non-critical
	}
	var scanWG sync.WaitGroup
	scanWG.Go(func() { scan(stdout, StreamStdout) })
	scanWG.Go(func() { scan(stderrPipe, StreamStderr) })
	err = cmd.Wait()
	scanWG.Wait() // drain both pipes before reading stderr / returning
	if err != nil {
		// A concise failure summary: the exit code, or "timed out after ..." when the
		// per-script timeout fired. This is Hydra's framing - NOT something the
		// script prints - so it is otherwise invisible: a timeout SIGKILLs the
		// script before it can say anything, and a bare non-zero exit may print
		// nothing after its last progress line.
		summary := err.Error()
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			summary = fmt.Sprintf("exited %d", exitErr.ExitCode())
		}
		if ctx.Err() == context.DeadlineExceeded {
			summary = "timed out after " + timeout.String()
		}
		// Append the summary as the log's final line so the captured build log
		// itself explains why the run ended - the script's own stderr is already
		// streamed above, so the UI shows this inline as the last (red) line rather
		// than in a separate banner that would duplicate the stderr and push the
		// terminal down.
		m.appendLog(dir, summary, StreamStderr, false)

		stderrMu.Lock()
		tail := strings.TrimSpace(stderrBuf.String())
		stderrMu.Unlock()
		msg := summary
		if tail != "" {
			msg += ": " + lastLines(tail, 15)
		} else {
			// No stderr to explain the exit (a strict-mode abort or a SIGKILL'd
			// timeout often prints nothing): fall back to the last stdout line so
			// the chip points at where the script stopped instead of a bare code.
			lastStdoutMu.Lock()
			last := lastStdout
			lastStdoutMu.Unlock()
			if last != "" {
				msg += " (last output: " + last + ")"
			}
		}
		meta.Status, meta.Error = StatusError, msg
		return meta
	}

	files, tagWarnings, err := scanOutputs(dir)
	if err != nil {
		meta.Status, meta.Error = StatusError, err.Error()
		return meta
	}
	// Surface tag-sidecar problems in the build log (entry is still in-flight here,
	// so appendLog records and persists them) without failing the generation.
	for _, w := range tagWarnings {
		m.appendLog(dir, w, StreamStderr, false)
	}
	meta.Files = files
	meta.Status = StatusReady
	meta.UpdatedAt = time.Now().Unix()
	return meta
}

// buildCommandSpec resolves the script command into a launch spec. By default
// it runs inside the OS sandbox (the same confinement agents get), because the
// command executes against an attacker-controllable checkout - the diffed ref's
// build tooling and package lifecycle scripts run its code. runDir (the
// checkout/working tree) and outputDir (HYDRA_ARTIFACT_OUTPUT) are writable
// along with the dev caches and the git common dir; credentials are masked; the
// network is on (cold `bun install`/`go mod download` need it, warm caches stay
// mostly offline) - matching the agent default. When spec.UnsafeHost is set the
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
	// so mise-managed toolchains (go, bun, ...) resolve inside the run dir.
	env = append(env, sandbox.MiseTrustEnv(m.projectRoot, runDir)...)

	command := spec.Command
	if spec.IsStrict() {
		// Fail-fast: a broken render whose last step happens to exit 0 must not be
		// cached as a success (set strict = false on the script to opt out).
		command = sandbox.StrictScript(spec.Command)
	}
	opts := sandbox.Options{
		AgentType:    sandbox.AgentTypeBash, // a plain command, not an agent
		WorktreePath: runDir,                // always writable + chdir target
		Home:         home,
		Env:          env,
		Argv:         []string{"bash", "-c", command},
		NoSandbox:    spec.UnsafeHost,
	}

	if !spec.UnsafeHost {
		cfg, _ := config.Load(m.projectRoot)
		// The pre-spawn script is intentionally ignored: artifact generation is a
		// plain command, not an agent spawn.
		writable, masked, restore, _, _, _ := cfg.ResolveSandboxOptions("")
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

// keyRe matches valid cache keys produced by versionKey ("commit/<sha>" or
// "worktree/<hash>"). Anchored with a single fixed kind segment and a hex id, so
// a key can never contain ".." or extra path segments - BlobPath relies on this
// to keep the resolved blob path inside the entry dir.
var keyRe = regexp.MustCompile(`^(commit|worktree)/[0-9a-f]+$`)

// BlobPath validates a (script, key, file) triple and returns the absolute
// on-disk path of the artifact file plus its content type. It guards against
// path traversal: the resolved path is guaranteed to stay within the entry dir.
func (m *Manager) BlobPath(script, key, file string) (path, contentType string, err error) {
	if !keyRe.MatchString(key) {
		return "", "", errtrace.Wrap(fmt.Errorf("invalid key"))
	}
	ext := strings.ToLower(filepath.Ext(file))
	ct, ok := mediaExts[ext]
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

// CleanCheckouts removes leftover ephemeral checkouts and resets the worktree-slot
// pool. Safe to call on boot, before any generation is in flight - this is also
// the crash-recovery path: a process that died mid-generation leaves slot (and,
// pre-slot-pool, per-commit checkout) worktrees behind, which this wipes and
// prunes so the pool starts clean and recreates slots on demand.
func (m *Manager) CleanCheckouts() {
	_ = os.RemoveAll(m.checkoutsDir()) // legacy per-commit checkouts (pre-slot-pool)
	m.pool.clean()                     // slot worktrees + `git worktree prune`
}

// legacyKeyRe matches a cache-entry dir in the old flat layout, where the kind
// was a single-letter prefix on the id: "c<sha>" for a commit, "w<hash>" for a
// working-tree snapshot. Captures the prefix and the id.
var legacyKeyRe = regexp.MustCompile(`^([cw])([0-9a-f]+)$`)

// MigrateLegacyLayout moves any cache entries still in the old flat
// "c<sha>"/"w<hash>" layout into the current out/<script>/<kind>/<id> layout,
// rewriting each meta.json's key field to match its new path (the field is
// returned verbatim and feeds the blob URLs, so a stale key would 404).
// Migrating - rather than discarding - keeps already-generated screenshots valid
// across the upgrade. Best-effort and idempotent: safe to run on every boot, and
// it skips an entry whose new-format dir already exists (a fresh regen wins).
// Returns the number of entries moved.
func (m *Manager) MigrateLegacyLayout() int {
	scriptDirs, err := os.ReadDir(m.outDir())
	if err != nil {
		return 0
	}
	moved := 0
	for _, sd := range scriptDirs {
		if !sd.IsDir() {
			continue
		}
		scriptPath := filepath.Join(m.outDir(), sd.Name())
		children, err := os.ReadDir(scriptPath)
		if err != nil {
			continue
		}
		for _, c := range children {
			match := legacyKeyRe.FindStringSubmatch(c.Name())
			if !c.IsDir() || match == nil {
				continue // already-migrated commit/ & worktree/ dirs, or stray files
			}
			kind := keyKindCommit
			if match[1] == "w" {
				kind = keyKindWorktree
			}
			newKey := kind + "/" + match[2]
			oldDir := filepath.Join(scriptPath, c.Name())
			newDir := filepath.Join(scriptPath, kind, match[2])
			// A new-format entry already exists (regenerated since the upgrade):
			// keep the fresh one and drop the stale legacy copy.
			if _, err := os.Stat(newDir); err == nil {
				_ = os.RemoveAll(oldDir)
				continue
			}
			if err := os.MkdirAll(filepath.Dir(newDir), 0o755); err != nil {
				continue
			}
			if err := os.Rename(oldDir, newDir); err != nil {
				continue
			}
			// Point the persisted meta at its new path. If meta is unreadable the
			// entry is effectively dead anyway; the next Get regenerates it.
			if meta, ok := readMeta(newDir); ok && meta.Key != newKey {
				meta.Key = newKey
				_ = writeMeta(newDir, meta)
			}
			moved++
		}
	}
	return moved
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
		// Entries nest two levels below the script dir: <kind>/<id> (see
		// versionKey). Anything else directly under the script dir is a leftover
		// from the old flat "c<sha>"/"w<hash>" layout - skip it (don't delete), so
		// a not-yet-migrated cache survives until MigrateLegacyLayout (run on boot)
		// moves it over.
		kindDirs, err := os.ReadDir(scriptPath)
		if err != nil {
			continue
		}
		for _, kindDir := range kindDirs {
			if !kindDir.IsDir() || (kindDir.Name() != keyKindCommit && kindDir.Name() != keyKindWorktree) {
				continue
			}
			kindPath := filepath.Join(scriptPath, kindDir.Name())
			idDirs, err := os.ReadDir(kindPath)
			if err != nil {
				continue
			}
			for _, id := range idDirs {
				if !id.IsDir() {
					continue
				}
				dir := filepath.Join(kindPath, id.Name())
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

// writeLogFile persists a settled generation's captured log next to meta.json as
// JSON-lines (one {text,stream} object per line), so it can be reopened after
// generation finishes. Best-effort: a missing dir or write error just means the
// log can't be reopened (the next regenerate rewrites it).
func writeLogFile(dir string, lines []LogLine) {
	if len(lines) == 0 {
		return
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, l := range lines {
		if err := enc.Encode(l); err != nil {
			return
		}
	}
	_ = os.WriteFile(filepath.Join(dir, logFile), buf.Bytes(), 0o644)
}

// HasLog reports whether a persisted build log exists for a settled (script, key)
// entry, so the API only advertises a log URL when there is something to fetch
// (older cache entries predate the persisted log).
func (m *Manager) HasLog(script, key string) bool {
	if !keyRe.MatchString(key) {
		return false
	}
	_, err := os.Stat(filepath.Join(m.entryDir(script, key), logFile))
	return err == nil
}

// ReadLog returns the persisted build log for a settled (script, key) entry, or
// (nil, false) if none exists. Used to reopen a log after generation finishes.
// key is validated against keyRe to keep the path inside the cache.
func (m *Manager) ReadLog(script, key string) ([]LogLine, bool) {
	if !keyRe.MatchString(key) {
		return nil, false
	}
	data, err := os.ReadFile(filepath.Join(m.entryDir(script, key), logFile))
	if err != nil {
		return nil, false
	}
	var out []LogLine
	dec := json.NewDecoder(bytes.NewReader(data))
	for {
		var l LogLine
		if err := dec.Decode(&l); err != nil {
			break // EOF or a truncated trailing line; return what parsed
		}
		out = append(out, l)
	}
	return out, true
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

// scanOutputs collects the image files a generation wrote, reading each file's
// optional <file>.meta sidecar (tags + video fps). It also returns human-readable
// warnings (malformed sidecar JSON, a scoped-label category set more than once)
// for the caller to fold into the build log so the script author sees them.
func scanOutputs(dir string) ([]FileMeta, []string, error) {
	var out []FileMeta
	var warnings []string
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return errtrace.Wrap(err)
		}
		if d.IsDir() || d.Name() == metaFile {
			return nil
		}
		if _, ok := mediaExts[strings.ToLower(filepath.Ext(d.Name()))]; !ok {
			return nil // skips .meta sidecars too (not a known media extension)
		}
		hash, size, err := hashFile(p)
		if err != nil {
			return errtrace.Wrap(err)
		}
		rel, _ := filepath.Rel(dir, p)
		name := filepath.ToSlash(rel)
		tags, fps, dpi, warns := readSidecar(p)
		for _, w := range warns {
			warnings = append(warnings, name+": "+w)
		}
		width, height := mediaPixelSize(p, name)
		out = append(out, FileMeta{Name: name, Size: size, Hash: hash, Tags: tags, Fps: fps, Width: width, Height: height, Dpi: dpi})
		return nil
	})
	if err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, warnings, nil
}

// readSidecar reads the optional metadata sidecar for an output file: a sibling
// JSON file named "<file>.meta" of the form
// {"tags": ["a", "theme::dark"], "fps": 60}. The "meta" extension is a single,
// extensible home for per-file metadata. A missing/unreadable sidecar yields
// nothing and no warnings (the common case); malformed JSON yields a warning (and
// no metadata). fps is reported only when present and positive - a non-positive
// value is ignored (zero, the caller's "unset", with a warning).
func readSidecar(filePath string) (tags []string, fps float64, dpi float64, warnings []string) {
	data, err := os.ReadFile(filePath + ".meta")
	if err != nil {
		return nil, 0, 0, nil // no sidecar → no metadata (the common case)
	}
	var sc struct {
		Tags []string `json:"tags"`
		Fps  float64  `json:"fps"`
		Dpi  float64  `json:"dpi"`
	}
	if err := json.Unmarshal(data, &sc); err != nil {
		return nil, 0, 0, []string{fmt.Sprintf("ignoring malformed sidecar %s.meta: %v", filepath.Base(filePath), err)}
	}
	tags, warnings = normalizeTags(sc.Tags)
	if sc.Fps < 0 {
		warnings = append(warnings, fmt.Sprintf("fps: ignoring non-positive value %g in sidecar %s.meta", sc.Fps, filepath.Base(filePath)))
	} else {
		fps = sc.Fps
	}
	if sc.Dpi < 0 {
		warnings = append(warnings, fmt.Sprintf("dpi: ignoring non-positive value %g in sidecar %s.meta", sc.Dpi, filepath.Base(filePath)))
	} else {
		dpi = sc.Dpi
	}
	return tags, fps, dpi, warnings
}

// normalizeTags cleans a raw tag list and enforces GitLab-style scoped labels.
// A tag of the form "category::value" is scoped: at most one value per category
// survives, and the LAST one declared wins (with a warning naming the discarded
// ones). Free-form tags (no "::") are kept as a deduped set. The result is sorted
// for stable output. A scoped tag with an empty category or value is malformed
// and kept verbatim as a free tag.
func normalizeTags(raw []string) (tags, warnings []string) {
	free := map[string]struct{}{}
	scopedVal := map[string]string{}   // category -> chosen (last) "category::value"
	scopedAll := map[string][]string{} // category -> every "category::value" seen, for the warning
	for _, t := range raw {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		cat, val, isScoped := strings.Cut(t, "::")
		cat, val = strings.TrimSpace(cat), strings.TrimSpace(val)
		if !isScoped || cat == "" || val == "" {
			free[t] = struct{}{} // free-form or malformed scoped tag
			continue
		}
		full := cat + "::" + val
		scopedAll[cat] = append(scopedAll[cat], full)
		scopedVal[cat] = full // last declared wins
	}
	for t := range free {
		tags = append(tags, t)
	}
	for cat, all := range scopedAll {
		tags = append(tags, scopedVal[cat])
		if len(all) > 1 {
			warnings = append(warnings, fmt.Sprintf("tags: category %q set %d times (%s); keeping last (%s)",
				cat, len(all), strings.Join(all, ", "), scopedVal[cat]))
		}
	}
	sort.Strings(tags)
	sort.Strings(warnings)
	return tags, warnings
}

// mergeTags combines a file's before (left) and after (right) tag sets into the
// labels shown for the diff. Free-form tags are unioned. A scoped
// "category::value" label is merged per category with the after side winning, so
// a file that re-tags a category shows the new value while a category present on
// only one side is preserved. Both inputs are already normalized (≤1 value per
// category, deduped); the result is sorted, and empty merges return nil so a
// tagless file stays tagless.
func mergeTags(left, right []string) []string {
	free := map[string]struct{}{}
	scoped := map[string]string{} // category -> "category::value"
	add := func(tags []string) {
		for _, t := range tags {
			cat, val, isScoped := strings.Cut(t, "::")
			if !isScoped || cat == "" || val == "" {
				free[t] = struct{}{} // free-form or malformed scoped tag
				continue
			}
			scoped[cat] = t
		}
	}
	add(left)
	add(right) // after overrides before for a shared scoped category
	if len(free) == 0 && len(scoped) == 0 {
		return nil
	}
	out := make([]string, 0, len(free)+len(scoped))
	for t := range free {
		out = append(out, t)
	}
	for _, t := range scoped {
		out = append(out, t)
	}
	sort.Strings(out)
	return out
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

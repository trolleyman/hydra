// Package tools provisions the host-side sandbox helper binaries that Hydra
// prefers to run with but that a stock distro often ships too old (or not at
// all). Rather than make the user hunt them down and wire env by hand, we place
// known-good copies under the project's gitignored .hydra/tools/bin and point the
// existing HYDRA_PASTA / HYDRA_BWRAP override seams (internal/sandbox,
// internal/egress) at them. The dir sits under .hydra/tools rather than
// .hydra/local so provisioned build dependencies don't get muddled with .hydra's
// generated *runtime* state (worktrees, DB, caches).
//
// Two tools, two very different provisioning stories:
//
//   - pasta - hard egress needs a modern pasta with --map-host-loopback, which
//     predates Ubuntu 24.04's passt. passt.top publishes a ready-made static
//     build, so we download it (+ its pasta.avx2 sibling). passt.top publishes no
//     checksums for its rolling builds, so TLS + the origin are the trust anchor;
//     we record the upstream Last-Modified + size in a sidecar so an update only
//     re-downloads when the build changed.
//
//   - bwrap - bubblewrap ships NO official prebuilt binary, only a source tarball
//     plus a published sha256. So "bundling" bwrap means building it from source:
//     we download a pinned release, verify the pinned sha256, and compile with
//     meson/ninja. This is slow and needs a C toolchain, so it is opt-in
//     (Options.Bwrap) and never runs on the fast auto path; if the toolchain is
//     absent it is skipped (not an error) and HYDRA_BWRAP falls back to the
//     system/PATH bwrap.
package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

// pastaBaseURL is the directory of rolling static builds. The architecture path
// segment is appended by archSegment.
const pastaBaseURL = "https://passt.top/builds/latest"

// bubblewrap release pinned for the from-source build, with its published
// sha256sum (github.com/containers/bubblewrap releases). Bump both together to
// upgrade; `mage tools:update` rebuilds against whatever is pinned here.
const (
	bwrapVersion   = "0.11.2"
	bwrapTarSHA256 = "69abc30005d2186baf7737feacd8da35633b93cf5af38838ecff17c5f8e924f6"
)

// downloadTimeout bounds a single binary fetch. The binaries are ~1.4 MB.
const downloadTimeout = 60 * time.Second

// buildTimeout bounds the bwrap source build (download + meson + ninja).
const buildTimeout = 5 * time.Minute

// Dir returns the bundled-tools directory (.hydra/tools/bin), created lazily by
// Provision. It sits under .hydra/tools - separate from .hydra/local's runtime
// state - and is gitignored via the repo's /.hydra/tools/ entry.
func Dir(projectRoot string) string {
	return filepath.Join(paths.GetHydraDirFromProjectRoot(projectRoot), "tools", "bin")
}

// PastaPath is where a bundled pasta lives once provisioned.
func PastaPath(projectRoot string) string {
	return filepath.Join(Dir(projectRoot), "pasta")
}

// BwrapPath is where a bundled (source-built) bwrap lives once provisioned.
func BwrapPath(projectRoot string) string {
	return filepath.Join(Dir(projectRoot), "bwrap")
}

// Options controls what Provision does.
type Options struct {
	// Force re-checks upstream (pasta) / rebuilds (bwrap) even when a copy is
	// already present.
	Force bool
	// Bwrap additionally builds bwrap from source. It is slow and needs a C
	// toolchain, so the fast auto path (ensureToolsEnv) leaves it false; the
	// explicit tools:ensure / tools:update targets set it.
	Bwrap bool
}

// Result reports what Provision did, for human-readable logging by callers.
type Result struct {
	// Available is false when bundling isn't supported on this OS/arch (e.g. a
	// non-x86_64 Linux, or macOS which doesn't use pasta at all). Not an error:
	// the caller simply falls back to a system pasta.
	Available bool
	// Actions is a short log of what happened per file ("downloaded pasta",
	// "pasta up to date", ...).
	Actions []string
}

// archSegment maps the Go arch to passt.top's build directory. passt.top only
// publishes x86_64 today; other arches report unsupported so we fall back to a
// system pasta rather than 404.
func archSegment() (string, bool) {
	switch runtime.GOARCH {
	case "amd64":
		return "x86_64", true
	default:
		return "", false
	}
}

// meta is the sidecar recorded next to a provisioned binary. For downloads
// (pasta) the Last-Modified/Size let an update skip an unchanged upstream build;
// for source builds (bwrap) Version records what was compiled.
type meta struct {
	URL          string `json:"url"`
	Version      string `json:"version,omitempty"`
	LastModified string `json:"last_modified,omitempty"`
	Size         int64  `json:"size,omitempty"`
}

// Provision places the bundled tools under Dir(projectRoot). pasta is downloaded
// if absent (Options.Force also re-checks upstream and re-downloads on change; a
// non-forced call makes no network calls when everything is present). bwrap is
// built from source only when Options.Bwrap is set, and skipped gracefully when
// the C toolchain is missing. Errors are returned so tools:ensure/update can
// surface them, but callers wiring env for dev/serve should treat a failure as
// non-fatal and fall back to system tools.
func Provision(ctx context.Context, projectRoot string, opts Options) (Result, error) {
	if runtime.GOOS != "linux" {
		return Result{Available: false}, nil
	}
	arch, ok := archSegment()
	if !ok {
		return Result{Available: false}, nil
	}

	dir := Dir(projectRoot)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Result{}, errtrace.Wrap(err)
	}

	res := Result{Available: true}
	// pasta plus its AVX2 sibling: pasta execs <path>.avx2 when present, else
	// prints a benign fallback line. Shipping both silences that and uses the
	// faster build on capable CPUs.
	for _, name := range []string{"pasta", "pasta.avx2"} {
		url := fmt.Sprintf("%s/%s/%s", pastaBaseURL, arch, name)
		action, err := fetch(ctx, url, filepath.Join(dir, name), opts.Force)
		if err != nil {
			return res, errtrace.Wrap(fmt.Errorf("provision %s: %w", name, err))
		}
		res.Actions = append(res.Actions, action)
	}

	if opts.Bwrap {
		action, err := provisionBwrap(ctx, dir, opts.Force)
		if err != nil {
			return res, errtrace.Wrap(fmt.Errorf("provision bwrap: %w", err))
		}
		res.Actions = append(res.Actions, action)
	}
	return res, nil
}

// Env returns the HYDRA_* overrides for whichever bundled tools are present,
// skipping any the caller already set (via getenv) so an explicit env always
// wins. getenv is usually os.Getenv; it's a parameter to keep this testable.
func Env(projectRoot string, getenv func(string) string) map[string]string {
	env := map[string]string{}
	if getenv("HYDRA_PASTA") == "" {
		if p := PastaPath(projectRoot); fileExists(p) {
			env["HYDRA_PASTA"] = p
		}
	}
	if getenv("HYDRA_BWRAP") == "" {
		if p := BwrapPath(projectRoot); fileExists(p) {
			env["HYDRA_BWRAP"] = p
		}
	}
	return env
}

// fetch downloads url to dest. When the file already exists and !force it is a
// no-op. When force, it HEADs upstream and re-downloads only if Last-Modified or
// size differs from the recorded sidecar. Returns a short action description.
func fetch(ctx context.Context, url, dest string, force bool) (string, error) {
	base := filepath.Base(dest)
	exists := fileExists(dest)

	if exists && !force {
		return base + " present", nil
	}
	if exists && force {
		changed, err := upstreamChanged(ctx, url, dest)
		if err != nil {
			return "", errtrace.Wrap(err)
		}
		if !changed {
			return base + " up to date", nil
		}
	}

	m, err := download(ctx, url, dest)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	if err := writeMeta(dest, m); err != nil {
		return "", errtrace.Wrap(err)
	}
	if exists {
		return "updated " + base, nil
	}
	return "downloaded " + base, nil
}

// upstreamChanged reports whether the upstream build differs from what we last
// recorded for dest. A missing/unreadable sidecar counts as changed.
func upstreamChanged(ctx context.Context, url, dest string) (bool, error) {
	prev, err := readMeta(dest)
	if err != nil {
		return true, nil //nolint:nilerr // no/again-bad sidecar ⇒ treat as changed
	}
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false, errtrace.Wrap(fmt.Errorf("HEAD %s: %s", url, resp.Status))
	}
	lm := resp.Header.Get("Last-Modified")
	size := resp.ContentLength
	return lm != prev.LastModified || (size >= 0 && size != prev.Size), nil
}

// download streams url to dest atomically (temp file + rename) and returns the
// recorded meta. dest is made executable.
func download(ctx context.Context, url, dest string) (meta, error) {
	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return meta{}, errtrace.Wrap(fmt.Errorf("GET %s: %s", url, resp.Status))
	}

	tmp, err := os.CreateTemp(filepath.Dir(dest), filepath.Base(dest)+".*.tmp")
	if err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op after a successful rename
	n, err := io.Copy(tmp, resp.Body)
	if err != nil {
		tmp.Close()
		return meta{}, errtrace.Wrap(err)
	}
	if err := tmp.Close(); err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	return meta{URL: url, LastModified: resp.Header.Get("Last-Modified"), Size: n}, nil
}

func metaPath(dest string) string { return dest + ".meta" }

func writeMeta(dest string, m meta) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.WriteFile(metaPath(dest), data, 0o644))
}

func readMeta(dest string) (meta, error) {
	data, err := os.ReadFile(metaPath(dest))
	if err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	var m meta
	if err := json.Unmarshal(data, &m); err != nil {
		return meta{}, errtrace.Wrap(err)
	}
	return m, nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

// provisionBwrap builds bubblewrap from its pinned, checksum-verified source
// release into dir/bwrap. It is a graceful no-op - an explanatory action string,
// no error - when bwrap is already present (and !force) or the build toolchain is
// missing, so the fast/dev paths never hard-fail on a host that can't compile it.
func provisionBwrap(ctx context.Context, dir string, force bool) (string, error) {
	dest := filepath.Join(dir, "bwrap")
	exists := fileExists(dest)
	if exists && !force {
		return "bwrap present", nil
	}
	if missing := missingBwrapBuildTools(); len(missing) > 0 {
		return fmt.Sprintf("bwrap skipped - missing build tools %v; using system bwrap", missing), nil
	}

	ctx, cancel := context.WithTimeout(ctx, buildTimeout)
	defer cancel()

	build, err := os.MkdirTemp("", "hydra-bwrap-build-*")
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	defer os.RemoveAll(build)

	// Download + verify the pinned source tarball before we run anything from it.
	tarURL := fmt.Sprintf("https://github.com/containers/bubblewrap/releases/download/v%s/bubblewrap-%s.tar.xz", bwrapVersion, bwrapVersion)
	tarPath := filepath.Join(build, "bubblewrap.tar.xz")
	if err := downloadToFile(ctx, tarURL, tarPath); err != nil {
		return "", errtrace.Wrap(err)
	}
	if err := verifySHA256(tarPath, bwrapTarSHA256); err != nil {
		return "", errtrace.Wrap(err)
	}

	// Extract, configure, and compile only the bwrap binary target.
	if err := runCmd(ctx, build, "tar", "-xJf", tarPath); err != nil {
		return "", errtrace.Wrap(err)
	}
	src := filepath.Join(build, "bubblewrap-"+bwrapVersion)
	// A pinned release compiled with a newer/hardened gcc than it shipped against
	// trips -Werror on format warnings the distro elevates by default (a bare
	// -Wno-error can't undo a specific -Werror=, so we target them). These are the
	// ones bubblewrap 0.11.2 hits on modern gcc; they're demoted to warnings so we
	// still get a working binary. Passed via c_args so they land last and win.
	if err := runCmd(ctx, src, "meson", "setup", "_build", "--buildtype=release",
		"-Dc_args=-Wno-error=format-overflow -Wno-error=format-truncation"); err != nil {
		return "", errtrace.Wrap(err)
	}
	if err := runCmd(ctx, src, "ninja", "-C", "_build", "bwrap"); err != nil {
		return "", errtrace.Wrap(err)
	}

	if err := installFile(filepath.Join(src, "_build", "bwrap"), dest); err != nil {
		return "", errtrace.Wrap(err)
	}
	if err := writeMeta(dest, meta{URL: tarURL, Version: bwrapVersion}); err != nil {
		return "", errtrace.Wrap(err)
	}
	if exists {
		return "rebuilt bwrap " + bwrapVersion, nil
	}
	return "built bwrap " + bwrapVersion, nil
}

// missingBwrapBuildTools returns the build prerequisites that aren't available,
// empty if bwrap can be compiled. libcap is checked via pkg-config since it's a
// header dependency, not a command.
func missingBwrapBuildTools() []string {
	var missing []string
	for _, bin := range []string{"tar", "xz", "meson", "ninja", "cc", "pkg-config"} {
		if _, err := exec.LookPath(bin); err != nil {
			missing = append(missing, bin)
		}
	}
	// Only meaningful once pkg-config exists.
	if _, err := exec.LookPath("pkg-config"); err == nil {
		if exec.Command("pkg-config", "--exists", "libcap").Run() != nil {
			missing = append(missing, "libcap-dev")
		}
	}
	return missing
}

// downloadToFile streams url to dest (no chmod, no meta) for intermediate
// artifacts like the source tarball.
func downloadToFile(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return errtrace.Wrap(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return errtrace.Wrap(fmt.Errorf("GET %s: %s", url, resp.Status))
	}
	f, err := os.Create(dest)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer f.Close()
	if _, err := io.Copy(f, resp.Body); err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

// verifySHA256 fails unless path hashes to the hex-encoded want.
func verifySHA256(path, want string) error {
	f, err := os.Open(path)
	if err != nil {
		return errtrace.Wrap(err)
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return errtrace.Wrap(err)
	}
	got := hex.EncodeToString(h.Sum(nil))
	if got != want {
		return errtrace.Wrap(fmt.Errorf("sha256 mismatch for %s: got %s, want %s", filepath.Base(path), got, want))
	}
	return nil
}

// runCmd runs name in dir, surfacing captured output when it fails so a build
// error is diagnosable.
func runCmd(ctx context.Context, dir, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("%s %v: %w\n%s", name, args, err, out))
	}
	return nil
}

// installFile copies src to dest atomically (temp + rename in dest's dir) and
// makes it executable.
func installFile(src, dest string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return errtrace.Wrap(err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), filepath.Base(dest)+".*.tmp")
	if err != nil {
		return errtrace.Wrap(err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return errtrace.Wrap(err)
	}
	if err := tmp.Close(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(os.Rename(tmpName, dest))
}

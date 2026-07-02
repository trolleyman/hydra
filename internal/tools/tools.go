// Package tools provisions the host-side sandbox helper binaries that Hydra
// prefers to run with but that a stock distro often ships too old (or not at
// all). Today that means pasta: hard egress mode needs a modern pasta with
// --map-host-loopback, which predates Ubuntu 24.04's passt. Rather than make the
// user hunt one down, we download a known-good static build into the project's
// gitignored .hydra/local/bin and point HYDRA_PASTA at it (mirroring the existing
// HYDRA_PASTA / HYDRA_BWRAP env override seams in internal/sandbox and
// internal/egress).
//
// bwrap is deliberately NOT bundled yet: there is no official upstream static
// build to download (it's distro-packaged), so HYDRA_BWRAP stays a manual
// override. The plumbing here is structured so a bwrap entry can be added later
// if a trustworthy static source appears.
//
// Trust model: binaries come from passt.top over TLS. passt.top does not publish
// checksums for its rolling builds, so we cannot pin a hash; TLS + the origin are
// the trust anchor. We record the upstream Last-Modified + size in a sidecar so
// `Provision(force)` can re-download only when the build actually changed.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/paths"
)

// pastaBaseURL is the directory of rolling static builds. The architecture path
// segment is appended by archSegment.
const pastaBaseURL = "https://passt.top/builds/latest"

// downloadTimeout bounds a single binary fetch. The binaries are ~1.4 MB.
const downloadTimeout = 60 * time.Second

// Dir returns the bundled-tools directory (.hydra/local/bin), created lazily by
// Provision. It sits under .hydra/local so it is already gitignored and, being
// under the project, is trivially reachable from mage targets and the server.
func Dir(projectRoot string) string {
	return filepath.Join(paths.GetHydraLocalDirFromProjectRoot(projectRoot), "bin")
}

// PastaPath is where a bundled pasta lives once provisioned.
func PastaPath(projectRoot string) string {
	return filepath.Join(Dir(projectRoot), "pasta")
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

// meta is the sidecar recorded next to a downloaded binary so update checks can
// skip an unchanged upstream build.
type meta struct {
	URL          string `json:"url"`
	LastModified string `json:"last_modified"`
	Size         int64  `json:"size"`
}

// Provision downloads the bundled tools into Dir(projectRoot) if absent. With
// force=true it also re-checks upstream and re-downloads when the build changed
// (by Last-Modified/size); with force=false it only fetches what's missing and
// makes no network calls when everything is present. Errors are returned so a
// dedicated update target can surface them, but callers wiring env for dev/serve
// should treat a failure as non-fatal and fall back to system tools.
func Provision(ctx context.Context, projectRoot string, force bool) (Result, error) {
	if runtime.GOOS != "linux" {
		return Result{Available: false}, nil
	}
	arch, ok := archSegment()
	if !ok {
		return Result{Available: false}, nil
	}

	// Ensure .hydra/local self-ignores before we create anything under it: a
	// standalone `mage tools:ensure` in a fresh checkout can run before the
	// server/daemon has set up the tree, and the downloaded binaries must never
	// surface in git status.
	if err := paths.CreateGitignoreAllInDir(paths.GetHydraLocalDirFromProjectRoot(projectRoot)); err != nil {
		return Result{}, errtrace.Wrap(err)
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
		action, err := fetch(ctx, url, filepath.Join(dir, name), force)
		if err != nil {
			return res, errtrace.Wrap(fmt.Errorf("provision %s: %w", name, err))
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

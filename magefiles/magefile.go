//go:build mage

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"braces.dev/errtrace"
	"github.com/magefile/mage/mg"
	"github.com/magefile/mage/sh"
	"github.com/magefile/mage/target"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/service"
	"github.com/trolleyman/hydra/internal/tools"
)

// getVersion returns the version from git describe.
func getVersion() string {
	v, err := git.Describe(".")
	if err != nil {
		return "dev"
	}
	return v
}

// ANSI color codes for pretty-printing.
const (
	colorReset   = "\u001b[0m"
	colorDim     = "\u001b[2m"
	colorBold    = "\u001b[1m"
	colorBlack   = "\u001b[30m"
	colorRed     = "\u001b[31m"
	colorGreen   = "\u001b[32m"
	colorYellow  = "\u001b[33m"
	colorBlue    = "\u001b[34m"
	colorMagenta = "\u001b[35m"
	colorCyan    = "\u001b[36m"
	colorWhite   = "\u001b[37m"
)

func style(codes ...string) string {
	return strings.Join(codes, "")
}

// devFastAPIPort is the port the Go API server listens on in DevFast mode.
// Vite dev server runs on 26600 and proxies /api, /health, /ws to this port.
const devFastAPIPort = "17842"

// demoAPIPort is the port the simulation server listens on in Demo mode. An
// arbitrary out-of-the-way port (NOT hydra's real 26600) so `mage demo` never
// collides with a real hydra server/daemon; users browse through the Vite dev
// server (http://localhost:5173), which proxies /api + /ws to this port.
const demoAPIPort = "14512"

var (
	// Matching bun
	colorCommandDollar = style(colorReset, colorDim, colorMagenta)
	colorCommandLine   = style(colorReset, colorDim, colorBold)
)

// Quotes a string for display as a shell argument.
func shellQuoteForce(s string) string {
	containsDoubleQuote := strings.Contains(s, `"`)
	containsSingleQuote := strings.Contains(s, `'`)
	if runtime.GOOS == "windows" {
		escaped := strings.ReplaceAll(s, "\t", "`t")
		escaped = strings.ReplaceAll(s, "\n", "`n")
		if !containsDoubleQuote {
			return `"` + escaped + `"`
		} else if !containsSingleQuote {
			return `'` + escaped + `'`
		} else {
			return `"` + strings.ReplaceAll(escaped, `"`, "`\"") + `"`
		}
	} else {
		escaped := strings.ReplaceAll(s, "\t", `\t`)
		escaped = strings.ReplaceAll(s, "\n", `\n`)
		escaped = strings.ReplaceAll(s, `\`, `\\`)
		if !containsDoubleQuote {
			return `"` + escaped + `"`
		} else if !containsSingleQuote {
			return `'` + escaped + `'`
		} else {
			return `"` + strings.ReplaceAll(escaped, `"`, `\"`) + `"`
		}
	}
}

// Quotes a string for display as a shell argument if necessary.
// Args with whitespace or quotes are wrapped in double quotes; embedded " and ' are escaped.
func shellQuote(s string) string {
	if s == "" {
		return `""`
	}
	containsDoubleQuote := strings.Contains(s, `"`)
	containsSingleQuote := strings.Contains(s, `'`)
	containsQuote := containsDoubleQuote || containsSingleQuote
	containsWhitespace := strings.ContainsAny(s, " \t")
	if containsQuote || containsWhitespace {
		return shellQuoteForce(s)
	}
	return s
}

// formatCmd formats a command and its arguments for display.
func formatCmd(cmd string, args ...string) string {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, shellQuote(cmd))
	for _, a := range args {
		parts = append(parts, shellQuote(a))
	}
	return strings.Join(parts, " ")
}

// formatCmdLine formats a command line for display.
func formatCmdLine(cmdLine []string) string {
	parts := make([]string, 0, len(cmdLine))
	for _, a := range cmdLine {
		parts = append(parts, shellQuote(a))
	}
	return strings.Join(parts, " ")
}

// displayPath returns a path suitable for display.
// Paths inside cwd are shown as relative; paths outside are shown as absolute.
func displayPath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	cwd, err := os.Getwd()
	if err != nil {
		return abs
	}
	rel, err := filepath.Rel(cwd, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return abs
	}
	return filepath.ToSlash(rel)
}

// formatPathPair formats a source and destination path pair for display.
// If paths share a common directory, shows as dir/{src -> dst}.
func formatPathPair(src, dst string) string {
	ds := displayPath(src)
	dd := displayPath(dst)
	dirS := filepath.Dir(ds)
	dirD := filepath.Dir(dd)
	if dirS == dirD && dirS != "." {
		return fmt.Sprintf("%s/{%s -> %s}", dirS, filepath.Base(ds), filepath.Base(dd))
	}
	return fmt.Sprintf("%s -> %s", ds, dd)
}

func printCmd(cmd string, args ...string) {
	fmt.Printf("%s$ %s%s%s\n", colorCommandDollar, colorCommandLine, formatCmd(cmd, args...), colorReset)
}

func printCmdBackground(cmd string, args ...string) {
	fmt.Printf("%s$ %s%s%s &%s\n", colorCommandDollar, colorCommandLine, formatCmd(cmd, args...), colorCyan, colorReset)
}

func printCmdLine(cmdLine []string) {
	fmt.Printf("%s$ %s%s%s\n", colorCommandDollar, colorCommandLine, strings.Join(cmdLine, " "), colorReset)
}

// run runs a command silently (no stdout/stderr forwarding)
func run(cmd string, args ...string) error {
	printCmd(cmd, args...)
	if err := sh.Run(cmd, args...); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to run %q: %w", cmd, err))
	}
	return nil
}

// start starts a comand in the background, with no stdout/stderr forwarding
func start(cmd string, args ...string) error {
	printCmdBackground(cmd, args...)
	if err := exec.Command(cmd, args...).Start(); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to start %q: %w", cmd, err))
	}
	return nil
}

// runV runs a command with stdout/stderr forwarded
func runV(cmd string, args ...string) error {
	printCmd(cmd, args...)
	if err := sh.RunV(cmd, args...); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to run %q: %w", cmd, err))
	}
	return nil
}

// runWithEnv runs a command with environment variables set
func runWithEnv(env map[string]string, cmd string, args ...string) error {
	printCmd(cmd, args...)
	if err := sh.RunWith(env, cmd, args...); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to run %q: %w", cmd, err))
	}
	return nil
}

// runInDir runs a command in a specific directory
func runInDir(dir string, cmd string, args ...string) error {
	cmdLine := []string{
		"pushd", displayPath(dir), "&&",
		cmd,
	}
	cmdLine = append(cmdLine, args...)
	cmdLine = append(cmdLine, "&&", "popd")
	printCmdLine(cmdLine)
	c := exec.Command(cmd, args...)
	c.Dir = dir
	err := c.Run()
	printCmd("popd")
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to run %q in %q: %w", cmd, dir, err))
	}
	return nil
}

// runInDirV runs a command in a specific directory with stdout/stderr forwarded
func runInDirV(dir string, cmd string, args ...string) error {
	cmdLine := []string{
		"pushd", displayPath(dir), "&&",
		cmd,
	}
	cmdLine = append(cmdLine, args...)
	cmdLine = append(cmdLine, "&&", "popd")
	printCmdLine(cmdLine)
	c := exec.Command(cmd, args...)
	c.Dir = dir
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	err := c.Run()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to run %q in %q: %w", cmd, dir, err))
	}
	return nil
}

// Custom error to break out of filepath.Walk early when a newer file is found.
var errFoundNewer = errors.New("found newer file")

// dirChangedIgnores checks if any file in srcDir is newer than the dst stamp file.
// It skips any directories matching the names in the ignores slice.
func dirChangedIgnores(dst string, srcDir string, ignores map[string]struct{}) (bool, error) {
	dstInfo, err := os.Stat(dst)
	if err != nil {
		if os.IsNotExist(err) {
			// The stamp file doesn't exist, so we must run the build.
			return true, nil
		}
		return false, errtrace.Wrap(err)
	}
	dstTime := dstInfo.ModTime()

	err = filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return errtrace.Wrap(err)
		}

		if info.IsDir() {
			_, ignore := ignores[info.Name()]
			if ignore {
				// Skip this directory
				return filepath.SkipDir //errtrace:skip // This error must be filepath.SkipDir, not wrapped.
			}
			return nil
		}

		if info.ModTime().After(dstTime) {
			// Signal that we found a newer file and stop walking
			return errFoundNewer //errtrace:skip // This error must be errFoundNewer, not wrapped.
		}
		return nil
	})

	if err == errFoundNewer {
		return true, nil
	}
	return false, errtrace.Wrap(err)
}

// getProjectModTime scans the target files and directories for the most recent modification time.
func getProjectModTime() (time.Time, error) {
	var latest time.Time

	check := func(path string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return errtrace.Wrap(err)
		}
		if info.IsDir() {
			base := filepath.Base(path)
			if base == "dist" || base == "node_modules" || base == ".git" {
				return filepath.SkipDir //errtrace:skip // This error must be filepath.SkipDir, not wrapped.
			}
			return nil
		}
		if info.ModTime().After(latest) {
			latest = info.ModTime()
		}
		return nil
	}

	dirs := []string{"internal", "api", "web"}
	for _, dir := range dirs {
		if err := filepath.Walk(dir, check); err != nil {
			if !os.IsNotExist(err) {
				return latest, errtrace.Wrap(err)
			}
		}
	}

	files := []string{"go.mod", "go.sum", "main.go"}
	for _, file := range files {
		info, err := os.Stat(file)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return latest, errtrace.Wrap(err)
		}
		if info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}

	return latest, nil
}

func Tidy() error {
	err := runV("go", "mod", "tidy")
	if err != nil {
		return errtrace.Wrap(err)
	}
	err = runV("go", "fmt", "./...")
	if err != nil {
		return errtrace.Wrap(err)
	}

	// errtrace-report owns the file list (all .go files except .gen.go, including
	// magefiles/) and runs the go.mod-pinned errtrace tool; the "go" [[tests]]
	// runner uses the same script read-only to surface leftovers as warnings.
	return errtrace.Wrap(runV("go", "run", "./scripts/errtrace-report", "-w"))
}

func addGoBuildDeps() {
	mg.Deps(BuildWeb, GenerateGo)
}

// goBuildTags returns the extra go tool flags for the build. The agent now runs
// natively on the host (no cross-compiled embedded binary), so only explicit
// extra tags are honored.
func goBuildTags(_ bool, extra ...string) []string {
	if len(extra) == 0 {
		return nil
	}
	return []string{"-tags", strings.Join(extra, ",")}
}

// GenSeccomp compiles the seccomp-BPF generator and regenerates the embedded
// blocklist blob for the host architecture (internal/sandbox/seccomp/seccomp_<arch>.bin).
// Run it once per target architecture; the blob is consumed by the Linux
// sandbox via bwrap's --seccomp <fd>. Requires a C compiler and libseccomp.
func GenSeccomp() error {
	if runtime.GOOS != "linux" {
		return errtrace.Wrap(errors.New("GenSeccomp must run on Linux"))
	}
	dir := filepath.Join("internal", "sandbox", "seccomp")
	src := filepath.Join(dir, "seccomp-gen.c")
	gen := filepath.Join(os.TempDir(), "hydra-seccomp-gen")
	out := filepath.Join(dir, fmt.Sprintf("seccomp_%s.bin", runtime.GOARCH))

	if err := sh.RunV("cc", "-O2", "-o", gen, src, "-lseccomp"); err != nil {
		return errtrace.Wrap(fmt.Errorf("compile seccomp generator (need cc + libseccomp-dev): %w", err))
	}
	// Capture raw bytes (the BPF blob is binary; do not trim).
	blob, err := exec.Command(gen).Output()
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("run seccomp generator: %w", err))
	}
	if err := os.WriteFile(out, blob, 0o644); err != nil {
		return errtrace.Wrap(fmt.Errorf("write %s: %w", out, err))
	}
	log.Printf("wrote %s (%d bytes)", out, len(blob))
	return nil
}

// Tools groups commands for the bundled host-side sandbox helper binaries.
type Tools mg.Namespace

// Ensure provisions the bundled sandbox helper binaries into .hydra/tools/bin if
// they're missing: pasta (+ its AVX2 sibling) is downloaded from passt.top, and
// bwrap is built from its pinned source release. bwrap has no official prebuilt
// binary, so this needs a C toolchain (meson/ninja/cc/libcap); without it bwrap
// is skipped gracefully and the system bwrap is used. Run it to provision
// everything up front; the dev/serve targets only auto-provision pasta (fast, no
// build) via ensureToolsEnv.
//
//	mage tools:ensure
func (Tools) Ensure() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}
	res, err := tools.Provision(context.Background(), projectRoot, tools.Options{Bwrap: true})
	if err != nil {
		return errtrace.Wrap(err)
	}
	reportTools(projectRoot, res)
	return nil
}

// Update re-checks upstream and re-downloads pasta when its build changed (by
// Last-Modified/size) and rebuilds bwrap against the pinned source release -
// unlike Ensure, which only fetches/builds what's missing.
//
//	mage tools:update
func (Tools) Update() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}
	res, err := tools.Provision(context.Background(), projectRoot, tools.Options{Force: true, Bwrap: true})
	if err != nil {
		return errtrace.Wrap(err)
	}
	reportTools(projectRoot, res)
	return nil
}

// reportTools prints a Provision result.
func reportTools(projectRoot string, res tools.Result) {
	if !res.Available {
		fmt.Printf("%stools: bundling not available on %s/%s - hydra will use a system pasta%s\n",
			colorYellow, runtime.GOOS, runtime.GOARCH, colorReset)
		return
	}
	for _, a := range res.Actions {
		fmt.Printf("%s✓%s %s\n", colorGreen, colorReset, a)
	}
	fmt.Printf("bundled tools in %s\n", displayPath(tools.Dir(projectRoot)))
}

// ensureToolsEnv provisions the bundled sandbox helpers if missing and points the
// HYDRA_* env overrides at them for the hydra server this target is about to
// launch - but only when the user hasn't already set those vars, so an explicit
// override always wins. It provisions only pasta (a fast download); bwrap is a
// source build reserved for the explicit `mage tools:ensure`, and any already-
// built bwrap is still picked up via tools.Env. Provisioning failures are
// non-fatal: hydra falls back to system tools, so dev/serve still runs.
func ensureToolsEnv() {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		log.Printf("tools: skipping provisioning (%v); using system tools", err)
		return
	}
	if res, err := tools.Provision(context.Background(), projectRoot, tools.Options{}); err != nil {
		log.Printf("tools: provisioning failed (%v); using system tools", err)
	} else {
		for _, a := range res.Actions {
			fmt.Printf("%stools:%s %s\n", colorDim, colorReset, a)
		}
	}
	for k, v := range tools.Env(projectRoot, os.Getenv) {
		os.Setenv(k, v)
		fmt.Printf("%stools:%s %s=%s\n", colorDim, colorReset, k, displayPath(v))
	}
}

func useDevelopmentDatabase() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}
	if os.Getenv("HYDRA_DB_PATH") == "" {
		dbPath := paths.GetDBPathFromProjectRoot(projectRoot)
		if err := os.Setenv("HYDRA_DB_PATH", dbPath); err != nil {
			return errtrace.Wrap(err)
		}
		fmt.Printf("%sdev database:%s %s\n", colorDim, colorReset, displayPath(dbPath))
	}
	return nil
}

func useDevelopmentRuntime() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}
	if os.Getenv("HYDRA_RUNTIME_NAMESPACE") == "" {
		namespace := "checkout-dev:" + projectRoot
		if err := os.Setenv("HYDRA_RUNTIME_NAMESPACE", namespace); err != nil {
			return errtrace.Wrap(err)
		}
		fmt.Printf("%sdev runtime:%s isolated for %s\n", colorDim, colorReset, displayPath(projectRoot))
	}
	return nil
}

const desktopLocalEnv = "HYDRA_DESKTOP_LOCAL"

func useProductionDesktopRuntime() error {
	for _, key := range []string{
		"HYDRA_DB_PATH",
		"HYDRA_RUNTIME_NAMESPACE",
		"HYDRA_API_ADDR",
		"HYDRA_DESKTOP_SERVICE",
		"HYDRA_DESKTOP_READY_FILE",
		desktopLocalEnv,
	} {
		if err := os.Unsetenv(key); err != nil {
			return errtrace.Wrap(err)
		}
	}
	fmt.Printf("%sdesktop runtime:%s production user state\n", colorDim, colorReset)
	return nil
}

func Run() error {
	ensureToolsEnv()
	if err := useDevelopmentDatabase(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := useDevelopmentRuntime(); err != nil {
		return errtrace.Wrap(err)
	}
	addGoBuildDeps()
	args := append([]string{"run"}, goBuildTags(false)...)
	args = append(args, "./", "server")
	return errtrace.Wrap(runV("go", args...))
}

// BuildDesktop builds the native desktop application for the host platform.
// Windows packaging requires HYDRA_PORTABLE_GIT to name an extracted official
// PortableGit distribution of the matching architecture.
func BuildDesktop() error {
	switch runtime.GOOS {
	case "linux":
		return errtrace.Wrap(BuildDesktopLinux())
	case "darwin":
		return errtrace.Wrap(BuildDesktopMac())
	case "windows":
		return errtrace.Wrap(BuildDesktopWindows())
	default:
		return errtrace.Wrap(fmt.Errorf("desktop builds are unsupported on %s", runtime.GOOS))
	}
}

// BuildDesktopLinux builds the Linux GTK/WebKitGTK application explicitly.
func BuildDesktopLinux() error {
	if runtime.GOOS != "linux" {
		return errtrace.Wrap(fmt.Errorf("the Linux desktop app requires a Linux host, not %s", runtime.GOOS))
	}
	addGoBuildDeps()
	output := filepath.Join("dist", "linux", "hydra-desktop")
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	args := append([]string{"build"}, goBuildTags(false, "hydra_desktop")...)
	args = append(args, "-o", output, "./cmd/hydra-desktop")
	if err := runV("go", args...); err != nil {
		return errtrace.Wrap(err)
	}
	share := filepath.Join("dist", "linux", "share")
	applications := filepath.Join(share, "applications")
	icons := filepath.Join(share, "icons", "hicolor", "512x512", "apps")
	if err := os.MkdirAll(applications, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.MkdirAll(icons, 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	if err := sh.Copy(filepath.Join(applications, "dev.hydra.desktop"), filepath.Join("desktop", "linux", "dev.hydra.desktop")); err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(sh.Copy(filepath.Join(icons, "dev.hydra.desktop.png"), filepath.Join("web", "public", "android-chrome-512x512.png")))
}

// BuildDesktopDeb builds an installable Ubuntu/Debian package for the host
// architecture. The package uses the distro GTK/WebKitGTK runtime and leaves
// user configuration, databases, and projects untouched on removal.
func BuildDesktopDeb() error {
	if runtime.GOOS != "linux" {
		return errtrace.Wrap(fmt.Errorf("the .deb desktop package requires a Linux host, not %s", runtime.GOOS))
	}
	if _, err := exec.LookPath("dpkg-deb"); err != nil {
		return errtrace.Wrap(errors.New("dpkg-deb is required to build the Linux desktop package"))
	}
	if err := BuildDesktopLinux(); err != nil {
		return errtrace.Wrap(err)
	}
	arch := map[string]string{"amd64": "amd64", "arm64": "arm64"}[runtime.GOARCH]
	if arch == "" {
		return errtrace.Wrap(fmt.Errorf("the .deb desktop package does not support %s", runtime.GOARCH))
	}
	version := strings.TrimPrefix(getVersion(), "v")
	version = strings.ReplaceAll(version, "-", "+")
	if version == "" || version == "dev" {
		version = "0.0.0+dev"
	} else if version[0] < '0' || version[0] > '9' {
		version = "0.0.0+" + version
	}
	root := filepath.Join("dist", "linux", "deb-root")
	if err := os.RemoveAll(root); err != nil {
		return errtrace.Wrap(err)
	}
	paths := []string{
		filepath.Join(root, "DEBIAN"),
		filepath.Join(root, "usr", "bin"),
		filepath.Join(root, "usr", "share", "applications"),
		filepath.Join(root, "usr", "share", "icons", "hicolor", "512x512", "apps"),
	}
	for _, path := range paths {
		if err := os.MkdirAll(path, 0o755); err != nil {
			return errtrace.Wrap(err)
		}
	}
	control := fmt.Sprintf("Package: hydra-desktop\nVersion: %s\nSection: devel\nPriority: optional\nArchitecture: %s\nMaintainer: Hydra contributors\nDepends: libgtk-4-1, libwebkitgtk-6.0-4\nDescription: Desktop application for Hydra AI orchestration\n Run and review AI coding agents from a native Linux application.\n", version, arch)
	if err := os.WriteFile(filepath.Join(root, "DEBIAN", "control"), []byte(control), 0o644); err != nil {
		return errtrace.Wrap(err)
	}
	files := [][2]string{
		{filepath.Join("dist", "linux", "hydra-desktop"), filepath.Join(root, "usr", "bin", "hydra-desktop")},
		{filepath.Join("desktop", "linux", "dev.hydra.desktop"), filepath.Join(root, "usr", "share", "applications", "dev.hydra.desktop")},
		{filepath.Join("web", "public", "android-chrome-512x512.png"), filepath.Join(root, "usr", "share", "icons", "hicolor", "512x512", "apps", "dev.hydra.desktop.png")},
	}
	for _, file := range files {
		if err := sh.Copy(file[1], file[0]); err != nil {
			return errtrace.Wrap(err)
		}
	}
	output := filepath.Join("dist", "linux", fmt.Sprintf("hydra-desktop_%s_%s.deb", version, arch))
	return errtrace.Wrap(runV("dpkg-deb", "--build", "--root-owner-group", root, output))
}

// BuildDesktopMac builds the AppKit application explicitly on macOS.
func BuildDesktopMac() error {
	if runtime.GOOS != "darwin" {
		return errtrace.Wrap(fmt.Errorf("the macOS desktop app requires a macOS host, not %s", runtime.GOOS))
	}
	return errtrace.Wrap(runV("bash", "desktop/macos/build-app.sh"))
}

// BuildDesktopWindows builds the Windows Forms/WebView2 application. The target
// architecture follows the host; HYDRA_PORTABLE_GIT supplies the matching Git.
func BuildDesktopWindows() error {
	portableGit := os.Getenv("HYDRA_PORTABLE_GIT")
	if portableGit == "" {
		return errtrace.Wrap(errors.New("set HYDRA_PORTABLE_GIT to an extracted official PortableGit directory"))
	}
	powerShell := "powershell"
	if _, err := exec.LookPath("pwsh"); err == nil {
		powerShell = "pwsh"
	}
	targetRuntime := "win-x64"
	if runtime.GOARCH == "arm64" {
		targetRuntime = "win-arm64"
	}
	return errtrace.Wrap(runV(powerShell, "-NoProfile", "-File", "desktop/windows/build-app.ps1",
		"-Runtime", targetRuntime, "-PortableGitDirectory", portableGit))
}

// BuildDesktopAll is the common target for every leg of the desktop build matrix.
// Native UI toolchains are host-only, so each Linux/macOS/Windows runner builds
// and validates its own artifact rather than cross-compiling the other two.
func BuildDesktopAll() error {
	return errtrace.Wrap(BuildDesktop())
}

// RunDesktop builds and runs the native desktop application for the host using
// the production runtime and OS-standard user database.
func RunDesktop() error {
	ensureToolsEnv()
	if err := useProductionDesktopRuntime(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := BuildDesktop(); err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(runDesktop(false))
}

// RunDesktopLocal builds and runs the native desktop application with the
// checkout-local database and runtime used by mage run.
func RunDesktopLocal() error {
	ensureToolsEnv()
	if err := useDevelopmentDatabase(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := useDevelopmentRuntime(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.Setenv(desktopLocalEnv, "1"); err != nil {
		return errtrace.Wrap(err)
	}
	if err := BuildDesktop(); err != nil {
		return errtrace.Wrap(err)
	}
	return errtrace.Wrap(runDesktop(true))
}

func runDesktop(local bool) error {
	switch runtime.GOOS {
	case "linux":
		binary := filepath.Join(".", "dist", "linux", "hydra-desktop")
		if local {
			return errtrace.Wrap(runDesktopLinuxDevelopment(binary))
		}
		return errtrace.Wrap(runV(binary))
	case "darwin":
		// Execute the bundle binary so local mode's database and runtime namespace
		// reach the bundled backend. LaunchServices does not reliably preserve a
		// terminal process's environment.
		return errtrace.Wrap(runV(filepath.Join(".", "dist", "macos", "Hydra.app", "Contents", "MacOS", "Hydra")))
	case "windows":
		targetRuntime := "win-x64"
		if runtime.GOARCH == "arm64" {
			targetRuntime = "win-arm64"
		}
		return errtrace.Wrap(runV(filepath.Join("dist", "windows", targetRuntime, "Hydra", "Hydra.exe")))
	default:
		return errtrace.Wrap(fmt.Errorf("desktop apps are unsupported on %s", runtime.GOOS))
	}
}

// runDesktopLinuxDevelopment keeps Mage alive across Ctrl+C so it can stop the
// detached daemon in this run's HYDRA_RUNTIME_NAMESPACE. The hidden stop command
// inherits that namespace and only stops a desktop-managed daemon. It therefore
// leaves both the global daemon and an existing mage run daemon untouched.
func runDesktopLinuxDevelopment(binary string) error {
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	cmd := exec.Command(binary)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return errtrace.Wrap(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	var runErr error
	select {
	case runErr = <-done:
	case <-ctx.Done():
		_ = cmd.Process.Signal(os.Interrupt)
		select {
		case runErr = <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			runErr = <-done
		}
	}
	cleanup := exec.Command(binary, "__stop-daemon")
	cleanup.Stdout = os.Stdout
	cleanup.Stderr = os.Stderr
	cleanupErr := cleanup.Run()
	if ctx.Err() != nil && runErr != nil {
		runErr = nil
	}
	return errtrace.Wrap(errors.Join(runErr, cleanupErr))
}

func Build() {
	mg.Deps(BuildGo, BuildWeb)
}

// Deploy groups commands for exposing Hydra beyond localhost.
type Deploy mg.Namespace

// Setup interactively generates .hydra/deploy.toml, which holds the auth key
// required for non-localhost access (localhost is trusted unless you opt into
// require_local_auth). Run it once to reach the web UI safely from another
// device, e.g. your phone:
//
//	mage deploy:setup
func (Deploy) Setup() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}

	existing, err := config.LoadDeploy(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	reader := bufio.NewReader(os.Stdin)
	prompt := func(label, def string) string {
		if def != "" {
			fmt.Printf("%s [%s]: ", label, def)
		} else {
			fmt.Printf("%s: ", label)
		}
		line, _ := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			return def
		}
		return line
	}

	fmt.Printf("%s%sHydra remote-access setup%s\n\n", colorBold, colorCyan, colorReset)

	// Auth key: reuse the existing one unless the user asks to regenerate.
	key := existing.AuthKey
	if key != "" {
		fmt.Printf("%sAn auth key already exists in %s.%s\n", colorYellow, displayPath(paths.GetDeployConfigPath(projectRoot)), colorReset)
		if strings.EqualFold(prompt("Generate a new key? (invalidates existing logins) [y/N]", "n"), "y") {
			key = ""
		}
	}
	if key == "" {
		key, err = config.GenerateAuthKey()
		if err != nil {
			return errtrace.Wrap(err)
		}
		fmt.Println("Generated a new random auth key.")
		if custom := prompt("Press enter to accept it, or paste your own key", ""); custom != "" {
			key = custom
		}
	}

	// Whether localhost has to log in too. Off by default (a local browser just
	// works); on when a TLS front-end on this host proxies outside traffic in
	// from 127.0.0.1, which the loopback exemption would otherwise wave through.
	def := "n"
	if existing.RequireLocalAuth {
		def = "y"
	}
	requireLocal := strings.EqualFold(prompt("Require the key from localhost too? (for a tailscale/reverse-proxy front-end) [y/N]", def), "y")

	// Start from the existing config so unrelated sections (e.g. [ngrok]) survive.
	cfg := existing
	cfg.AuthKey = key
	cfg.RequireLocalAuth = requireLocal
	if err := config.SaveDeploy(projectRoot, cfg); err != nil {
		return errtrace.Wrap(err)
	}
	if err := ensureDeployGitignored(projectRoot); err != nil {
		return errtrace.Wrap(err)
	}

	path := paths.GetDeployConfigPath(projectRoot)
	fmt.Printf("\n%s✓ Wrote %s%s\n", colorGreen, displayPath(path), colorReset)
	fmt.Printf("\n%sAuth key:%s %s\n", colorBold, colorReset, key)
	if requireLocal {
		fmt.Println("\nEvery browser - localhost included - must enter this key at the web login")
		fmt.Println("screen (or send 'Authorization: Bearer <key>' for API calls). The CLI's")
		fmt.Println("control socket is unaffected.")
	} else {
		fmt.Println("\nLocalhost is trusted; other devices must enter this key at the web")
		fmt.Println("login screen (or send 'Authorization: Bearer <key>' for API calls).")
	}
	fmt.Println("\nA normal `mage run` / `hydra server` keeps the UI bound to localhost.")
	fmt.Println("Opening it to the network is a separate, explicit step:")
	fmt.Printf("  %smage deploy:service%s   install + serve on 0.0.0.0 as a systemd unit\n", colorBold, colorReset)
	fmt.Printf("  %sHYDRA_API_ADDR=0.0.0.0:%s hydra server%s   serve on 0.0.0.0 in the foreground\n", colorBold, hydraPort(), colorReset)
	fmt.Println("Then browse to http://<this-machine-ip>:26600 and enter the key.")
	return nil
}

// Ngrok scaffolds an ngrok tunnel that exposes the Hydra web UI to the public
// internet, gated by Google sign-in restricted to a single account - mirroring
// the reference deployment. It stores the settings in .hydra/deploy.toml and
// renders .hydra/ngrok.yml (both uncommitted; they embed secrets), then prints
// how to run the tunnel. The tunnel fronts the local Hydra port (HYDRA_PORT,
// default 26600), so run the exposed server alongside it:
//
//	mage deploy:ngrok
func (Deploy) Ngrok() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}

	deploy, err := config.LoadDeploy(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}

	reader := bufio.NewReader(os.Stdin)
	prompt := func(label, def string) string {
		if def != "" {
			fmt.Printf("%s [%s]: ", label, def)
		} else {
			fmt.Printf("%s: ", label)
		}
		line, _ := reader.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			return def
		}
		return line
	}

	fmt.Printf("%s%sHydra ngrok tunnel setup%s\n\n", colorBold, colorCyan, colorReset)
	fmt.Println("The tunnel is guarded by Google sign-in; only the allowed email gets in.")
	fmt.Printf("Get an authtoken + a reserved domain from %shttps://dashboard.ngrok.com%s\n\n", colorCyan, colorReset)

	ng := deploy.Ngrok
	if ng.Name == "" {
		ng.Name = filepath.Base(projectRoot)
	}
	if ng.AllowedEmail == "" {
		ng.AllowedEmail = gitUserEmail(projectRoot)
	}
	ng.Authtoken = prompt("ngrok authtoken", ng.Authtoken)
	ng.Domain = strings.TrimPrefix(strings.TrimPrefix(prompt("Reserved domain (e.g. foo.ngrok-free.dev)", ng.Domain), "https://"), "http://")
	ng.AllowedEmail = prompt("Allowed Google email", ng.AllowedEmail)
	ng.Name = prompt("Endpoint name", ng.Name)

	if ng.Authtoken == "" || ng.Domain == "" || ng.AllowedEmail == "" {
		return errtrace.Wrap(fmt.Errorf("authtoken, domain and allowed email are all required"))
	}

	deploy.Ngrok = ng
	if err := config.SaveDeploy(projectRoot, deploy); err != nil {
		return errtrace.Wrap(err)
	}
	if err := ensureDeployGitignored(projectRoot); err != nil {
		return errtrace.Wrap(err)
	}
	if err := ensureGitignored(projectRoot, "/.hydra/ngrok.yml",
		"# ngrok tunnel config (secret; generated by `mage deploy:ngrok`)"); err != nil {
		return errtrace.Wrap(err)
	}

	port := hydraPort()
	ngrokPath, err := config.WriteNgrokConfig(projectRoot, ng, port)
	if err != nil {
		return errtrace.Wrap(err)
	}

	fmt.Printf("\n%s✓ Wrote %s%s\n", colorGreen, displayPath(ngrokPath), colorReset)
	fmt.Printf("%s  and saved the settings to %s%s\n", colorGreen, displayPath(paths.GetDeployConfigPath(projectRoot)), colorReset)
	fmt.Printf("\n%sExposing localhost:%s at %shttps://%s%s (Google login required).%s\n", colorBold, port, colorCyan, ng.Domain, colorBold, colorReset)
	fmt.Println("\n1. Serve Hydra on that port (in one terminal):")
	fmt.Printf("     %smage deploy:service%s\n", colorBold, colorReset)
	fmt.Println("2. Start the tunnel (in another):")
	fmt.Printf("     %sngrok start --all --config %s%s\n", colorBold, displayPath(ngrokPath), colorReset)
	fmt.Println("\n   Or run it as a persistent background service, like the reference host:")
	fmt.Printf("     %sngrok service install --config %s && ngrok service start%s\n", colorBold, ngrokPath, colorReset)
	return nil
}

// Tailscale exposes the Hydra web UI (and, on request, its live server
// previews) privately over your tailnet with a real trusted HTTPS cert. Unlike
// ngrok this creates NO public URL: Hydra stays bound to localhost, Tailscale is
// the only door, and tailnet membership is the auth - so the UI runs in a secure
// context (clipboard, crypto) and is reachable only from your own devices. See
// docs/remote-access.md.
//
// It prints the exact `tailscale serve` commands and then, when tailscale is
// installed and logged in, offers to run them for you: first the web UI mapping,
// then (separately, since it's the whole port range) the previews. Both prompts
// default to no - applying changes what's reachable over your tailnet. With
// tailscale absent it only prints, so you can run the commands once it's up.
//
//	mage deploy:tailscale
func (Deploy) Tailscale() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}
	port := hydraPort()

	// The preview port range from the project config (defaults 26601-26699). A
	// load error is non-fatal here - fall back to the built-in default range.
	plo, phi := (config.Config{}).ResolvePreviewPortRange()
	if cfg, err := config.Load(projectRoot); err == nil {
		plo, phi = cfg.ResolvePreviewPortRange()
	}
	previewCount := phi - plo + 1

	// Best-effort: resolve this machine's MagicDNS name so the printed URLs are
	// real. Falls back to a placeholder when tailscale isn't installed / up.
	host := tailscaleDNSName()
	haveTailscale := host != ""
	if !haveTailscale {
		host = "<machine>.<tailnet>.ts.net"
	}

	// Build the web UI mapping once, so what we print is exactly what we run.
	// The UI is served on its OWN port rather than the default 443: the previews
	// already take a port each, so keeping the UI on hydraPort() makes the whole
	// deployment one contiguous range (26600-26699 by default) that an ACL or a
	// firewall can name in a single rule. It also leaves 443 free for whatever
	// else the machine serves. Tailscale binds this on the node's tailnet
	// addresses only, so it does not collide with a loopback-bound Hydra on the
	// same port number.
	uiArgs := []string{"serve", "--bg", "--https=" + port, "http://127.0.0.1:" + port}

	fmt.Printf("%s%sHydra Tailscale setup%s\n\n", colorBold, colorCyan, colorReset)
	if haveTailscale {
		fmt.Printf("Detected tailnet name: %s%s%s\n\n", colorCyan, host, colorReset)
	} else {
		fmt.Printf("%s! tailscale not detected on PATH (or not logged in).%s\n", colorYellow, colorReset)
		fmt.Println("  Install it and run `tailscale up` on this machine, then re-run this")
		fmt.Println("  target to apply the mappings and fill in your real *.ts.net name.")
		fmt.Println("  Also enable HTTPS certs for your tailnet in the admin console (DNS -> HTTPS).")
		fmt.Println()
	}

	fmt.Printf("%sExpose the web UI privately over your tailnet:%s\n", colorBold, colorReset)
	fmt.Printf("     %stailscale %s%s\n", colorBold, strings.Join(uiArgs, " "), colorReset)
	fmt.Printf("   -> %shttps://%s:%s/%s  (trusted cert, secure context, tailnet-only)\n\n", colorCyan, host, port, colorReset)

	fmt.Printf("%sExpose live server previews (ports %d-%d, one TLS mapping each):%s\n", colorBold, plo, phi, colorReset)
	fmt.Printf("     %sfor p in $(seq %d %d); do tailscale serve --bg --https=$p http://127.0.0.1:$p; done%s\n", colorBold, plo, phi, colorReset)
	fmt.Printf("   -> a preview on port %d becomes %shttps://%s:%d/%s\n\n", plo, colorCyan, host, plo, colorReset)

	fmt.Printf("%sHydra needs no changes:%s serve proxies in from 127.0.0.1, so localhost:%s is enough\n", colorBold, colorReset, port)
	fmt.Printf("(no auth key, no 0.0.0.0 bind).\n")
	// The preview mappings bind every port in the range on this node's tailnet
	// addresses. That is invisible to a loopback-bound Hydra, but an EXPOSED one
	// binds the wildcard, which collides with a specific-address listener - so
	// without this note the range silently looks "all busy" to it. Hydra now
	// falls back to loopback in that case (internal/preview.allocListener), which
	// is what these mappings proxy to anyway; say so rather than let it surprise.
	fmt.Printf("%sRunning Hydra exposed too%s (deploy:service / HYDRA_API_ADDR=0.0.0.0:...)? The preview\n", colorBold, colorReset)
	fmt.Printf("mappings claim %d-%d on your tailnet addresses, so Hydra binds its preview\n", plo, phi)
	fmt.Printf("listeners on 127.0.0.1 instead - reachable through this TLS front, but not\n")
	fmt.Printf("directly over plain HTTP from the LAN.\n")
	fmt.Printf("Inspect or undo with %stailscale serve status%s / %stailscale serve reset%s.\n\n", colorBold, colorReset, colorBold, colorReset)

	if !haveTailscale {
		fmt.Println("Nothing applied (tailscale not available). Run the commands above once it's up.")
		return nil
	}

	reader := bufio.NewReader(os.Stdin)
	if !promptYesNo(reader, "Apply the web UI mapping now?", false) {
		fmt.Println("Nothing applied. Run the commands above when ready.")
		return nil
	}
	if out, err := runTailscale(uiArgs...); err != nil {
		if s := strings.TrimSpace(out); s != "" {
			fmt.Println(s)
		}
		printTailscaleServeHint(out)
		return errtrace.Wrap(fmt.Errorf("tailscale serve (web UI): %w", err))
	}
	fmt.Printf("%s✓ Web UI served at https://%s:%s/%s\n", colorGreen, host, port, colorReset)

	if promptYesNo(reader, fmt.Sprintf("Also serve the %d preview ports (%d-%d)?", previewCount, plo, phi), false) {
		fmt.Printf("Serving %d preview ports (this takes a moment)...\n", previewCount)
		failed, permErr := 0, false
		for p := plo; p <= phi; p++ {
			ps := fmt.Sprintf("%d", p)
			// Quiet per-port (output captured, not streamed): --bg serve is silent
			// on success, so only the tally below is worth showing across the range.
			out, err := runTailscale("serve", "--bg", "--https="+ps, "http://127.0.0.1:"+ps)
			if err != nil {
				failed++
				if looksLikePermissionError(out) {
					permErr = true
				}
			}
		}
		if failed > 0 {
			fmt.Printf("%s! %d of %d preview ports failed to serve (see `tailscale serve status`).%s\n", colorYellow, failed, previewCount, colorReset)
			if permErr {
				printTailscaleServeHint("operator")
			}
		} else {
			fmt.Printf("%s✓ Served %d preview ports.%s\n", colorGreen, previewCount, colorReset)
		}
	}

	fmt.Printf("\nDone. %stailscale serve status%s shows the live mappings.\n", colorBold, colorReset)
	return nil
}

// runTailscale runs a tailscale subcommand and returns its combined output, so
// callers can both show what it said and inspect the text (e.g. for the operator
// permission hint below).
func runTailscale(args ...string) (string, error) {
	out, err := exec.Command("tailscale", args...).CombinedOutput()
	return string(out), errtrace.Wrap(err)
}

// looksLikePermissionError reports whether a failed `tailscale serve` looks like
// the common "needs operator access / run as root" refusal, so the hint only
// fires for that case and not for an unrelated error.
func looksLikePermissionError(out string) bool {
	s := strings.ToLower(out)
	return strings.Contains(s, "operator") ||
		strings.Contains(s, "permission") ||
		strings.Contains(s, "access denied") ||
		strings.Contains(s, "must be run as root") ||
		strings.Contains(s, "sudo")
}

// printTailscaleServeHint prints the fix for the operator/permission refusal when
// the failure output looks like it (out=="operator" forces it, for the callers
// that already classified the failure).
func printTailscaleServeHint(out string) {
	if !looksLikePermissionError(out) {
		return
	}
	fmt.Printf("%s  Tip: `tailscale serve` needs operator access. Let your user run it without%s\n", colorYellow, colorReset)
	fmt.Printf("%s       sudo once, then re-run this target:  tailscale set --operator=$USER%s\n", colorYellow, colorReset)
}

// promptYesNo asks a yes/no question on stdin, returning def on an empty line or
// EOF (so a non-interactive `mage` run takes the default rather than blocking).
func promptYesNo(reader *bufio.Reader, question string, def bool) bool {
	suffix := "[y/N]"
	if def {
		suffix = "[Y/n]"
	}
	fmt.Printf("%s %s: ", question, suffix)
	line, _ := reader.ReadString('\n')
	line = strings.ToLower(strings.TrimSpace(line))
	if line == "" {
		return def
	}
	return line == "y" || line == "yes"
}

// tailscaleDNSName returns this machine's MagicDNS name (e.g. "hades.tail-scale.ts.net"),
// or "" when tailscale is not installed, not logged in, or its status can't be
// read - callers fall back to a placeholder rather than failing.
func tailscaleDNSName() string {
	if _, err := exec.LookPath("tailscale"); err != nil {
		return ""
	}
	out, err := sh.Output("tailscale", "status", "--json")
	if err != nil {
		return ""
	}
	var st struct {
		Self struct {
			DNSName string `json:"DNSName"`
		} `json:"Self"`
	}
	if err := json.Unmarshal([]byte(out), &st); err != nil {
		return ""
	}
	// MagicDNS names come back fully-qualified with a trailing dot.
	return strings.TrimSuffix(strings.TrimSpace(st.Self.DNSName), ".")
}

// Service installs Hydra as a systemd --user service that serves the web UI on
// 0.0.0.0 (auth-key gated) and restarts on failure, so a
// project's server comes up on login/boot without a terminal. Linux/systemd only.
//
// It (1) builds a full binary with the frontend embedded and installs it to
// ~/.local/bin/hydra, (2) provisions the bundled sandbox tools so hard egress
// works headless, and (3) writes ~/.config/systemd/user/hydra.service pinned to
// this project, the exposed port, and the resolved HYDRA_* + PATH environment. It
// does NOT enable or start the unit - it prints the one-liners - so nothing comes
// up behind your back. Re-run it to refresh the binary, tools, and unit.
//
//	mage deploy:service
func (Deploy) Service() error {
	if runtime.GOOS != "linux" {
		return errtrace.Wrap(fmt.Errorf("deploy:service is Linux/systemd only for now (this is %s); run `hydra server` with HYDRA_API_ADDR set instead", runtime.GOOS))
	}
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}
	// Exposing to the network always requires a password, same as Prod.
	if err := requireAuthKey(); err != nil {
		return errtrace.Wrap(err)
	}

	// Bundle pasta (and build bwrap) so hard egress works under the headless
	// service too - a service can't fall back to a nice shell env.
	if res, err := tools.Provision(context.Background(), projectRoot, tools.Options{Bwrap: true}); err != nil {
		fmt.Printf("%stools: provisioning failed (%v); the service will fall back to a system pasta%s\n", colorYellow, err, colorReset)
	} else {
		reportTools(projectRoot, res)
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return errtrace.Wrap(err)
	}

	// Build a full production binary (frontend embedded) and install it to a
	// stable path the unit can point at.
	if err := BuildWeb(); err != nil {
		return errtrace.Wrap(err)
	}
	binPath := filepath.Join(home, ".local", "bin", "hydra")
	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	buildArgs := append([]string{"build"}, goBuildTags(false)...)
	buildArgs = append(buildArgs, "-o", binPath, "./")
	if err := runV("go", buildArgs...); err != nil {
		return errtrace.Wrap(err)
	}

	// Assemble the unit environment: exposed bind, the bundled/overridden sandbox
	// tools, and the installing shell's PATH (systemd --user starts with a minimal
	// PATH, so without this agents wouldn't find git/claude/node/mise).
	env := map[string]string{"HYDRA_API_ADDR": exposedAPIAddr()}
	for k, v := range tools.Env(projectRoot, os.Getenv) { // bundled tools, if the user hasn't overridden them
		env[k] = v
	}
	if pasta := os.Getenv("HYDRA_PASTA"); pasta != "" {
		env["HYDRA_PASTA"] = pasta
	}
	if bwrap := os.Getenv("HYDRA_BWRAP"); bwrap != "" {
		env["HYDRA_BWRAP"] = bwrap
	}
	if path := os.Getenv("PATH"); path != "" {
		env["PATH"] = path
	}

	unit := service.RenderSystemdUnit(service.UnitOpts{
		ProjectRoot: projectRoot,
		BinPath:     binPath,
		Description: filepath.Base(projectRoot),
		Env:         env,
	})
	unitPath := filepath.Join(home, ".config", "systemd", "user", "hydra.service")
	if err := os.MkdirAll(filepath.Dir(unitPath), 0o755); err != nil {
		return errtrace.Wrap(err)
	}
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return errtrace.Wrap(err)
	}

	fmt.Printf("\n%s✓ Installed %s%s\n", colorGreen, displayPath(binPath), colorReset)
	fmt.Printf("%s✓ Wrote %s%s\n", colorGreen, displayPath(unitPath), colorReset)
	fmt.Printf("\n%sServing %s on %s (auth key required).%s\n", colorBold, filepath.Base(projectRoot), exposedAPIAddr(), colorReset)
	fmt.Println("\nEnable it (nothing is running yet):")
	fmt.Printf("  %ssystemctl --user daemon-reload%s\n", colorBold, colorReset)
	fmt.Printf("  %ssystemctl --user enable --now hydra%s\n", colorBold, colorReset)
	// Without linger a --user unit dies at logout and does not come back until
	// the next login, which is the single most surprising thing about a
	// systemd --user deployment. Offer it rather than leaving it as homework.
	offerLinger()

	fmt.Println("\nLogs / control:")
	fmt.Printf("  %sjournalctl --user -u hydra -f%s\n", colorBold, colorReset)
	fmt.Printf("  %ssystemctl --user restart hydra%s\n", colorBold, colorReset)
	fmt.Printf("\n%sAfter this,%s use the web UI's update button to rebuild and restart -\n", colorBold, colorReset)
	fmt.Println("it builds while the current server keeps serving, and only swaps the")
	fmt.Println("binary once the build succeeds and the result is proven to start.")
	fmt.Printf("\n%sNote:%s the service takes over any daemon started ad-hoc by the CLI for this project.\n", colorYellow, colorReset)
	return nil
}

// offerLinger reports whether the user account already lingers, and offers to
// turn it on if not. Best-effort throughout: loginctl may be absent or refuse,
// and none of that should fail an otherwise successful install.
func offerLinger() {
	user := os.Getenv("USER")
	if user == "" {
		return
	}
	if out, err := sh.Output("loginctl", "show-user", user, "--property=Linger"); err == nil {
		if strings.TrimSpace(out) == "Linger=yes" {
			fmt.Printf("\n%s✓ Lingering is already enabled%s (the service survives logout and reboots).\n", colorGreen, colorReset)
			return
		}
	}

	fmt.Println("\nWithout lingering, a --user service stops when you log out and only")
	fmt.Println("comes back at your next login.")
	reader := bufio.NewReader(os.Stdin)
	if !promptYesNo(reader, fmt.Sprintf("Run `loginctl enable-linger %s` now?", user), true) {
		fmt.Printf("  Skipped. Run it yourself with: %sloginctl enable-linger %s%s\n", colorBold, user, colorReset)
		return
	}
	if err := runV("loginctl", "enable-linger", user); err != nil {
		fmt.Printf("%swarn: enable-linger failed (%v); run it yourself: loginctl enable-linger %s%s\n", colorYellow, err, user, colorReset)
		return
	}
	fmt.Printf("%s✓ Lingering enabled%s\n", colorGreen, colorReset)
}

// gitUserEmail returns the configured git user.email for the project (best
// effort), used as a sensible default for the ngrok allowed-email prompt. Empty
// if git isn't configured or available.
func gitUserEmail(projectRoot string) string {
	out, err := sh.Output("git", "-C", projectRoot, "config", "user.email")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// hydraPort is the TCP port the exposed mage targets bind, overridable with
// HYDRA_PORT. The default is a distinctive registered-range port (not the
// heavily-squatted 8080) so hydra never collides with other local tools and is
// easy to spot in logs; it is deliberately distinct from other services on the
// same box.
func hydraPort() string {
	if port := os.Getenv("HYDRA_PORT"); port != "" {
		return port
	}
	return "26600"
}

// exposedAPIAddr is the bind address used by deploy:service: every interface, so
// the UI is reachable from other devices on the network. Override the port with
// HYDRA_PORT (default 26600).
func exposedAPIAddr() string {
	return "0.0.0.0:" + hydraPort()
}

// requireAuthKey errors unless an auth key is configured, so the exposing
// targets fail early (with guidance) rather than the server refusing to bind.
// Opening the port to the network always requires a password.
func requireAuthKey() error {
	projectRoot, err := paths.GetProjectRootFromCwd()
	if err != nil {
		return errtrace.Wrap(err)
	}
	deploy, err := config.LoadDeploy(projectRoot)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if deploy.AuthKey == "" {
		return errtrace.Wrap(fmt.Errorf(
			"no auth key configured - run `mage deploy:setup` first so the exposed port requires a password"))
	}
	return nil
}

// ensureDeployGitignored makes sure .hydra/deploy.toml is ignored by git (it
// holds a secret). The repo's root .gitignore already lists it; this keeps the
// setup self-sufficient should that entry ever be missing.
func ensureDeployGitignored(projectRoot string) error {
	return errtrace.Wrap(ensureGitignored(projectRoot, "/.hydra/deploy.toml",
		"# Hydra remote-access auth key (secret; generated by `mage deploy:setup`)"))
}

// ensureGitignored appends entry (preceded by comment) to the project's
// .gitignore if it isn't already listed. Used for the per-machine secret files
// (deploy.toml, ngrok.yml) that must never enter git.
func ensureGitignored(projectRoot, entry, comment string) error {
	gitignore := filepath.Join(projectRoot, ".gitignore")
	data, err := os.ReadFile(gitignore)
	if err != nil && !os.IsNotExist(err) {
		return errtrace.Wrap(err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) == entry {
			return nil // already ignored
		}
	}
	content := string(data)
	if len(content) > 0 && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += "\n" + comment + "\n" + entry + "\n"
	return errtrace.Wrap(os.WriteFile(gitignore, []byte(content), 0644))
}

func BuildGoDownload() error {
	stamp := ".mage/go-mod.stamp"

	changed, err := target.Path(stamp, "go.mod", "go.sum")
	if err != nil {
		return errtrace.Wrap(err)
	}
	if !changed {
		return nil
	}

	if err := runV("go", "mod", "download"); err != nil {
		return errtrace.Wrap(err)
	}

	os.MkdirAll(filepath.Dir(stamp), 0755)
	return errtrace.Wrap(os.WriteFile(stamp, nil, 0644))
}

func BuildGo() error {
	addGoBuildDeps()
	mg.Deps(BuildGoDownload)
	args := append([]string{"build"}, goBuildTags(false)...)
	args = append(args, "./...")
	return errtrace.Wrap(runV("go", args...))
}

func BuildGoDeps() error {
	addGoBuildDeps()
	mg.Deps(BuildGoDownload)
	return nil
}

// webPMOnce guards the one-time PATH lookup behind webPM.
var (
	webPMOnce sync.Once
	webPMName string
)

// webPM returns the Node package manager used to install deps and run the
// frontend's package.json scripts: aube when it is on PATH, else npm.
//
// Both drive the committed web/package-lock.json (aube reads and writes npm's
// lockfile in place), so the choice never shows up in the repo - it only buys
// a faster install for developers who have aube. npm is the documented
// baseline because it ships with Node, so a fresh checkout always builds.
func webPM() string {
	webPMOnce.Do(func() {
		webPMName = "npm"
		if _, err := exec.LookPath("aube"); err == nil {
			webPMName = "aube"
		}
	})
	return webPMName
}

// BuildWeb builds the frontend into web/dist, which the binary embeds. There is
// exactly one build flavour - minified with source maps, see web/vite.config.ts -
// so there is one stamp and no build-mode environment to get wrong.
func BuildWeb() error {
	stamp := ".mage/web-build.stamp"

	ignores := map[string]struct{}{
		"dist":         {},
		"node_modules": {},
	}

	// Check if web/ or api/ have newer files than the last build stamp
	webChanged, err := dirChangedIgnores(stamp, "web", ignores)
	if err != nil {
		return errtrace.Wrap(err)
	}

	apiChanged, err := target.Dir(stamp, "api")
	if err != nil {
		return errtrace.Wrap(err)
	}

	if !webChanged && !apiChanged {
		// Say so rather than skipping in silence. This build's output is also the
		// server's self-update log, where "no web lines at all" is indistinguishable
		// from "the frontend was never rebuilt".
		fmt.Println("web: already up to date - skipping the frontend build")
		return nil
	}

	// Run install + build
	if err := runInDirV("web", webPM(), "install"); err != nil {
		return errtrace.Wrap(err)
	}

	if err := runInDirV("web", webPM(), "run", "build"); err != nil {
		return errtrace.Wrap(err)
	}

	// Record successful build
	os.MkdirAll(filepath.Dir(stamp), 0755)
	return errtrace.Wrap(os.WriteFile(stamp, nil, 0644))
}

func GenerateGo() error {
	stamp := ".mage/gen-go.stamp"

	apiChanged, err := target.Dir(stamp, "api")
	if err != nil {
		return errtrace.Wrap(err)
	}

	filesChanged, err := target.Path(stamp, "main.go", "go.mod", "go.sum", "internal/api/config.yaml", "internal/api/server.go")
	if err != nil {
		return errtrace.Wrap(err)
	}

	if !apiChanged && !filesChanged {
		return nil
	}

	if err := os.MkdirAll("internal/api", 0755); err != nil {
		return errtrace.Wrap(err)
	}

	if err := runV("go", "generate", "./..."); err != nil {
		return errtrace.Wrap(err)
	}

	os.MkdirAll(filepath.Dir(stamp), 0755)
	return errtrace.Wrap(os.WriteFile(stamp, nil, 0644))
}

// getGoSourceModTime returns the most recent modification time across Go source
// files and the OpenAPI spec, used to detect when the server needs rebuilding.
func getGoSourceModTime() (time.Time, error) {
	var latest time.Time

	// generatedFiles are produced by the build itself and must not trigger a rebuild.
	generatedFiles := map[string]struct{}{}

	check := func(path string, info os.FileInfo, err error) error {
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return errtrace.Wrap(err)
		}
		if info.IsDir() {
			return nil
		}
		if _, skip := generatedFiles[path]; skip {
			return nil
		}
		if info.ModTime().After(latest) {
			latest = info.ModTime()
		}
		return nil
	}

	dirs := []string{"internal", "api"}
	for _, dir := range dirs {
		if err := filepath.Walk(dir, check); err != nil {
			if !os.IsNotExist(err) {
				return latest, errtrace.Wrap(err)
			}
		}
	}

	files := []string{"go.mod", "go.sum", "main.go"}
	for _, file := range files {
		info, err := os.Stat(file)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return latest, errtrace.Wrap(err)
		}
		if info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}

	return latest, nil
}

func getHydraOutputFile() string {
	hydraOutputFile := filepath.Join(".mage", "hydra")
	if runtime.GOOS == "windows" {
		hydraOutputFile += ".exe"
	}
	return hydraOutputFile
}

// DevFast builds the Go backend and runs it in API-only mode on a background port,
// while running the Vite dev server on http://localhost:26600 for hot-module-replacement.
// Vite proxies /api, /health, and /ws to the Go backend automatically.
// The frontend is never embedded into the binary (hydra_no_frontend build tag).
// BuildWeb is still called to keep the generated TS API client (web/src/api/) in sync;
// it uses stamp-based caching so it is a no-op when neither web/ nor api/ have changed.
//
// There is no rebuild loop here any more. The server restarts itself in place
// (syscall.Exec, same PID - see internal/selfupdate), so the UI's restart and
// update buttons work without mage supervising anything; from here Wait simply
// keeps waiting on the same process. Note an in-app update rebuilds a normal
// binary, without the hydra_no_frontend tag - harmless, since Vite is still the
// thing serving the UI on this port.
func DevFast() error {
	ensureToolsEnv()
	if err := GenerateGo(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := BuildWeb(); err != nil {
		return errtrace.Wrap(err)
	}

	hydraOutputFile := getHydraOutputFile()

	buildBackend := func() error {
		devBuildArgs := append([]string{"build"}, goBuildTags(false, "hydra_no_frontend")...)
		devBuildArgs = append(devBuildArgs, "-o", hydraOutputFile, "./")
		return errtrace.Wrap(runV("go", devBuildArgs...))
	}

	startVite := func() (*exec.Cmd, error) {
		printCmdBackground(webPM(), "run", "dev")
		cmd := exec.Command(webPM(), "run", "dev")
		cmd.Dir = "web"
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		cmd.Env = append(os.Environ(),
			"API_PORT="+devFastAPIPort,
			"DEV_PORT=26600",
		)
		if err := cmd.Start(); err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("start Vite dev server: %w", err))
		}
		return cmd, nil
	}

	if err := buildBackend(); err != nil {
		return errtrace.Wrap(err)
	}

	viteCmd, err := startVite()
	if err != nil {
		return errtrace.Wrap(err)
	}

	printCmd(hydraOutputFile, "server")
	serverCmd := exec.Command(hydraOutputFile, "server")
	serverCmd.Stdout = os.Stdout
	serverCmd.Stderr = os.Stderr
	serverCmd.Env = append(os.Environ(), "HYDRA_API_ADDR=localhost:"+devFastAPIPort)

	serverErr := serverCmd.Run()

	// Always stop Vite when the backend exits.
	if viteCmd.Process != nil {
		_ = viteCmd.Process.Kill()
		_ = viteCmd.Wait()
	}
	return errtrace.Wrap(serverErr)
}

// Demo runs the Hydra server in simulation mode with mock data, serving the
// frontend through the Vite dev server (HMR on http://localhost:5173, which
// proxies /api + /ws to the sim server on :demoAPIPort - an out-of-the-way
// port so a real hydra server on 26600 is untouched). Frontend edits hot-reload
// through Vite without a restart; a change to the mock data in
// internal/http/simulation.go needs mage restarting. This is
// the simulation twin of DevFast - a prod build swapped for --simulation.
func Demo() error {
	ensureToolsEnv()
	// Ensure generated Go code is up to date.
	if err := GenerateGo(); err != nil {
		return errtrace.Wrap(err)
	}
	// Build the frontend once to ensure web/dist/ exists for Go compilation and
	// that node_modules are installed for the Vite dev server below.
	if err := BuildWeb(); err != nil {
		return errtrace.Wrap(err)
	}

	hydraOutputFile := getHydraOutputFile()
	buildBackend := func() error {
		devBuildArgs := append([]string{"build"}, goBuildTags(true)...) // Don't embed Linux binary
		devBuildArgs = append(devBuildArgs, "-o", hydraOutputFile, "./")
		printCmdLine(append([]string{"go"}, devBuildArgs...))
		return errtrace.Wrap(runV("go", devBuildArgs...))
	}

	// Start the Vite dev server once (frontend with HMR on http://localhost:5173).
	// It stays up across backend restarts - HMR handles frontend edits live, and
	// the reload button only needs to rebuild + relaunch the Go sim server.
	printCmdBackground(webPM(), "run", "dev")
	viteCmd := exec.Command(webPM(), "run", "dev")
	viteCmd.Dir = "web"
	viteCmd.Stdout = os.Stdout
	viteCmd.Stderr = os.Stderr
	viteCmd.Env = append(os.Environ(), "API_PORT="+demoAPIPort)
	if err := viteCmd.Start(); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to start Vite dev server: %w", err))
	}
	defer func() {
		if viteCmd.Process != nil {
			viteCmd.Process.Kill()
			viteCmd.Wait()
		}
	}()

	if err := buildBackend(); err != nil {
		return errtrace.Wrap(fmt.Errorf("build error: %w", err))
	}

	printCmd(hydraOutputFile, "server", "--simulation")
	serverCmd := exec.Command(hydraOutputFile, "server", "--simulation")
	serverCmd.Stdout = os.Stdout
	serverCmd.Stderr = os.Stderr
	// Vite proxies /api + /ws to :demoAPIPort, keeping the sim server off hydra's
	// real 26600. The sim server's restart/update endpoints only pretend to do
	// anything (see SimulationServer.UpdateServer), so a click drives the UI's
	// update panel without this process going anywhere - which is the point of
	// simulation mode.
	serverCmd.Env = append(os.Environ(), "HYDRA_API_ADDR=localhost:"+demoAPIPort)
	return errtrace.Wrap(serverCmd.Run())
}

// removeDirContents removes everything inside dir except the named entries,
// leaving dir itself in place. A missing dir is not an error. Any kept entry that
// is already absent is restored from git if it is tracked - so a `mage clean` run
// by an older version (which removed the whole directory) is repaired rather than
// left broken.
func removeDirContents(dir string, keep ...string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			err = os.MkdirAll(dir, 0o755)
		}
		if err != nil {
			return errtrace.Wrap(err)
		}
	}

	kept := make(map[string]bool, len(keep))
	for _, name := range keep {
		kept[name] = false
	}
	for _, entry := range entries {
		if _, ok := kept[entry.Name()]; ok {
			kept[entry.Name()] = true
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return errtrace.Wrap(err)
		}
	}

	for name, present := range kept {
		if present {
			continue
		}
		path := filepath.Join(dir, name)
		// `git show`, not `git checkout` - restoring the file needs no index write, so
		// this also works against a read-only .git (a head running under
		// git_isolation=readonly).
		// exec directly rather than sh.Output, which trims trailing whitespace - the
		// restored file has to be byte-identical to the committed one to keep
		// `git status` clean.
		content, err := exec.Command("git", "show", "HEAD:./"+filepath.ToSlash(path)).Output()
		if err != nil {
			fmt.Printf("warning: %s is missing and could not be restored from git: %v\n", path, err)
			continue
		}
		if err := os.WriteFile(path, content, 0o644); err != nil {
			return errtrace.Wrap(err)
		}
	}
	return nil
}

// Clean removes the build cache and build files
func Clean() error {
	if err := os.RemoveAll(".mage"); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to remove .mage directory: %w", err))
	}

	// Empty web/dist rather than removing it: the committed dist/.gitkeep holds the
	// directory open for web/embed.go's `//go:embed all:dist`, so deleting it breaks
	// `go build` until the frontend is rebuilt (see web/vite.config.ts
	// keepDistGitkeep). Keeping the file untouched also keeps `git status` clean.
	if err := removeDirContents("web/dist", ".gitkeep"); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to clean web/dist directory: %w", err))
	}

	if err := os.RemoveAll("web/node_modules"); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to remove web/node_modules directory: %w", err))
	}

	// Playwright's default outputDir (web/playwright.config.ts sets none) - traces,
	// screenshots and videos from failed e2e runs, plus .last-run.json.
	if err := os.RemoveAll("web/test-results"); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to remove web/test-results directory: %w", err))
	}

	// The gitignored root binary from a manual `go build -o hydra .`. Mage itself
	// builds to .mage/, so this is only ever hand-made - but it is still stale build
	// output, and one left on PATH-adjacent `./hydra` is a confusing thing to run.
	// Only a regular file is removed, so a directory that happens to be named `hydra`
	// is never touched.
	for _, name := range []string{"hydra", "hydra.exe"} {
		if info, err := os.Lstat(name); err == nil && info.Mode().IsRegular() {
			if err := os.Remove(name); err != nil {
				return errtrace.Wrap(fmt.Errorf("failed to remove %s binary: %w", name, err))
			}
		}
	}

	// Deliberately NOT removed:
	//   .hydra/local/* - runtime state, not build output: live head worktrees, the DB,
	//     chat events, and the agent caches (captured gemini system prompts, the claude
	//     overlay). Wiping it would break heads that are currently running.
	//   .hydra/tools/  - pasta/bwrap provisioned by `mage tools:ensure`; removing them
	//     forces a network re-download and heads cannot start without them.
	//   the Go build cache - shared with every other Go project on the machine, so
	//     that is `go clean -cache`, the user's call and not ours.

	fmt.Println("Clean complete.")
	return nil
}

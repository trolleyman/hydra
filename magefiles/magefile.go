//go:build mage

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
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

// devRestartExitCode must match the constant in internal/http/handlers.go.
const devRestartExitCode = 42

// devFastAPIPort is the port the Go API server listens on in DevFast mode.
// Vite dev server runs on 26600 and proxies /api, /health, /ws to this port.
const devFastAPIPort = "17842"

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

// runInDirWithEnvV runs a command in a specific directory with environment variables set and stdout/stderr forwarded
func runInDirWithEnvV(dir string, env map[string]string, cmd string, args ...string) error {
	cmdLine := []string{
		"pushd", displayPath(dir), "&&",
	}
	for k, v := range env {
		cmdLine = append(cmdLine, fmt.Sprintf("%s=%s", k, v))
	}
	cmdLine = append(cmdLine, cmd)
	cmdLine = append(cmdLine, args...)
	cmdLine = append(cmdLine, "&&", "popd")
	printCmdLine(cmdLine)
	c := exec.Command(cmd, args...)
	c.Dir = dir
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	c.Env = os.Environ()
	for k, v := range env {
		c.Env = append(c.Env, fmt.Sprintf("%s=%s", k, v))
	}
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

func Run() error {
	ensureToolsEnv()
	addGoBuildDeps()
	args := append([]string{"run"}, goBuildTags(false)...)
	args = append(args, "./", "server")
	return errtrace.Wrap(runV("go", args...))
}

func Build() {
	mg.Deps(BuildGo, BuildWeb)
}

// Deploy groups commands for exposing Hydra beyond localhost.
type Deploy mg.Namespace

// Setup interactively generates .hydra/deploy.toml, which holds the auth key
// required for non-localhost access (localhost is always trusted). Run it once
// to reach the web UI safely from another device, e.g. your phone:
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

	cfg := config.DeployConfig{AuthKey: key}
	if err := config.SaveDeploy(projectRoot, cfg); err != nil {
		return errtrace.Wrap(err)
	}
	if err := ensureDeployGitignored(projectRoot); err != nil {
		return errtrace.Wrap(err)
	}

	path := paths.GetDeployConfigPath(projectRoot)
	fmt.Printf("\n%s✓ Wrote %s%s\n", colorGreen, displayPath(path), colorReset)
	fmt.Printf("\n%sAuth key:%s %s\n", colorBold, colorReset, key)
	fmt.Println("\nLocalhost is always trusted; other devices must enter this key at the web")
	fmt.Println("login screen (or send 'Authorization: Bearer <key>' for API calls).")
	fmt.Println("\nA normal `mage run` / `hydra server` keeps the UI bound to localhost.")
	fmt.Println("Opening it to the network is a separate, explicit step:")
	fmt.Printf("  %smage prod%s        build + serve on 0.0.0.0 (production)\n", colorBold, colorReset)
	fmt.Printf("  %smage devExpose%s   serve on 0.0.0.0 with dev auto-rebuild\n", colorBold, colorReset)
	fmt.Println("Then browse to http://<this-machine-ip>:26662 and enter the key.")
	return nil
}

// Ngrok scaffolds an ngrok tunnel that exposes the Hydra web UI to the public
// internet, gated by Google sign-in restricted to a single account - mirroring
// the reference deployment. It stores the settings in .hydra/deploy.toml and
// renders .hydra/ngrok.yml (both uncommitted; they embed secrets), then prints
// how to run the tunnel. The tunnel fronts the local Hydra port (HYDRA_PORT,
// default 26662), so run `mage prod` alongside it:
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
	fmt.Printf("     %smage prod%s\n", colorBold, colorReset)
	fmt.Println("2. Start the tunnel (in another):")
	fmt.Printf("     %sngrok start --all --config %s%s\n", colorBold, displayPath(ngrokPath), colorReset)
	fmt.Println("\n   Or run it as a persistent background service, like the reference host:")
	fmt.Printf("     %sngrok service install --config %s && ngrok service start%s\n", colorBold, ngrokPath, colorReset)
	return nil
}

// Service installs Hydra as a systemd --user service that serves the web UI on
// 0.0.0.0 (auth-key gated, like `mage prod`) and restarts on failure, so a
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
		return errtrace.Wrap(fmt.Errorf("deploy:service is Linux/systemd only for now (this is %s); use `mage prod` in the foreground", runtime.GOOS))
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
	fmt.Println("\nTo keep it running after you log out / across reboots without a login:")
	fmt.Printf("  %sloginctl enable-linger %s%s\n", colorBold, os.Getenv("USER"), colorReset)
	fmt.Println("\nLogs / control:")
	fmt.Printf("  %sjournalctl --user -u hydra -f%s\n", colorBold, colorReset)
	fmt.Printf("  %ssystemctl --user restart hydra%s   (also picks up a re-run of this target)\n", colorBold, colorReset)
	fmt.Printf("\n%sNote:%s the service takes over any daemon started ad-hoc by the CLI for this project.\n", colorYellow, colorReset)
	return nil
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

// hydraPort is the TCP port the dev/exposed mage targets bind, overridable with
// HYDRA_PORT. The default is a distinctive registered-range port (not the
// heavily-squatted 8080) so hydra never collides with other local tools and is
// easy to spot in logs; it is deliberately distinct from other services on the
// same box.
func hydraPort() string {
	if port := os.Getenv("HYDRA_PORT"); port != "" {
		return port
	}
	return "26662"
}

// exposedAPIAddr is the bind address used by the exposing targets (Prod /
// DevExpose): every interface, so the UI is reachable from other devices on the
// network. Override the port with HYDRA_PORT (default 26662).
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

// Prod builds the full project and serves the web UI on 0.0.0.0 (every network
// interface), reachable from other devices such as your phone. Non-localhost
// clients must present the auth key from `mage deploy:setup`; Prod refuses to
// start without one. Override the port with HYDRA_PORT (default 26662).
func Prod() error {
	if err := requireAuthKey(); err != nil {
		return errtrace.Wrap(err)
	}
	ensureToolsEnv()
	addGoBuildDeps()
	addr := exposedAPIAddr()
	os.Setenv("HYDRA_API_ADDR", addr)
	fmt.Printf("%sServing on http://%s - reachable from other devices; auth key required%s\n", colorBold, addr, colorReset)
	args := append([]string{"run"}, goBuildTags(false)...)
	args = append(args, "./", "server")
	return errtrace.Wrap(runV("go", args...))
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

func BuildWeb() error {
	stamp := ".mage/web-build.stamp"
	isDev := os.Getenv("HYDRA_DEV_BUILD") == "1"
	if isDev {
		stamp = ".mage/web-build-dev.stamp"
	}

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
		return nil
	}

	// Run bun install + build
	if err := runInDirV("web", "bun", "install"); err != nil {
		return errtrace.Wrap(err)
	}

	buildArgs := []string{"run", "build"}
	env := map[string]string{}
	if isDev {
		env["NODE_ENV"] = "development"
		buildArgs = append(buildArgs, "--", "--mode", "development")
	}

	if err := runInDirWithEnvV("web", env, "bun", buildArgs...); err != nil {
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

// Dev builds once and runs the server with the /api/dev/restart endpoint enabled.
// Use the UI restart button to trigger a full rebuild and restart.
// For auto-reload on file changes use DevAutoReload instead.
func Dev() error {
	ensureToolsEnv()
	os.Setenv("HYDRA_DEV_BUILD", "1")
	return errtrace.Wrap(devServerLoop([]string{"HYDRA_API_ADDR=localhost:" + hydraPort()}))
}

// DevExpose is Dev, but binds the web UI to 0.0.0.0 (every network interface) so
// you can iterate on the UI from another device, e.g. your phone, with the same
// rebuild-on-UI-restart loop. Non-localhost clients must present the auth key
// from `mage deploy:setup`; DevExpose refuses to start without one. Override the
// port with HYDRA_PORT (default 26662).
func DevExpose() error {
	if err := requireAuthKey(); err != nil {
		return errtrace.Wrap(err)
	}
	ensureToolsEnv()
	os.Setenv("HYDRA_DEV_BUILD", "1")
	addr := exposedAPIAddr()
	fmt.Printf("%sDev server exposed on http://%s - reachable from other devices; auth key required%s\n", colorBold, addr, colorReset)
	return errtrace.Wrap(devServerLoop([]string{"HYDRA_API_ADDR=" + addr}))
}

// devServerLoop builds the frontend + backend and runs the dev server with the
// UI restart endpoint enabled, rebuilding and restarting whenever the UI asks
// for it (exit code devRestartExitCode). extraEnv is appended to the server's
// environment - DevExpose uses it to set HYDRA_API_ADDR for a 0.0.0.0 bind.
func devServerLoop(extraEnv []string) error {
	for {
		if err := GenerateGo(); err != nil {
			return errtrace.Wrap(err)
		}
		if err := BuildWeb(); err != nil {
			return errtrace.Wrap(err)
		}

		hydraOutputFile := getHydraOutputFile()
		devBuildArgs := append([]string{"build"}, goBuildTags(false)...)
		devBuildArgs = append(devBuildArgs, "-o", hydraOutputFile, "./")
		if err := runV("go", devBuildArgs...); err != nil {
			return errtrace.Wrap(err)
		}

		printCmd(hydraOutputFile, "server")
		serverCmd := exec.Command(hydraOutputFile, "server")
		serverCmd.Stdout = os.Stdout
		serverCmd.Stderr = os.Stderr
		serverCmd.Env = append(os.Environ(), "HYDRA_DEV_RESTART=1")
		serverCmd.Env = append(serverCmd.Env, extraEnv...)

		if err := serverCmd.Run(); err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) && exitErr.ExitCode() == devRestartExitCode {
				log.Println("Restart requested via UI, rebuilding...")
				time.Sleep(1 * time.Second) // Give the OS time to release the port
				continue
			}
			return errtrace.Wrap(err)
		}
		return nil // clean exit
	}
}

// DevFast builds the Go backend and runs it in API-only mode on a background port,
// while running the Vite dev server on http://localhost:26600 for hot-module-replacement.
// Vite proxies /api, /health, and /ws to the Go backend automatically.
// Clicking the UI restart button rebuilds the backend and restarts both servers.
// The frontend is never embedded into the binary (hydra_no_frontend build tag).
// BuildWeb is still called to keep the generated TS API client (web/src/api/) in sync;
// it uses stamp-based caching so it is a no-op when neither web/ nor api/ have changed.
func DevFast() error {
	ensureToolsEnv()
	os.Setenv("HYDRA_DEV_BUILD", "1")
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
		printCmdBackground("bun", "run", "dev")
		cmd := exec.Command("bun", "run", "dev")
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

	for {
		viteCmd, err := startVite()
		if err != nil {
			return errtrace.Wrap(err)
		}

		printCmd(hydraOutputFile, "server")
		serverCmd := exec.Command(hydraOutputFile, "server")
		serverCmd.Stdout = os.Stdout
		serverCmd.Stderr = os.Stderr
		serverCmd.Env = append(os.Environ(),
			"HYDRA_DEV_RESTART=1",
			"HYDRA_API_ADDR=localhost:"+devFastAPIPort,
		)

		serverErr := serverCmd.Run()

		// Always stop Vite when the backend exits.
		if viteCmd.Process != nil {
			viteCmd.Process.Kill()
			viteCmd.Wait()
		}

		if serverErr != nil {
			var exitErr *exec.ExitError
			if errors.As(serverErr, &exitErr) && exitErr.ExitCode() == devRestartExitCode {
				log.Println("Restart requested via UI, rebuilding backend...")
				time.Sleep(1 * time.Second) // Give the OS time to release the port
				if err := GenerateGo(); err != nil {
					fmt.Printf("GenerateGo error: %v\n", err)
					time.Sleep(2 * time.Second)
				} else if err := BuildWeb(); err != nil {
					fmt.Printf("BuildWeb error: %v\n", err)
					time.Sleep(2 * time.Second)
				} else if err := buildBackend(); err != nil {
					fmt.Printf("build error: %v\n", err)
					time.Sleep(2 * time.Second)
				}
				continue
			}
			return errtrace.Wrap(serverErr)
		}
		return nil // clean exit
	}
}

// DevAutoReload runs the Go API server (restarting on Go source changes) and the Vite
// frontend dev server in parallel for fast UI iteration with hot module replacement.
// Access the frontend at http://localhost:5173; API calls are proxied to the dev backend.
// The /api/dev/restart UI button is also available alongside auto-reload.
func DevAutoReload() error {
	os.Setenv("HYDRA_DEV_BUILD", "1")
	// Ensure generated Go code is up to date.
	if err := GenerateGo(); err != nil {
		return errtrace.Wrap(err)
	}
	// Build the frontend once to ensure web/dist/ exists for Go compilation.
	// Subsequent frontend changes are handled by the Vite dev server with HMR.
	if err := BuildWeb(); err != nil {
		return errtrace.Wrap(err)
	}

	// Start the Vite dev server (frontend with HMR on http://localhost:5173).
	printCmdBackground("bun", "run", "dev")
	viteCmd := exec.Command("bun", "run", "dev")
	viteCmd.Dir = "web"
	viteCmd.Stdout = os.Stdout
	viteCmd.Stderr = os.Stderr
	if err := viteCmd.Start(); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to start Vite dev server: %w", err))
	}
	defer func() {
		if viteCmd.Process != nil {
			viteCmd.Process.Kill()
			viteCmd.Wait()
		}
	}()

	// Watch Go source files and restart the API server on changes.
	var serverCmd *exec.Cmd
	var serverMu sync.Mutex
	defer func() {
		serverMu.Lock()
		defer serverMu.Unlock()
		if serverCmd != nil && serverCmd.Process != nil {
			serverCmd.Process.Kill()
			serverCmd.Wait()
		}
	}()

	// needRestart is set to 1 when the server exits with the restart code.
	var needRestart atomic.Int32

	hydraOutputFile := getHydraOutputFile()
	startServer := func() {
		serverMu.Lock()
		defer serverMu.Unlock()
		printCmd(hydraOutputFile, "server")
		serverCmd = exec.Command(hydraOutputFile, "server")
		serverCmd.Stdout = os.Stdout
		serverCmd.Stderr = os.Stderr
		serverCmd.Env = append(os.Environ(), "HYDRA_DEV_RESTART=1")
		if err := serverCmd.Start(); err != nil {
			fmt.Printf("start error: %v\n", err)
			return
		}
		go func(cmd *exec.Cmd) {
			err := cmd.Wait()
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) && exitErr.ExitCode() == devRestartExitCode {
				log.Println("Restart requested via UI, rebuilding...")
				needRestart.Store(1)
			}
		}(serverCmd)
	}

	var lastBuild time.Time
	for {
		latest, err := getGoSourceModTime()
		if err != nil {
			return errtrace.Wrap(err)
		}

		if latest.After(lastBuild) || needRestart.CompareAndSwap(1, 0) {
			lastBuild = time.Now()

			time.Sleep(1 * time.Second) // Give the OS time to release the port

			if err := GenerateGo(); err != nil {
				fmt.Printf("GenerateGo error: %v\n", err)
				time.Sleep(2 * time.Second)
				continue
			}

			serverMu.Lock()
			if serverCmd != nil && serverCmd.Process != nil {
				printCmd("restarting server")
				serverCmd.Process.Kill()
				serverCmd.Wait()
			}
			serverMu.Unlock()

			devBuildArgs := append([]string{"build"}, goBuildTags(false)...)
			devBuildArgs = append(devBuildArgs, "-o", hydraOutputFile, "./")
			printCmdLine(append([]string{"go"}, devBuildArgs...))
			buildCmd := exec.Command("go", devBuildArgs...)
			buildCmd.Stdout = os.Stdout
			buildCmd.Stderr = os.Stderr
			if err := buildCmd.Run(); err != nil {
				fmt.Printf("build error: %v\n", err)
				time.Sleep(2 * time.Second)
				continue
			}

			startServer()
		}

		time.Sleep(1 * time.Second)
	}
}

// Preview builds the full project and runs the server, reloading it when any
// tracked file changes (Go source, frontend, or API spec).
func Preview() error {
	var cmd *exec.Cmd

	defer func() {
		if cmd != nil && cmd.Process != nil {
			cmd.Process.Kill()
		}
	}()

	var lastRun time.Time

	for {
		latest, err := getProjectModTime()
		if err != nil {
			return errtrace.Wrap(err)
		}

		if latest.After(lastRun) {
			lastRun = time.Now()

			if err := GenerateGo(); err != nil {
				fmt.Printf("GenerateGo error: %v\n", err)
				time.Sleep(2 * time.Second)
				continue
			}
			if err := BuildWeb(); err != nil {
				fmt.Printf("BuildWeb error: %v\n", err)
				time.Sleep(2 * time.Second)
				continue
			}

			if cmd != nil && cmd.Process != nil {
				printCmd("restarting server")
				cmd.Process.Kill()
				cmd.Wait()
			}

			previewBuildArgs := append([]string{"build"}, goBuildTags(false)...)
			previewBuildArgs = append(previewBuildArgs, "-o", ".mage/server", "./")
			buildCmd := exec.Command("go", previewBuildArgs...)
			buildCmd.Stdout = os.Stdout
			buildCmd.Stderr = os.Stderr
			if err := buildCmd.Run(); err != nil {
				fmt.Printf("build error: %v\n", err)
				time.Sleep(2 * time.Second)
				continue
			}

			cmd = exec.Command("./.mage/server", "server")
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			if err := cmd.Start(); err != nil {
				fmt.Printf("start error: %v\n", err)
			}
		}

		time.Sleep(1 * time.Second)
	}
}

// Demo runs the Hydra server in simulation mode with mock data, serving the
// frontend through the Vite dev server (HMR on http://localhost:5173, which
// proxies /api + /ws to the sim server on :8080). Frontend edits hot-reload
// through Vite without a restart; the UI reload button rebuilds the Go backend
// and relaunches the sim server (exit code devRestartExitCode), so a change to
// the mock data in internal/http/simulation.go goes live with one click. This is
// the simulation twin of DevFast - a prod build swapped for --simulation.
func Demo() error {
	ensureToolsEnv()
	os.Setenv("HYDRA_DEV_BUILD", "1")
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
	printCmdBackground("bun", "run", "dev")
	viteCmd := exec.Command("bun", "run", "dev")
	viteCmd.Dir = "web"
	viteCmd.Stdout = os.Stdout
	viteCmd.Stderr = os.Stderr
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

	for {
		printCmd(hydraOutputFile, "server", "--simulation")
		serverCmd := exec.Command(hydraOutputFile, "server", "--simulation")
		serverCmd.Stdout = os.Stdout
		serverCmd.Stderr = os.Stderr
		// HYDRA_DEV_RESTART=1 arms the sim server's reload button (SimulationServer.
		// DevRestart), so a click exits with devRestartExitCode and this loop
		// rebuilds. Vite proxies /api + /ws to :26600 (the sim server's default).
		serverCmd.Env = append(os.Environ(), "HYDRA_DEV_RESTART=1")

		serverErr := serverCmd.Run()
		if serverErr != nil {
			var exitErr *exec.ExitError
			if errors.As(serverErr, &exitErr) && exitErr.ExitCode() == devRestartExitCode {
				log.Println("Restart requested via UI, rebuilding backend...")
				time.Sleep(1 * time.Second) // Give the OS time to release the port
				if err := GenerateGo(); err != nil {
					fmt.Printf("GenerateGo error: %v\n", err)
					time.Sleep(2 * time.Second)
				} else if err := buildBackend(); err != nil {
					fmt.Printf("build error: %v\n", err)
					time.Sleep(2 * time.Second)
				}
				continue
			}
			return errtrace.Wrap(serverErr)
		}
		return nil // clean exit
	}
}

// Clean removes the build cache and build files
func Clean() error {
	if err := os.RemoveAll(".mage"); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to remove .mage directory: %w", err))
	}

	if err := os.RemoveAll("web/dist"); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to remove web/dist directory: %w", err))
	}

	if err := os.RemoveAll("web/node_modules"); err != nil {
		return errtrace.Wrap(fmt.Errorf("failed to remove web/node_modules directory: %w", err))
	}

	// TODO: Remove .hydra cached files?

	fmt.Println("Clean complete.")
	return nil
}

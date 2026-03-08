//go:build mage

package main

import (
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
)

// getVersion returns the version from git describe.
func getVersion() string {
	out, err := sh.Output("git", "describe", "--tags", "--always", "--dirty")
	if err != nil {
		return "dev"
	}
	v := strings.TrimSpace(out)
	if v == "" {
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
// Vite dev server runs on 8080 and proxies /api, /health, /ws to this port.
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

	// Collect all .go files except .gen.go files, including magefiles/magefile.go
	// (which is excluded from ./... due to its build tag).
	skipDirs := map[string]struct{}{
		".git": {}, "vendor": {}, "node_modules": {}, ".mage": {}, ".hydra": {},
	}
	var goFiles []string
	err = filepath.Walk(".", func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return errtrace.Wrap(walkErr)
		}
		if info.IsDir() {
			if _, skip := skipDirs[info.Name()]; skip {
				return filepath.SkipDir //errtrace:skip // This error must be filepath.SkipDir, not wrapped.
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, ".gen.go") {
			goFiles = append(goFiles, path)
		}
		return nil
	})
	if err != nil {
		return errtrace.Wrap(err)
	}

	args := append([]string{"run", "braces.dev/errtrace/cmd/errtrace@latest", "-w"}, goFiles...)
	return errtrace.Wrap(runV("go", args...))
}

func addGoBuildDeps() {
	mg.Deps(BuildWeb, GenerateGo, BuildLinuxBinary)
}

// goBuildTags returns the extra go tool flags needed for the current platform.
// On non-Linux hosts this activates embedding of the cross-compiled Linux binary.
func goBuildTags(extra ...string) []string {
	var tags []string
	if runtime.GOOS != "linux" {
		tags = append(tags, "hydra_embed_linux_binary")
	}
	tags = append(tags, extra...)
	if len(tags) == 0 {
		return nil
	}
	return []string{"-tags", strings.Join(tags, ",")}
}

// BuildLinuxBinary cross-compiles hydra for linux/GOARCH and writes the result
// to internal/docker/hydra-linux so it can be embedded by the main build.
// No-op on Linux hosts.
func BuildLinuxBinary() error {
	if runtime.GOOS == "linux" {
		return nil
	}
	output := filepath.Join("internal", "docker", "hydra-linux")
	return errtrace.Wrap(runWithEnv(
		map[string]string{"GOOS": "linux", "GOARCH": runtime.GOARCH},
		"go", "build", "-o", output, ".",
	))
}

func Run() error {
	addGoBuildDeps()
	args := append([]string{"run"}, goBuildTags()...)
	args = append(args, "./", "server")
	return errtrace.Wrap(runV("go", args...))
}

func Build() {
	mg.Deps(BuildGo, BuildWeb)
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
	args := append([]string{"build"}, goBuildTags()...)
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
	generatedFiles := map[string]struct{}{
		filepath.Join("internal", "docker", "hydra-linux"): {},
	}

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
	os.Setenv("HYDRA_DEV_BUILD", "1")
	for {
		if err := GenerateGo(); err != nil {
			return errtrace.Wrap(err)
		}
		if err := BuildLinuxBinary(); err != nil {
			return errtrace.Wrap(err)
		}
		if err := BuildWeb(); err != nil {
			return errtrace.Wrap(err)
		}

		hydraOutputFile := getHydraOutputFile()
		devBuildArgs := append([]string{"build"}, goBuildTags()...)
		devBuildArgs = append(devBuildArgs, "-o", hydraOutputFile, "./")
		if err := runV("go", devBuildArgs...); err != nil {
			return errtrace.Wrap(err)
		}

		printCmd(hydraOutputFile, "server")
		serverCmd := exec.Command(hydraOutputFile, "server")
		serverCmd.Stdout = os.Stdout
		serverCmd.Stderr = os.Stderr
		serverCmd.Env = append(os.Environ(), "HYDRA_DEV_RESTART=1")

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
// while running the Vite dev server on http://localhost:8080 for hot-module-replacement.
// Vite proxies /api, /health, and /ws to the Go backend automatically.
// Clicking the UI restart button rebuilds the backend and restarts both servers.
// The frontend is never embedded into the binary (hydra_no_frontend build tag).
// BuildWeb is still called to keep the generated TS API client (web/src/api/) in sync;
// it uses stamp-based caching so it is a no-op when neither web/ nor api/ have changed.
func DevFast() error {
	os.Setenv("HYDRA_DEV_BUILD", "1")
	if err := GenerateGo(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := BuildLinuxBinary(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := BuildWeb(); err != nil {
		return errtrace.Wrap(err)
	}

	hydraOutputFile := getHydraOutputFile()

	buildBackend := func() error {
		devBuildArgs := append([]string{"build"}, goBuildTags("hydra_no_frontend")...)
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
			"DEV_PORT=8080",
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
				} else if err := BuildLinuxBinary(); err != nil {
					fmt.Printf("BuildLinuxBinary error: %v\n", err)
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
// Access the frontend at http://localhost:5173; API calls are proxied to http://localhost:8080.
// The /api/dev/restart UI button is also available alongside auto-reload.
func DevAutoReload() error {
	os.Setenv("HYDRA_DEV_BUILD", "1")
	// Ensure generated Go code is up to date.
	if err := GenerateGo(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := BuildLinuxBinary(); err != nil {
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
			if err := BuildLinuxBinary(); err != nil {
				fmt.Printf("BuildLinuxBinary error: %v\n", err)
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

			devBuildArgs := append([]string{"build"}, goBuildTags()...)
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

			previewBuildArgs := append([]string{"build"}, goBuildTags()...)
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

// Demo runs the Hydra server in simulation mode with mock data.
func Demo() error {
	os.Setenv("HYDRA_DEV_BUILD", "1")
	// Ensure generated Go code is up to date.
	if err := GenerateGo(); err != nil {
		return errtrace.Wrap(err)
	}
	if err := BuildLinuxBinary(); err != nil {
		return errtrace.Wrap(err)
	}
	// Build the frontend once to ensure web/dist/ exists for Go compilation.
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

	hydraOutputFile := getHydraOutputFile()
	devBuildArgs := append([]string{"build"}, goBuildTags()...)
	devBuildArgs = append(devBuildArgs, "-o", hydraOutputFile, "./")
	printCmdLine(append([]string{"go"}, devBuildArgs...))
	buildCmd := exec.Command("go", devBuildArgs...)
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		return errtrace.Wrap(fmt.Errorf("build error: %w", err))
	}

	printCmd(hydraOutputFile, "server", "--simulation")
	serverCmd := exec.Command(hydraOutputFile, "server", "--simulation")
	serverCmd.Stdout = os.Stdout
	serverCmd.Stderr = os.Stderr
	// Use a different port if needed, but 8080 is default.
	// Vite dev server proxies to 8080 by default.

	if err := serverCmd.Run(); err != nil {
		return errtrace.Wrap(err)
	}

	return nil
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

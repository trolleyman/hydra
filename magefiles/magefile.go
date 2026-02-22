//go:build mage

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/magefile/mage/mg"
	"github.com/magefile/mage/sh"
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
		return fmt.Errorf("failed to run %q: %w", cmd, err)
	}
	return nil
}

// start starts a comand in the background, with no stdout/stderr forwarding
func start(cmd string, args ...string) error {
	printCmdBackground(cmd, args...)
	if err := exec.Command(cmd, args...).Start(); err != nil {
		return fmt.Errorf("failed to start %q: %w", cmd, err)
	}
	return nil
}

// runV runs a command with stdout/stderr forwarded
func runV(cmd string, args ...string) error {
	printCmd(cmd, args...)
	if err := sh.RunV(cmd, args...); err != nil {
		return fmt.Errorf("failed to run %q: %w", cmd, err)
	}
	return nil
}

// runWithEnv runs a command with environment variables set
func runWithEnv(env map[string]string, cmd string, args ...string) error {
	printCmd(cmd, args...)
	if err := sh.RunWith(env, cmd, args...); err != nil {
		return fmt.Errorf("failed to run %q: %w", cmd, err)
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
		return fmt.Errorf("failed to run %q in %q: %w", cmd, dir, err)
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
		return fmt.Errorf("failed to run %q in %q: %w", cmd, dir, err)
	}
	return nil
}

func Tidy() error {
	err := runV("go", "mod", "tidy")
	if err != nil {
		return err
	}
	err = runV("go", "fmt", "./...")
	if err != nil {
		return err
	}
	err = runV("go", "run", "braces.dev/errtrace/cmd/errtrace@latest", "-w", "./...")
	if err != nil {
		return err
	}
	return nil
}

func addGoBuildDeps() {
	mg.Deps(Build.TypeScript, Generate.Go)
}

func Run() error {
	addGoBuildDeps()
	return runV("go", "run", "./")
}

type Build mg.Namespace

func (Build) All() {
	mg.Deps(Build.Go, Build.TypeScript)
}

func (Build) Go() error {
	addGoBuildDeps()
	err := runV("go", "mod", "vendor")
	if err != nil {
		return err
	}
	return runV("go", "build", "./...")
}

func (Build) TypeScript() error {
	err := runInDirV("web", "bun", "install")
	if err != nil {
		return err
	}
	return runInDirV("web", "bun", "run", "build")
}

type Generate mg.Namespace

func (Generate) Go() error {
	// Ensure internal/api exists
	if err := os.MkdirAll("internal/api", 0755); err != nil {
		return err
	}

	return runV("go", "generate", "./...")
}

package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/common"
)

// Version is set at build time via -ldflags "-X main.Version=x.y.z".
var Version = "dev"

var debugMode bool

var rootCmd = &cobra.Command{
	Use:   "hydra",
	Short: "AI agent orchestrator",
	Long: `Hydra is an AI agent orchestrator.
It manages AI coding agents running in isolated Docker containers and git worktrees.`,
	Version: Version,
	// Suppress usage on runtime errors (but show it on arg errors).
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		cmd.SilenceUsage = true
	},
	SilenceErrors: true, // Handle errors ourselves
}

func main() {
	rootCmd.PersistentFlags().BoolVar(&debugMode, "debug", false, "Print full stack traces on error")

	setupLogging()
	if err := rootCmd.Execute(); err != nil {
		if debugMode || os.Getenv("HYDRA_DEBUG") == "1" {
			prettyPrintErrTrace(os.Stderr, err)
		} else {
			fmt.Fprintf(os.Stderr, "\033[1;31mError:\033[0m %s\n", err.Error())
		}
		os.Exit(1)
	}
}

func setupLogging() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	var logDir string
	if runtime.GOOS == "windows" {
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		logDir = filepath.Join(localAppData, "hydra", "logs")
	} else {
		logDir = filepath.Join(home, ".local", "share", "hydra", "logs")
	}

	rl, err := common.NewRotatingLogger(filepath.Join(logDir, "hydra.log"), 5*1024*1024, 5)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not set up file logging: %v\n", err)
		return
	}

	log.SetOutput(io.MultiWriter(os.Stderr, rl))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}

// prettyPrintErrTrace walks the error chain extracting errtrace frames directly,
// formatting them Python-style (most recent call last) with colors and source snippets.
func prettyPrintErrTrace(w io.Writer, originalErr error) {
	var frames []runtime.Frame

	// Walk the error chain outside-in.
	// Since errtrace wraps errors as they return UP the stack, the outermost wrapper
	// is the highest-level function (e.g., main), and the innermost wrapper is where
	// the error originated.
	curr := originalErr
	for curr != nil {
		if frame, inner, ok := errtrace.UnwrapFrame(curr); ok {
			frames = append(frames, frame)
			curr = inner
		} else {
			// Step over standard library wraps like fmt.Errorf
			curr = errors.Unwrap(curr)
		}
	}

	fmt.Fprintln(w, "\033[36mTraceback (most recent call last):\033[0m")
	cwd, _ := os.Getwd()

	for _, f := range frames {
		// Omit standard library boilerplate and Cobra's internal routing
		if strings.HasPrefix(f.Function, "runtime.") || strings.HasPrefix(f.Function, "github.com/spf13/cobra.") {
			continue
		}

		displayPath := f.File
		if cwd != "" {
			if relPath, err := filepath.Rel(cwd, f.File); err == nil && !strings.HasPrefix(relPath, "..") {
				displayPath = relPath
			}
		}

		fmt.Fprintf(w, "  File \033[33m%s\033[0m, line \033[32m%d\033[0m, in \033[35m%s\033[0m\n", displayPath, f.Line, f.Function)

		code := getSourceLine(f.File, f.Line)
		if code != "" {
			fmt.Fprintf(w, "    \033[2m%s\033[0m\n", strings.TrimSpace(code))
		}
	}

	fmt.Fprintf(w, "\n\033[1;31mError:\033[0m %s\n", originalErr.Error())
}

// getSourceLine opens the file using its original absolute path to extract the specific line of code.
func getSourceLine(filepath string, targetLine int) string {
	file, err := os.Open(filepath)
	if err != nil {
		return ""
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	currentLine := 1
	for scanner.Scan() {
		if currentLine == targetLine {
			return scanner.Text()
		}
		currentLine++
	}
	return ""
}

package common

import (
	"log"
	"os/exec"
	"runtime"
	"strings"
)

// ANSI color codes for command display - matches bun style.
const (
	colorReset   = "\u001b[0m"
	colorDim     = "\u001b[2m"
	colorBold    = "\u001b[1m"
	colorMagenta = "\u001b[35m"
)

var (
	colorCmdDollar = colorReset + colorDim + colorMagenta
	colorCmdLine   = colorReset + colorDim + colorBold
)

// PrintCmd prints a command and its arguments in the bun style:
//
//	$ git worktree add ...
func PrintCmd(cmd string, args ...string) {
	parts := make([]string, 0, len(args)+1)
	parts = append(parts, ShellQuote(cmd))
	for _, a := range args {
		parts = append(parts, ShellQuote(a))
	}
	log.Printf("%s$ %s%s%s\n", colorCmdDollar, colorCmdLine, strings.Join(parts, " "), colorReset)
}

// PrintExecCmd prints an *exec.Cmd in the bun style.
func PrintExecCmd(cmd *exec.Cmd) {
	if len(cmd.Args) == 0 {
		return
	}
	PrintCmd(cmd.Args[0], cmd.Args[1:]...)
}

// ShellQuote returns s quoted for shell display if it contains whitespace or quotes.
func ShellQuote(s string) string {
	if s == "" {
		return `""`
	}
	hasDouble := strings.Contains(s, `"`)
	hasSingle := strings.Contains(s, `'`)
	hasSpace := strings.ContainsAny(s, " \t")
	if !hasDouble && !hasSingle && !hasSpace {
		return s
	}
	if runtime.GOOS == "windows" {
		escaped := strings.ReplaceAll(s, "\t", "`t")
		escaped = strings.ReplaceAll(escaped, "\n", "`n")
		if !hasDouble {
			return `"` + escaped + `"`
		} else if !hasSingle {
			return `'` + escaped + `'`
		}
		return `"` + strings.ReplaceAll(escaped, `"`, "`\"") + `"`
	}
	escaped := strings.ReplaceAll(s, "\t", `\t`)
	escaped = strings.ReplaceAll(escaped, "\n", `\n`)
	escaped = strings.ReplaceAll(escaped, `\`, `\\`)
	if !hasDouble {
		return `"` + escaped + `"`
	} else if !hasSingle {
		return `'` + escaped + `'`
	}
	return `"` + strings.ReplaceAll(escaped, `"`, `\"`) + `"`
}

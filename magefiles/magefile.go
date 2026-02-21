//go:build mage

package main

import (
	"fmt"
	"strings"

	"github.com/magefile/mage/sh"
)

func run(cmd string, args ...string) {
	var builder strings.Builder
	builder.WriteString(cmd)
	for _, arg := range args {
		builder.WriteByte(' ')
		if strings.ContainsAny(arg, " \t\n\"'") {
			builder.WriteString(fmt.Sprintf("%q", arg))
		} else {
			builder.WriteString(arg)
		}
	}
	// Print with a blue "$" and bold command line
	fmt.Printf("\033[34m$\033[0m \033[1m%s\033[0m\n", builder.String())
	sh.RunV(cmd, args...) // TODO: Check error code
}

func Tidy() {
	run("go", "mod", "tidy")
	run("go", "fmt", "./...")
	run("go", "run", "braces.dev/errtrace/cmd/errtrace@latest", "-w", "./...")
}

func Run() {
	run("go", "run", "./cmd/hydra")
}

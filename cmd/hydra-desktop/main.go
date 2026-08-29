package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/trolleyman/hydra/internal/cli"
	"github.com/trolleyman/hydra/internal/desktop"
)

func main() {
	// daemon.EnsureRunning starts os.Executable with this hidden command. Carry
	// the ordinary backend entrypoint in the desktop binary so it can manage its
	// own daemon without a second Hydra installation.
	if len(os.Args) > 1 && os.Args[1] == "__daemon" {
		cli.Run()
		return
	}

	url := flag.String("url", "", "local Hydra server URL")
	project := flag.String("project", "", "project root to select after opening Hydra")
	diagnostics := flag.Bool("diagnostics", false, "print desktop capability diagnostics as JSON")
	flag.Parse()
	if *diagnostics {
		if err := json.NewEncoder(os.Stdout).Encode(desktop.Diagnostics()); err != nil {
			fmt.Fprintf(os.Stderr, "hydra-desktop: write diagnostics: %v\n", err)
			os.Exit(1)
		}
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	serverURL, err := desktop.ResolveServer(ctx, *url, *project)
	if err == nil {
		if flag.NArg() > 1 {
			err = fmt.Errorf("only one Hydra deep link may be opened at a time")
		} else if flag.NArg() == 1 {
			serverURL, err = desktop.ApplyDeepLink(serverURL, flag.Arg(0))
		}
	}
	if err == nil {
		err = desktop.Run(serverURL)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "hydra-desktop: %v\n", err)
		os.Exit(1)
	}
}

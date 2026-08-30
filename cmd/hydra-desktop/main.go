package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/trolleyman/hydra/internal/cli"
	"github.com/trolleyman/hydra/internal/daemon"
	"github.com/trolleyman/hydra/internal/desktop"
)

const desktopLocalEnv = "HYDRA_DESKTOP_LOCAL"

func useProductionEnvironmentByDefault() {
	if os.Getenv(desktopLocalEnv) == "1" {
		return
	}
	for _, key := range []string{
		"HYDRA_STATE_DIR",
		"HYDRA_API_ADDR",
		"HYDRA_DESKTOP_SERVICE",
		"HYDRA_DESKTOP_READY_FILE",
	} {
		_ = os.Unsetenv(key)
	}
}

func main() {
	// daemon.EnsureRunning starts os.Executable with this hidden command. Carry
	// the ordinary backend entrypoint in the desktop binary so it can manage its
	// own daemon without a second Hydra installation.
	if len(os.Args) > 1 && os.Args[1] == "__daemon" {
		cli.Run()
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__stop-daemon" {
		config := desktop.CurrentLaunchConfig()
		if os.Getenv("HYDRA_STATE_DIR") == "" && config.BackendLifetime != "command-owned" {
			fmt.Fprintln(os.Stderr, "hydra-desktop: refusing daemon cleanup without a command-owned launch")
			os.Exit(1)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if !daemon.IsDesktopManaged("") {
			return
		}
		if err := daemon.StopDaemon(ctx, ""); err != nil {
			fmt.Fprintf(os.Stderr, "hydra-desktop: stop development daemon: %v\n", err)
			os.Exit(1)
		}
		return
	}
	useProductionEnvironmentByDefault()
	launchConfig := desktop.CurrentLaunchConfig()
	fmt.Fprintf(os.Stderr, "hydra desktop launch: %s\n", launchConfig.String())

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

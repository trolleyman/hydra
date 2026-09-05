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

// The desktop executable also embeds the backend CLI. A desktop-managed daemon
// binds its own executable into each sandbox, so the in-sandbox supervisor,
// hooks, and MCP server must be dispatched to cli.Run instead of recursively
// launching another desktop window.
func isBackendCommand(arg string) bool {
	switch arg {
	case "__daemon", "__sandbox-init", "__desktop-connect", "__desktop-active", "mcp", "gate", "trigger-hook", "host-run", "sandbox-remove":
		return true
	default:
		return false
	}
}

func isHeadEnvironment() bool {
	return os.Getenv("HYDRA_HEAD_ID") != ""
}

func isAutomationLaunch(args []string) bool {
	return len(args) > 0 && (args[0] == "--automation" || args[0] == "--automation=true")
}

func main() {
	// daemon.EnsureRunning starts os.Executable with this hidden command. Carry
	// the ordinary backend entrypoint in the desktop binary so it can manage its
	// own daemon without a second Hydra installation.
	if len(os.Args) > 1 && isBackendCommand(os.Args[1]) {
		cli.Run()
		return
	}
	// The desktop executable is also injected into head sandboxes as HYDRA_BIN.
	// Only its backend command surface belongs there. Fail closed on a bare or
	// misspelled invocation instead of trying to open GTK or start a daemon from
	// inside the head.
	if isHeadEnvironment() && !isAutomationLaunch(os.Args[1:]) {
		fmt.Fprintln(os.Stderr, "hydra-desktop: a backend command is required inside a head sandbox")
		os.Exit(2)
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
	automation := flag.Bool("automation", false, "allow WebDriver to control the Linux desktop webview")
	diagnostics := flag.Bool("diagnostics", false, "print desktop capability diagnostics as JSON")
	developerTools := flag.Bool("devtools", os.Getenv("HYDRA_DESKTOP_DEVTOOLS") == "1", "enable the WebKit Web Inspector (Ctrl+Shift+I)")
	compositingIndicators := flag.Bool("compositing-indicators", os.Getenv("HYDRA_DESKTOP_COMPOSITING_INDICATORS") == "1", "draw WebKit compositing borders and repaint counters")
	disablePersistentAnimations := flag.Bool("disable-persistent-animations", os.Getenv("HYDRA_DESKTOP_DISABLE_PERSISTENT_ANIMATIONS") == "1", "hold looping web animations still to avoid WebKitGTK repaint churn")
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
		err = desktop.Run(serverURL, desktop.RunOptions{
			Automation:                  *automation,
			DeveloperTools:              *developerTools,
			CompositingIndicators:       *compositingIndicators,
			DisablePersistentAnimations: *disablePersistentAnimations,
		})
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "hydra-desktop: %v\n", err)
		os.Exit(1)
	}
}

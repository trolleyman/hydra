package main

import (
	"context"
	"fmt"
	"os"

	"github.com/trolleyman/hydra/internal/agenthost"
)

var version = "dev"

func main() {
	if len(os.Args) == 3 && os.Args[1] == "gate" {
		if err := agenthost.RunGate(os.Args[2], os.Stdin, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintf(os.Stderr, "hydra-agent-host gate: %v\n", err)
		}
		return
	}
	if err := agenthost.Run(context.Background(), os.Stdin, os.Stdout, os.Stderr, version); err != nil {
		fmt.Fprintf(os.Stderr, "hydra-agent-host: %v\n", err)
		os.Exit(1)
	}
}

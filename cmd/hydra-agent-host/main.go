package main

import (
	"context"
	"fmt"
	"os"

	"github.com/trolleyman/hydra/internal/agenthost"
)

var version = "dev"

func main() {
	if err := agenthost.Run(context.Background(), os.Stdin, os.Stdout, os.Stderr, version); err != nil {
		fmt.Fprintf(os.Stderr, "hydra-agent-host: %v\n", err)
		os.Exit(1)
	}
}

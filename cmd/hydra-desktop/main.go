package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/trolleyman/hydra/internal/desktop"
)

func main() {
	url := flag.String("url", "", "local Hydra server URL (required)")
	flag.Parse()

	if err := desktop.Run(*url); err != nil {
		fmt.Fprintf(os.Stderr, "hydra-desktop: %v\n", err)
		os.Exit(1)
	}
}

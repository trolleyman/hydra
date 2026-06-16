package cli

import (
	"braces.dev/errtrace"
	"github.com/spf13/cobra"
	"github.com/trolleyman/hydra/internal/nshost"
)

var sandboxInitFlags struct {
	socket string
}

func init() {
	sandboxInitCmd.Flags().StringVar(&sandboxInitFlags.socket, "socket", "", "Control socket path to listen on")
	rootCmd.AddCommand(sandboxInitCmd)
}

// sandboxInitCmd is the supervisor that runs as pid-1 inside a namespace host's
// bwrap. It owns the sandbox's single mount namespace (and its writable COW
// overlay); the daemon asks it, over --socket, to spawn PTY children (the agent
// and any bash terminals) which all share that one namespace. Internal; launched
// by the daemon, never run by users directly.
var sandboxInitCmd = &cobra.Command{
	Use:    "__sandbox-init",
	Hidden: true,
	Short:  "Run the in-sandbox PTY supervisor (internal)",
	RunE: func(_ *cobra.Command, _ []string) error {
		if sandboxInitFlags.socket == "" {
			return errtrace.Errorf("__sandbox-init: --socket is required")
		}
		return errtrace.Wrap(nshost.Serve(sandboxInitFlags.socket))
	},
}

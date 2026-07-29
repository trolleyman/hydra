//go:build !unix

package selfupdate

import (
	"fmt"
	"net"
	"os"

	"braces.dev/errtrace"
)

// Windows has no exec(2) - a new process is always a new PID - so restarting in
// place is not available there. CanRestart reports false and the UI hides the
// control rather than offering something that cannot work. Restarting a Windows
// service would go through the service manager instead; see
// docs/windows-support.md.
const execSupported = false

// ListenerFDEnv is declared for symmetry so callers need no build tags.
const ListenerFDEnv = "HYDRA_LISTENER_FD"

func KeepListener(net.Listener) (*os.File, []string, error) {
	return nil, nil, errtrace.Wrap(fmt.Errorf("carrying a listener across a restart is not supported on this platform"))
}

func InheritedListener() net.Listener { return nil }

func execSelf(string, []*os.File, []string) error {
	return errtrace.Wrap(fmt.Errorf("restarting in place is not supported on this platform"))
}

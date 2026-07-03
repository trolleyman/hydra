//go:build linux

package sandbox

import (
	"embed"
	"fmt"
	"os"
	"runtime"

	"braces.dev/errtrace"
)

// seccompBlobs holds the prebuilt seccomp-BPF programs, one per architecture,
// generated from seccomp/seccomp-gen.c by the `mage genSeccomp` target. Only
// architectures with a committed .bin are filtered; others skip seccomp.
//
//go:embed seccomp/seccomp_*.bin
var seccompBlobs embed.FS

// seccompBlob returns the embedded BPF program for the current architecture, or
// nil if none is committed for it.
func seccompBlob() []byte {
	data, err := seccompBlobs.ReadFile("seccomp/seccomp_" + runtime.GOARCH + ".bin")
	if err != nil || len(data) == 0 {
		return nil
	}
	return data
}

// seccompFile materializes the architecture's seccomp blob onto a still-linked,
// read-only file, returning the open fd (for direct inheritance via bwrap
// --seccomp <fd>) and its path (so a wrapper shell can reopen it - see the
// EgressWrap preExec contract). It returns (nil, "", nil) when no blob is
// available for this architecture. The caller owns cleanup: close the fd and, if
// it does not otherwise unlink, os.Remove the path.
func seccompFile() (*os.File, string, error) {
	blob := seccompBlob()
	if blob == nil {
		return nil, "", nil
	}

	tmp, err := os.CreateTemp("", "hydra-seccomp-*")
	if err != nil {
		return nil, "", errtrace.Wrap(fmt.Errorf("create seccomp temp: %w", err))
	}
	path := tmp.Name()

	if _, err := tmp.Write(blob); err != nil {
		_ = tmp.Close()
		_ = os.Remove(path)
		return nil, "", errtrace.Wrap(fmt.Errorf("write seccomp blob: %w", err))
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(path)
		return nil, "", errtrace.Wrap(fmt.Errorf("close seccomp temp: %w", err))
	}

	// Reopen read-only so the inherited fd starts at offset 0.
	f, err := os.Open(path)
	if err != nil {
		_ = os.Remove(path)
		return nil, "", errtrace.Wrap(fmt.Errorf("reopen seccomp blob: %w", err))
	}
	return f, path, nil
}

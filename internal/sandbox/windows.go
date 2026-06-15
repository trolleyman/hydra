//go:build windows

package sandbox

import "errors"

// ErrUnsupported is returned by BuildSpec on platforms without a sandbox backend.
var ErrUnsupported = errors.New("hydra sandboxing is not yet supported on Windows (Windows Sandbox backend is planned)")

// Available reports that sandboxing is unavailable on Windows for now.
func Available() (bool, string) {
	return false, ErrUnsupported.Error()
}

// BuildSpec is not yet implemented on Windows, except for the non-sandboxed
// shell, which runs the command directly with no confinement.
func BuildSpec(opts Options) (*Spec, error) {
	if opts.NoSandbox {
		return rawSpec(opts)
	}
	return nil, ErrUnsupported
}

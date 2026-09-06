//go:build windows

package sandbox

import "errors"
import "braces.dev/errtrace"

// ErrUnsupported is returned by BuildSpec on platforms without a sandbox backend.
var ErrUnsupported = errors.New("hydra sandboxing is not yet supported on Windows (Windows Sandbox backend is planned)")

// Available reports that sandboxing is unavailable on Windows for now.
func Available() (bool, string) {
	return false, ErrUnsupported.Error()
}

// BuildSpec is not yet implemented on Windows, except for the non-sandboxed
// shell, which runs the command directly with no confinement.
func BuildSpec(opts Options) (*Spec, error) {
	if err := PrepareSharedCaches(&opts); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if opts.NoSandbox {
		return errtrace.Wrap2(rawSpec(opts))
	}
	return nil, errtrace.Wrap(ErrUnsupported)
}

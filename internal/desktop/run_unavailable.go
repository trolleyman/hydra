//go:build !linux || !cgo || !hydra_desktop

package desktop

import "fmt"
import "braces.dev/errtrace"

func run(string) error {
	return errtrace.Wrap(fmt.Errorf("desktop shell is unavailable; build on Linux with CGO_ENABLED=1 and -tags hydra_desktop"))
}

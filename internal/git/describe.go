package git

import "braces.dev/errtrace"

// Describe returns a string similar to `git describe --tags --always --dirty`.
func Describe(projectRoot string) (string, error) {
	return errtrace.Wrap2(gitOutput(projectRoot, "describe", "--tags", "--always", "--dirty"))
}

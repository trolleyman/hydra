package git

// Describe returns a string similar to `git describe --tags --always --dirty`.
func Describe(projectRoot string) (string, error) {
	return gitOutput(projectRoot, "describe", "--tags", "--always", "--dirty")
}

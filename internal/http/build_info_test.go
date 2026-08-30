package http

import "testing"

func TestGitCommitPrefersStampedValue(t *testing.T) {
	previous := buildGitCommit
	buildGitCommit = "0123456789abcdef"
	t.Cleanup(func() { buildGitCommit = previous })

	if got := gitCommit(); got != buildGitCommit {
		t.Fatalf("gitCommit() = %q, want stamped value %q", got, buildGitCommit)
	}
}

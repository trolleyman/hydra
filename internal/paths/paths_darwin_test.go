//go:build darwin

package paths

import "testing"

func TestComparePathsDarwinIsCaseInsensitive(t *testing.T) {
	if !ComparePaths("/Users/Example/Project", "/users/example/project") {
		t.Fatal("ComparePaths should match case variants on default macOS filesystems")
	}
	if ComparePaths("/Users/Example/One", "/Users/Example/Two") {
		t.Fatal("ComparePaths matched distinct paths")
	}
}

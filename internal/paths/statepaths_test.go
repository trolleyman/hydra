package paths

import "testing"

// The per-head state files must be collision-proof: because a head id may
// contain "_", the old status/<id>_<suffix> scheme let a suffixed file of one
// head alias the base status file of another (head "foo"'s review vs head
// "foo_review"'s status). Keying each type's own dir by the bare id removes it.
func TestPerHeadStatePathsNoCollision(t *testing.T) {
	root := "/proj"

	// The classic collision pair: foo's companion files vs a head literally
	// named foo_<suffix>.
	cases := []struct {
		a    string // head id whose companion file we take
		bGet func(string, string) string
		desc string
	}{
		{"foo", GetReviewJsonFromProjectRoot, "review"},
		{"foo", GetStatusLogFromProjectRoot, "status-log"},
		{"foo", GetBuildLogFromProjectRoot, "build-log"},
		{"foo", GetChatQueueJsonFromProjectRoot, "queue"},
	}
	for _, c := range cases {
		companion := c.bGet(root, c.a)
		// The would-be colliding head id (e.g. "foo_review") whose status file
		// used to share the path.
		status := GetStatusJsonFromProjectRoot(root, c.a+"_"+c.desc)
		if companion == status {
			t.Errorf("%s companion of %q collides with status of %q_%s: %q", c.desc, c.a, c.a, c.desc, companion)
		}
	}

	// status.json stays the base name; every other type sits in its own dir.
	if GetStatusJsonFromProjectRoot(root, "h") == GetReviewJsonFromProjectRoot(root, "h") {
		t.Error("status and review share a path")
	}
	dirs := map[string]string{
		"status-log": GetStatusLogDirFromProjectRoot(root),
		"build-log":  GetBuildLogDirFromProjectRoot(root),
		"review":     GetReviewDirFromProjectRoot(root),
		"subagents":  GetSubagentsBaseDirFromProjectRoot(root),
		"queue":      GetChatQueueDirFromProjectRoot(root),
	}
	seen := map[string]bool{}
	for name, dir := range dirs {
		if seen[dir] {
			t.Errorf("%s dir %q is not unique", name, dir)
		}
		seen[dir] = true
		if dir == GetStatusDirFromProjectRoot(root) {
			t.Errorf("%s must not share the status/ dir", name)
		}
	}

	// Two different heads never share a per-type file (bare-id filenames).
	if GetReviewJsonFromProjectRoot(root, "a") == GetReviewJsonFromProjectRoot(root, "b") {
		t.Error("distinct heads share a review file")
	}
}

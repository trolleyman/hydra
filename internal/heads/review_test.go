package heads

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/mcpserver"
	"github.com/trolleyman/hydra/internal/paths"
)

// The adopt-spawn seed and the review watcher both go through
// WriteReviewSnapshot, which must create the review dir itself: the watcher can
// fire before a head's sandbox was ever seeded, and the adopt seed runs before
// seedHead has touched the dir.
func TestWriteReviewSnapshotCreatesDirAndFile(t *testing.T) {
	root := t.TempDir()
	rf := mcpserver.ReviewFile{
		Linked: true, URL: "https://gh/pr/1", ID: "1", Provider: "github",
		TargetBranch: "main", UnresolvedDiscussions: 1,
		Comments: []mcpserver.ReviewComment{{Author: "alice", Body: "nit", Path: "a.go", Line: 3}},
	}
	if err := WriteReviewSnapshot(root, "h1", rf); err != nil {
		t.Fatalf("WriteReviewSnapshot: %v", err)
	}
	data, err := os.ReadFile(paths.GetReviewJsonFromProjectRoot(root, "h1"))
	if err != nil {
		t.Fatalf("read review file: %v", err)
	}
	var got mcpserver.ReviewFile
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !got.Linked || got.ID != "1" || len(got.Comments) != 1 || got.Comments[0].Path != "a.go" {
		t.Errorf("round-tripped snapshot unexpected: %+v", got)
	}

	// A second write must land on the SAME inode: the file is bind-mounted into
	// the head's sandbox, so a write-and-rename would leave the agent reading the
	// stale original forever.
	before, err := os.Stat(paths.GetReviewJsonFromProjectRoot(root, "h1"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	rf.UnresolvedDiscussions = 0
	rf.Comments = nil
	if err := WriteReviewSnapshot(root, "h1", rf); err != nil {
		t.Fatalf("second WriteReviewSnapshot: %v", err)
	}
	after, err := os.Stat(paths.GetReviewJsonFromProjectRoot(root, "h1"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if !os.SameFile(before, after) {
		t.Error("review file was replaced rather than truncated in place")
	}
}

func TestAdoptedPrePromptNote(t *testing.T) {
	note := adoptedPrePromptNote(AdoptSpec{
		Provider: "github", ReviewID: "12", ReviewURL: "https://gh/pr/12",
		TargetBranch: "main", CanPush: true,
	})
	for _, want := range []string{"https://gh/pr/12", "#12", "main", "get_review_comments"} {
		if !strings.Contains(note, want) {
			t.Errorf("adopted pre-prompt note missing %q: %s", want, note)
		}
	}
	if strings.Contains(note, "READ-ONLY") {
		t.Errorf("pushable PR should not be described as read-only: %s", note)
	}
	ro := adoptedPrePromptNote(AdoptSpec{Provider: "github", ReviewID: "12", CanPush: false})
	if !strings.Contains(ro, "READ-ONLY") {
		t.Errorf("unpushable PR should be described as read-only: %s", ro)
	}
}

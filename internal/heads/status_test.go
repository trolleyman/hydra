package heads

import (
	"os"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

// Deleting a head's files is the only signal the daemon's chat manager gets that
// the event log it is holding in memory - all of it, to page from - is gone. So
// the removal has to say so, whichever path it came in by.
func TestRemoveAgentStatusFilesNotifiesTheStateHolders(t *testing.T) {
	root := t.TempDir()
	events := paths.GetChatEventsJSONLFromProjectRoot(root, "head")
	if err := os.MkdirAll(paths.GetChatEventsDirFromProjectRoot(root), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(events, []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	var told []string
	SetOnStateRemoved(func(id string) { told = append(told, id) })
	t.Cleanup(func() { SetOnStateRemoved(nil) })

	RemoveAgentStatusFiles(root, "head")

	if len(told) != 1 || told[0] != "head" {
		t.Fatalf("notified with %v, want [head]", told)
	}
	// And only after the files are actually gone - a holder told too early could
	// re-read what it was meant to drop.
	if _, err := os.Stat(events); !os.IsNotExist(err) {
		t.Errorf("chat events still present at notify time: %v", err)
	}
}

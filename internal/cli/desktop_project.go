package cli

import (
	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/projects"
)

// desktopProjectRoot returns an explicitly selected project, or prepares the
// built-in chat project as the neutral starting context for a desktop shell.
func desktopProjectRoot(selected string) (string, error) {
	if selected != "" {
		return selected, nil
	}
	store, err := db.OpenGlobal("")
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	defer store.Close()
	manager, err := projects.NewManager(store)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	project, err := manager.EnsureChatProject()
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return project.Path, nil
}

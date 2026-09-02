package http

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/db"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/statepath"
)

func TestProjectDirectoryHeadDiffUsesStartingCommitAndProjectDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", home)
	t.Setenv(statepath.Environment, filepath.Join(home, "state"))

	root := t.TempDir()
	runGit := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", root}, args...)...)
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	runGit("init", "-q", "-b", "main")
	write("tracked.txt", "start\n")
	runGit("add", "tracked.txt")
	runGit("commit", "-qm", "starting point")
	startSHA, err := git.ResolveRef(root, "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	write("tracked.txt", "committed during chat\n")
	runGit("add", "tracked.txt")
	runGit("commit", "-qm", "chat commit")
	write("tracked.txt", "live project directory\n")
	write("untracked.txt", "new\n")

	norm, err := paths.NormalizePath(root)
	if err != nil {
		t.Fatal(err)
	}
	store, err := db.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	manager, err := projects.NewManager(store)
	if err != nil {
		t.Fatal(err)
	}
	project, err := manager.AddProject(norm)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { statepath.UnregisterProject(norm) })
	if err := store.CreateAgent(&db.Agent{
		ID: "project-directory", ProjectPath: norm, AgentType: "claude", ChatMode: true,
		BaseBranch: "main", WorkspaceBaseRef: startSHA, CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	server := &Server{ProjectRoot: norm, ProjectsManager: manager, DB: store}
	commitsResponse, err := server.GetAgentCommits(context.Background(), api.GetAgentCommitsRequestObject{
		ProjectId: project.ID, AgentId: "project-directory",
	})
	if err != nil {
		t.Fatal(err)
	}
	commits, ok := commitsResponse.(api.GetAgentCommits200JSONResponse)
	if !ok || len(commits) != 1 || commits[0].Subject == nil || *commits[0].Subject != "chat commit" {
		t.Fatalf("project-directory commits = %#v, want the commit since chat start", commitsResponse)
	}

	includeUncommitted := true
	diffResponse, err := server.GetAgentDiff(context.Background(), api.GetAgentDiffRequestObject{
		ProjectId: project.ID,
		AgentId:   "project-directory",
		Params:    api.GetAgentDiffParams{IncludeUncommitted: &includeUncommitted},
	})
	if err != nil {
		t.Fatal(err)
	}
	diff, ok := diffResponse.(api.GetAgentDiff200JSONResponse)
	if !ok {
		t.Fatalf("project-directory diff response = %T, want 200", diffResponse)
	}
	if diff.BaseRef != startSHA || diff.HeadRef != "" {
		t.Fatalf("project-directory range = %q -> %q, want %q -> working directory", diff.BaseRef, diff.HeadRef, startSHA)
	}
	paths := make(map[string]bool, len(diff.Files))
	viewedBlobSHA := ""
	for _, file := range diff.Files {
		paths[file.Path] = true
		if file.Path == "tracked.txt" && file.HeadBlobSha != nil {
			viewedBlobSHA = *file.HeadBlobSha
		}
	}
	if !paths["tracked.txt"] || !paths["untracked.txt"] {
		t.Fatalf("project-directory diff files = %v, want committed/live tracked file and untracked file", paths)
	}
	if diff.UncommittedChanges == nil || !*diff.UncommittedChanges {
		t.Fatalf("project-directory uncommitted flag = %#v, want true", diff.UncommittedChanges)
	}
	if viewedBlobSHA == "" {
		t.Fatal("tracked file has no viewed baseline blob sha")
	}

	// Once that complete version is viewed, a later request with its blob sha
	// returns only the subsequent edit, not every change since the chat started.
	write("tracked.txt", "live project directory\nnew after review\n")
	path := "tracked.txt"
	deltaResponse, err := server.GetAgentDiff(context.Background(), api.GetAgentDiffRequestObject{
		ProjectId: project.ID,
		AgentId:   "project-directory",
		Params: api.GetAgentDiffParams{
			IncludeUncommitted: &includeUncommitted,
			Path:               &path,
			ViewedBlobSha:      &viewedBlobSHA,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	delta, ok := deltaResponse.(api.GetAgentDiff200JSONResponse)
	if !ok || len(delta.Files) != 1 {
		t.Fatalf("viewed delta response = %#v, want one file", deltaResponse)
	}
	if delta.Files[0].Additions != 1 || delta.Files[0].Deletions != 0 {
		t.Fatalf("viewed delta = +%d -%d, want +1 -0", delta.Files[0].Additions, delta.Files[0].Deletions)
	}
}

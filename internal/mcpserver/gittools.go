package mcpserver

import (
	"encoding/json"
	"maps"
	"strings"
)

// gitToolDefs is the catalog of git write-tools, advertised when Deps.GitOp is
// wired. They are the sanctioned way to change git state: raw git writes are
// gate-denied, and under git_isolation=readonly .git is read-only in the shell,
// so these route the operation onto the head's OWN branch (host-mediated when
// needed). Read-only git (status/diff/log/show) still works normally in the shell.
func gitToolDefs() []map[string]any {
	strArray := map[string]any{"type": "array", "items": map[string]any{"type": "string"}}
	return []map[string]any{
		{
			"name":        "git_commit",
			"description": "Commit your work onto YOUR branch, inside your worktree. By default stages ALL your changes (tracked + untracked, like `git add -A`) then commits; pass `paths` to stage only specific files, `staged` to commit what you already staged with git_add, or `amend` to amend your last commit. Raw `git commit` in the shell is blocked, so a commit can never land on the main repo or another branch.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"message"},
				"properties": map[string]any{
					"message": map[string]any{"type": "string", "description": "The commit message."},
					"paths":   withDesc(strArray, "Optional: repo-relative paths to stage before committing. Omit to stage all changes. Stages WHOLE files - to commit a partial (line-range) stage, use `staged` instead."),
					"amend":   map[string]any{"type": "boolean", "description": "Amend your previous commit instead of creating a new one."},
					"staged":  map[string]any{"type": "boolean", "description": "Commit the index exactly as it stands, staging nothing further. Use this after git_add - it is the only mode that preserves a partial (line-range) stage, since the other two re-stage whole files. Cannot be combined with `paths`."},
				},
			},
		},
		{
			"name":        "git_add",
			"description": "Stage changes into the index without committing (for building up a commit incrementally, then calling git_commit with `staged: true` - that flag is required to keep the index you build here, because a plain git_commit re-stages whole files and would undo the split). Each entry stages a whole file, or - with `ranges` - only the changed lines that fall within those (1-based, current-file) line ranges. Useful for splitting unrelated changes in one file across separate commits.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"files"},
				"properties": map[string]any{
					"files": map[string]any{
						"type":        "array",
						"description": "Files to stage.",
						"items": map[string]any{
							"type":     "object",
							"required": []string{"path"},
							"properties": map[string]any{
								"path": map[string]any{"type": "string", "description": "Repo-relative file path."},
								"ranges": map[string]any{
									"type":        "array",
									"description": "Optional [start,end] inclusive line-range pairs (current-file lines). Omit to stage the whole file.",
									"items":       map[string]any{"type": "array", "items": map[string]any{"type": "integer"}, "minItems": 2, "maxItems": 2},
								},
							},
						},
					},
				},
			},
		},
		{
			"name":        "git_reset",
			"description": "Move YOUR branch's HEAD, or unstage files. `to` (e.g. \"HEAD~1\") with `mode` soft (keep changes staged), mixed (keep changes unstaged), or hard (DISCARD uncommitted changes - requires confirm=true). Or pass `unstage` with paths to unstage them without moving HEAD. Use soft/mixed to undo a commit you want to redo.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"to":      map[string]any{"type": "string", "description": "Commit-ish to reset HEAD to (e.g. \"HEAD~1\" or a sha). Default HEAD."},
					"mode":    map[string]any{"type": "string", "enum": []string{"soft", "mixed", "hard"}, "description": "soft (default): keep changes staged. mixed: keep unstaged. hard: discard them."},
					"confirm": map[string]any{"type": "boolean", "description": "Required for a hard reset, which discards uncommitted work."},
					"unstage": withDesc(strArray, "Paths to unstage (a `reset -- <paths>`, no HEAD move). Mutually exclusive with to/mode."),
				},
			},
		},
		{
			"name":        "git_revert",
			"description": "Revert a commit on YOUR branch by creating a new commit that undoes it. Pass the commit's sha. On conflict it is aborted and reported (resolve manually and retry).",
			"inputSchema": map[string]any{
				"type":       "object",
				"required":   []string{"commit"},
				"properties": map[string]any{"commit": map[string]any{"type": "string", "description": "The commit (sha) to revert."}},
			},
		},
		{
			"name":        "git_cherry_pick",
			"description": "Apply an existing commit from elsewhere onto YOUR branch as a new commit. Pass the commit's sha. On conflict it is aborted and reported.",
			"inputSchema": map[string]any{
				"type":       "object",
				"required":   []string{"commit"},
				"properties": map[string]any{"commit": map[string]any{"type": "string", "description": "The commit (sha) to cherry-pick."}},
			},
		},
		{
			"name":        "git_rebase",
			"description": "Rewrite the history of YOUR branch above `base` non-interactively. Inspect first with `git log <base>..HEAD`, then pass a `plan`: one step per commit (top of `base`..HEAD to bottom), each an action (pick, reword, squash, fixup, drop). Optional `onto` transplants those commits onto a different ref (the equivalent of git rebase --onto <onto> <base>). The guarded operation only moves YOUR expected head branch. If a conflict stops it, resolve the files then call git_rebase_continue (or git_rebase_abort).",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"base", "plan"},
				"properties": map[string]any{
					"base": map[string]any{"type": "string", "description": "Commit-ish below the commits to edit (e.g. \"HEAD~3\" or a sha)."},
					"onto": map[string]any{"type": "string", "description": "Optional new parent ref for the planned commits. Omitting it rebases onto base as before."},
					"plan": map[string]any{
						"type":        "array",
						"description": "Ordered steps, one per commit above base.",
						"items": map[string]any{
							"type":     "object",
							"required": []string{"commit", "action"},
							"properties": map[string]any{
								"commit":  map[string]any{"type": "string", "description": "The commit sha this step acts on."},
								"action":  map[string]any{"type": "string", "enum": []string{"pick", "reword", "squash", "fixup", "drop"}},
								"message": map[string]any{"type": "string", "description": "New message for reword, or the combined message for squash."},
							},
						},
					},
				},
			},
		},
		{
			"name":        "git_rebase_continue",
			"description": "Resume an in-progress rebase (started with git_rebase) after you have resolved the conflicts in your worktree. It stages the resolved files and continues; if more conflicts stop it, resolve and call this again.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "git_rebase_abort",
			"description": "Abort an in-progress rebase and restore YOUR branch to its state before the rebase.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "git_merge",
			"description": "Merge a ref INTO your branch - typically your base branch, to bring your head up to date with it. The direction is fixed: it only ever moves YOUR branch, so it can't merge you into main or a sibling head. Fast-forwards when it can. Unlike git_cherry_pick, a conflict is LEFT in progress: resolve the conflict markers in your worktree, then call git_merge_continue (or git_merge_abort to back out).",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"ref"},
				"properties": map[string]any{
					"ref":     map[string]any{"type": "string", "description": "The ref to merge in, e.g. \"main\" (your base branch)."},
					"message": map[string]any{"type": "string", "description": "Merge-commit subject. Defaults to \"Merge branch '<ref>'\"."},
					"no_ff":   map[string]any{"type": "boolean", "description": "Force a merge commit even when the merge could fast-forward."},
				},
			},
		},
		{
			"name":        "git_merge_continue",
			"description": "Conclude a merge that stopped on conflicts, after you have resolved them in your worktree. It stages the still-conflicted files and commits the merge; it refuses if any of them still contain conflict markers.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "git_merge_abort",
			"description": "Abort an in-progress merge and restore YOUR branch to its state before the merge.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			"name":        "git_stash",
			"description": "Set uncommitted work aside and bring it back. `push` (default) parks your changes and leaves the worktree clean - the way out of \"your local changes would be overwritten by merge\" without discarding them or committing something half-done; `pop` restores and removes the entry, `apply` restores and keeps it, `list` shows what is stashed, `drop` throws an entry away. Stashing is refused mid-merge/rebase, where the captured conflict state would not restore cleanly.",
			"inputSchema": map[string]any{
				"type": "object",
				"properties": map[string]any{
					"op":      map[string]any{"type": "string", "enum": []string{"push", "pop", "apply", "list", "drop"}, "description": "Default push."},
					"message": map[string]any{"type": "string", "description": "push only: a label for the entry, so `list` is readable later."},
					"ref":     map[string]any{"type": "string", "description": "pop/apply/drop only: which entry, as \"stash@{N}\" from `list`. Omit for the most recent."},
					"include_untracked": map[string]any{
						"type":        "boolean",
						"description": "push only: also stash untracked files. Off by default - a plain push leaves them in the worktree.",
					},
				},
			},
		},
	}
}

// withDesc returns a copy of schema with a description added.
func withDesc(schema map[string]any, desc string) map[string]any {
	out := map[string]any{"description": desc}
	maps.Copy(out, schema)
	return out
}

// parseGitOp turns a git_* tool call's arguments into a GitOpRequest, validating
// the required fields. A non-empty error string is an agent-readable rejection.
func parseGitOp(name string, raw json.RawMessage) (GitOpRequest, string) {
	switch name {
	case "git_commit":
		var a struct {
			Message string   `json:"message"`
			Paths   []string `json:"paths"`
			Amend   bool     `json:"amend"`
			Staged  bool     `json:"staged"`
		}
		_ = json.Unmarshal(raw, &a)
		if strings.TrimSpace(a.Message) == "" {
			return GitOpRequest{}, "git_commit requires a non-empty \"message\"."
		}
		if a.Staged && len(a.Paths) > 0 {
			return GitOpRequest{}, "git_commit takes either \"staged\" or \"paths\", not both: \"staged\" commits the index as it stands, \"paths\" re-stages those files first."
		}
		return GitOpRequest{Op: "commit", Message: a.Message, Paths: a.Paths, Amend: a.Amend, Staged: a.Staged}, ""
	case "git_add":
		var a struct {
			Files []GitAddSpec `json:"files"`
		}
		_ = json.Unmarshal(raw, &a)
		if len(a.Files) == 0 {
			return GitOpRequest{}, "git_add requires a non-empty \"files\" array."
		}
		return GitOpRequest{Op: "add", Add: a.Files}, ""
	case "git_reset":
		var a struct {
			To      string   `json:"to"`
			Mode    string   `json:"mode"`
			Confirm bool     `json:"confirm"`
			Unstage []string `json:"unstage"`
		}
		_ = json.Unmarshal(raw, &a)
		return GitOpRequest{Op: "reset", To: a.To, Mode: a.Mode, Confirm: a.Confirm, Unstage: a.Unstage}, ""
	case "git_revert", "git_cherry_pick":
		var a struct {
			Commit string `json:"commit"`
		}
		_ = json.Unmarshal(raw, &a)
		if strings.TrimSpace(a.Commit) == "" {
			return GitOpRequest{}, name + " requires a \"commit\" sha."
		}
		op := "revert"
		if name == "git_cherry_pick" {
			op = "cherry_pick"
		}
		return GitOpRequest{Op: op, Commit: a.Commit}, ""
	case "git_rebase":
		var a struct {
			Base string          `json:"base"`
			Onto string          `json:"onto"`
			Plan []GitRebaseStep `json:"plan"`
		}
		_ = json.Unmarshal(raw, &a)
		if strings.TrimSpace(a.Base) == "" {
			return GitOpRequest{}, "git_rebase requires a \"base\"."
		}
		if len(a.Plan) == 0 {
			return GitOpRequest{}, "git_rebase requires a non-empty \"plan\"."
		}
		return GitOpRequest{Op: "rebase", Base: a.Base, Onto: a.Onto, Plan: a.Plan}, ""
	case "git_rebase_continue":
		return GitOpRequest{Op: "rebase_continue"}, ""
	case "git_rebase_abort":
		return GitOpRequest{Op: "rebase_abort"}, ""
	case "git_merge":
		var a struct {
			Ref     string `json:"ref"`
			Message string `json:"message"`
			NoFF    bool   `json:"no_ff"`
		}
		_ = json.Unmarshal(raw, &a)
		if strings.TrimSpace(a.Ref) == "" {
			return GitOpRequest{}, "git_merge requires a \"ref\" to merge in (e.g. \"main\")."
		}
		return GitOpRequest{Op: "merge", Ref: a.Ref, Message: a.Message, NoFF: a.NoFF}, ""
	case "git_merge_continue":
		return GitOpRequest{Op: "merge_continue"}, ""
	case "git_merge_abort":
		return GitOpRequest{Op: "merge_abort"}, ""
	case "git_stash":
		var a struct {
			Op               string `json:"op"`
			Message          string `json:"message"`
			Ref              string `json:"ref"`
			IncludeUntracked bool   `json:"include_untracked"`
		}
		_ = json.Unmarshal(raw, &a)
		return GitOpRequest{Op: "stash", Stash: a.Op, StashRef: a.Ref, Message: a.Message, IncludeUntracked: a.IncludeUntracked}, ""
	}
	return GitOpRequest{}, "unknown git tool: " + name
}

//go:build !windows

package db

import (
	"time"

	"gorm.io/gorm"
)

// Agent represents a Hydra agent record in the database.
type Agent struct {
	ID          string `gorm:"primaryKey;not null"`
	ProjectPath string `gorm:"not null;index"`

	// Git
	BranchName string
	BaseBranch string
	// GitIsolation is the per-head git-isolation mode override (off/readonly; "" =
	// use the agent-type policy default). Chosen at spawn and persisted so resume
	// re-applies the same .git lockdown. See docs/git-isolation.md.
	GitIsolation string

	// Identity
	AgentType string `gorm:"not null"` // "claude" | "gemini" | "copilot" | "codex" | "bash"
	PrePrompt string
	Prompt    string
	// Title is the mutable, user-facing display name. The ID stays the stable
	// identity (primary key, branch, worktree path, session key); renaming only
	// touches this field. Seeded from the prompt, optionally refined by an LLM.
	Title string
	// Plan is the chat plan/to-do list JSON reconstructed from the head's
	// Task*/TodoWrite events - by the chat view live, and by the daemon from the
	// full transcript on chat attach (claudestream.ReconstructPlan) - persisted
	// so it survives navigation and is available in a new browser.
	Plan string
	// Model is the chat head's current model id, captured by the daemon from the
	// CLI's system:init line (see internal/http/chat_ws.go) and persisted so the
	// selector shows the right model on navigation and in a new browser.
	Model          string
	ConversationID string
	Ephemeral      bool `gorm:"default:false"`
	// ChatMode drives a Claude or Codex head via its structured chat protocol.
	// Mutable; a change takes effect on the next session (re)launch.
	ChatMode bool `gorm:"default:false"`

	// Session - updated by the liveness reconciler
	SessionPID    int    // PID of the running sandbox session, 0 if not running
	SessionStatus string `gorm:"default:pending"` // pending|building|starting|running|stopped

	// Terminal - last PTY geometry a client reported for this head, used to seed
	// a clientless resume (daemon boot, TUI) at the right width instead of 80x24.
	// 0 = never reported.
	TermRows int
	TermCols int

	// Agent - updated by JSON poller reading .hydra/local/status/<id>.json
	AgentStatus     *string // starting|running|needs_input|waiting|stopped (nil = not yet reported)
	AgentStatusTime string  // RFC3339 of last AgentStatus update

	// Live activity, persisted by the JSON poller (from status_log.jsonl) so it
	// survives a daemon restart and is served straight from the DB instead of
	// re-tailing the log on every GET /agents. Activity is the current tool action
	// ("Using AskUserQuestion"), shown only while running and cleared at rest;
	// LastMessage is the agent's most recent assistant message (or the question it's
	// waiting on), kept across turns until a newer one replaces it;
	// LastMessageIsSuggested marks a terse instruction the user could send straight
	// back (the UI shows a caret). Surfaced as AgentStatusInfo.activity/last_message.
	Activity               string
	LastMessage            string
	LastMessageIsSuggested bool `gorm:"default:false"`

	// HasUnreadChanges is set when the agent needs the user's eyes - it reaches
	// needs_input (at once) or settles into finished (deferred) - and is cleared
	// when the user opens the agent. The soft waiting status does not raise it
	// (waiting means gone-quiet or awaiting a background subagent, not a user-input
	// wait). Drives the "unread changes" dot in the UI. Set by the JSON poller.
	HasUnreadChanges bool `gorm:"default:false"`

	// Operation - set atomically before long operations
	HeadStatus string  `gorm:"default:idle"` // idle|killing|merging
	LastError  *string // error message from failed operation

	// MergeWhenGreen arms auto-merge (PLAN #68): when true, the daemon merges this
	// head as soon as its tests settle passing, and disarms it (with a toast) if
	// they settle failing/errored or a new commit's tests go red. MergeWhenGreenAt
	// is the RFC3339 time it was armed (for display/ordering). Set/cleared via the
	// arm/disarm endpoints.
	MergeWhenGreen   bool `gorm:"default:false"`
	MergeWhenGreenAt string

	// EndState records how an archived (soft-deleted) agent ended: "killed" |
	// "merged", or "" for an active agent or an aborted spawn. The archived-history
	// list shows only soft-deleted rows with a non-empty EndState, so aborted
	// spawns (also soft-deleted, but EndState "") never surface there. A head merged
	// remotely (its MR landed on the forge) is archived as "merged" too - the stored
	// ReviewURL records that it came via an MR (NON_LOCAL_INTEGRATION.md 3.5).
	EndState string

	// --- Non-local integration (MR/PR link, NON_LOCAL_INTEGRATION.md 3.3) ---
	// The head<->MR link is optional and per-head: an unlinked head (all fields
	// empty) behaves exactly as before, with direct local Merge available.

	// DownstreamBranch is the branch name this head's work is pushed AS on the
	// remote (the local branch always stays hydra/<id>). Seeded from
	// review.push_branch_template at spawn/first-publish, editable until first
	// publish, soft-locked after (renaming orphans the MR). "" = not yet set.
	DownstreamBranch string
	// ReviewURL is the forge URL of this head's MR/PR (deep link for "View MR").
	// "" = unlinked.
	ReviewURL string
	// ReviewID is the MR/PR identifier on the forge (GitLab IID / GitHub number),
	// used for API calls. "" = unlinked.
	ReviewID string
	// ReviewProvider is the resolved forge ("github" | "gitlab") captured at
	// publish, so status/merge calls don't re-resolve.
	ReviewProvider string
	// ReviewTargetBranch is the MR's target branch (may differ from BaseBranch).
	ReviewTargetBranch string
	// ReviewState is the cached MR state (JSON) from the lifecycle watcher
	// (Phase 3): draft/open/merged, CI, approvals, unresolved discussions.
	ReviewState string
	// ReviewStateTime is the RFC3339 time ReviewState was last refreshed.
	ReviewStateTime string

	// --- Adopted PR/MR (inbound integration, docs/pr-adoption.md) ---
	// ReviewAdopted is true when this head was spawned ON an existing PR/MR that
	// Hydra did NOT create (someone else's, or a fork's). It gates the guards that
	// must not fire on a foreign MR: no EnsureMR/re-publish, no auto-push, no
	// close/delete-branch on teardown. False for a normal head or one Hydra
	// published itself.
	ReviewAdopted bool `gorm:"default:false"`
	// ReviewPushURL is the git remote a push to the adopted PR's head branch
	// targets. Empty means the configured review remote (the same-repo case, and
	// every non-adopted head); a fork PR carries the fork's clone URL here because
	// its head branch does not live on the configured remote.
	ReviewPushURL string
	// ReviewCanPush records whether we may push to the adopted PR's head branch:
	// always true for a same-repo PR, and for a fork only when the author enabled
	// maintainer edits. When false the head is read-only (review-only) and the
	// push affordances are disabled. Meaningless (and false) for a non-adopted head.
	ReviewCanPush bool `gorm:"default:false"`

	// PublishWhenGreen arms "publish when green" (Phase 3): once local tests pass
	// and the agent has finished, an unlinked head auto-opens a draft MR and a
	// linked head auto-pushes. PublishWhenGreenAt is the RFC3339 arm time.
	PublishWhenGreen   bool `gorm:"default:false"`
	PublishWhenGreenAt string

	CreatedAt time.Time `gorm:"autoCreateTime:false"` // set explicitly
	UpdatedAt time.Time
	DeletedAt gorm.DeletedAt `gorm:"index"`
}

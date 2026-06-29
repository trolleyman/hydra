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

	// Identity
	AgentType string `gorm:"not null"` // "claude" | "gemini" | "copilot" | "codex" | "bash"
	PrePrompt string
	Prompt    string
	// Title is the mutable, user-facing display name. The ID stays the stable
	// identity (primary key, branch, worktree path, session key); renaming only
	// touches this field. Seeded from the prompt, optionally refined by an LLM.
	Title     string
	Ephemeral bool `gorm:"default:false"`

	// Session — updated by the liveness reconciler
	SessionPID    int    // PID of the running sandbox session, 0 if not running
	SessionStatus string `gorm:"default:pending"` // pending|building|starting|running|stopped

	// Terminal — last PTY geometry a client reported for this head, used to seed
	// a clientless resume (daemon boot, TUI) at the right width instead of 80x24.
	// 0 = never reported.
	TermRows int
	TermCols int

	// Agent — updated by JSON poller reading .hydra/local/status/<id>.json
	AgentStatus     *string // starting|running|needs_input|waiting|stopped (nil = not yet reported)
	AgentStatusTime string  // RFC3339 of last AgentStatus update

	// HasUnreadChanges is set when the agent needs the user's eyes — it reaches
	// needs_input (at once) or settles into waiting/finished (deferred) — and is
	// cleared when the user opens the agent. Drives the "unread changes" dot in
	// the UI. Set by the JSON poller.
	HasUnreadChanges bool `gorm:"default:false"`

	// Operation — set atomically before long operations
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
	// spawns (also soft-deleted, but EndState "") never surface there.
	EndState string

	CreatedAt time.Time `gorm:"autoCreateTime:false"` // set explicitly
	UpdatedAt time.Time
	DeletedAt gorm.DeletedAt `gorm:"index"`
}

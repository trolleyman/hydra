//go:build windows

package db

import (
	"time"

	"gorm.io/gorm"
)

// Agent represents a Hydra agent record in the database.
type Agent struct {
	ID          string `gorm:"primaryKey;not null"`
	ProjectPath string `gorm:"not null;index;type:text COLLATE NOCASE"`

	// Git
	BranchName string
	BaseBranch string

	// Identity
	AgentType string `gorm:"not null"` // "claude" | "gemini"
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

	// Agent — updated by JSON poller reading .hydra/local/status/<id>.json
	AgentStatus     *string // starting|running|waiting|stopped (nil = not yet reported)
	AgentStatusTime string  // RFC3339 of last AgentStatus update

	// HasUnreadChanges is set when the agent transitions running→waiting/finished
	// (the JSON poller) and cleared when the user opens the agent. Drives the
	// "unread changes" dot in the UI.
	HasUnreadChanges bool `gorm:"default:false"`

	// Operation — set atomically before long operations
	HeadStatus string  `gorm:"default:idle"` // idle|killing|merging
	LastError  *string // error message from failed operation

	// EndState records how an archived (soft-deleted) agent ended: "killed" |
	// "merged", or "" for an active agent or an aborted spawn. The archived-history
	// list shows only soft-deleted rows with a non-empty EndState, so aborted
	// spawns (also soft-deleted, but EndState "") never surface there.
	EndState string

	CreatedAt time.Time `gorm:"autoCreateTime:false"` // set explicitly
	UpdatedAt time.Time
	DeletedAt gorm.DeletedAt `gorm:"index"`
}

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
	// GitIsolation is the per-head git-isolation mode override (off/readonly; "" =
	// use the agent-type policy default). See docs/git-isolation.md.
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
	AgentStatus     *string // starting|running|waiting|stopped (nil = not yet reported)
	AgentStatusTime string  // RFC3339 of last AgentStatus update

	// Live activity, persisted by the JSON poller (see model_unix.go for details):
	// Activity is the current tool action shown while running; LastMessage is the
	// most recent assistant message kept across turns; LastMessageIsSuggested marks
	// a terse send-straight-back instruction.
	Activity               string
	LastMessage            string
	LastMessageIsSuggested bool `gorm:"default:false"`

	// HasUnreadChanges is set when the agent settles into finished (deferred) or
	// reaches needs_input (at once); the soft waiting status does not raise it. The
	// JSON poller sets it, and it is cleared when the user opens the agent. Drives
	// the "unread changes" dot in the UI.
	HasUnreadChanges bool `gorm:"default:false"`

	// Operation - set atomically before long operations
	HeadStatus string  `gorm:"default:idle"` // idle|killing|merging
	LastError  *string // error message from failed operation

	// MergeWhenGreen arms auto-merge (PLAN #68): when true, the daemon merges this
	// head as soon as its tests settle passing, and disarms it if they settle
	// failing/errored or a new commit's tests go red. MergeWhenGreenAt is the
	// RFC3339 time it was armed. Set/cleared via the arm/disarm endpoints.
	MergeWhenGreen   bool `gorm:"default:false"`
	MergeWhenGreenAt string

	// EndState records how an archived (soft-deleted) agent ended: "killed" |
	// "merged", or "" for an active agent or an aborted spawn. The archived-history
	// list shows only soft-deleted rows with a non-empty EndState, so aborted
	// spawns (also soft-deleted, but EndState "") never surface there.
	EndState string

	// --- Non-local integration (MR/PR link, NON_LOCAL_INTEGRATION.md 3.3) ---
	// See model_unix.go for field docs.
	DownstreamBranch   string
	ReviewURL          string
	ReviewID           string
	ReviewProvider     string
	ReviewTargetBranch string
	ReviewState        string
	ReviewStateTime    string
	PublishWhenGreen   bool `gorm:"default:false"`
	PublishWhenGreenAt string

	CreatedAt time.Time `gorm:"autoCreateTime:false"` // set explicitly
	UpdatedAt time.Time
	DeletedAt gorm.DeletedAt `gorm:"index"`
}

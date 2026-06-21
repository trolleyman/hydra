package http

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/api"
)

// SimulationServer implements api.ServerInterface with mock data.
type SimulationServer struct {
	Development bool
}

// simNow is the fixed wall-clock instant ALL time-derived simulation values are
// computed from, instead of time.Now(). The diff viewer renders the two sides of
// a comparison in separate server boots and hashes the resulting screenshots, so
// any value that moves with the real clock (an agent's "spawned X ago", the
// artifacts panel's elapsed timer) would make otherwise-identical renders differ
// and show up as a spurious visual change. Pinning the server's clock — together
// with the screenshot script pinning the browser's clock to the SAME instant
// (scripts/screenshots/take-screenshots.ts, page.clock) — makes every duration
// label deterministic, down to the second. Keep the two instants in sync.
func simNow() time.Time {
	return time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC)
}

func (s *SimulationServer) CheckHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

func (s *SimulationServer) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := "OK"
	v := "0.1.0-sim"
	// Pin uptime to a fixed value rather than time.Since(StartTime). The diff
	// viewer renders both sides of a comparison in separate server boots and
	// hashes the resulting screenshots, so a live uptime makes the header's
	// "Spawned X ago" label differ between otherwise-identical renders (e.g.
	// "just now" vs "7 seconds ago"). 2h sits comfortably mid-bucket so the
	// sub-second jitter between status fetch and capture never crosses a
	// unit boundary.
	uptime := float32(2 * time.Hour / time.Second)
	projectRoot := "/simulated/project"
	defaultProjectID := "sim-project"
	development := s.Development

	api.WriteJSON(w, http.StatusOK, api.StatusResponse{
		Status:           &status,
		Version:          &v,
		UptimeSeconds:    &uptime,
		ProjectRoot:      &projectRoot,
		DefaultProjectId: &defaultProjectID,
		Development:      &development,
	})
}

func (s *SimulationServer) GetClaudeUsage(w http.ResponseWriter, r *http.Request, params api.GetClaudeUsageParams) {
	// Fixed snapshot so the diff viewer's two server boots render identically.
	// session_resets_at is intentionally omitted: a live countdown would differ
	// between otherwise-identical renders (see GetStatus's uptime note).
	available := true
	tier := "Claude Max"
	session := float32(38)
	weekly := float32(65)
	sessionText := "Resets in 2h 15m"
	weeklyText := "Resets Jan 15, 3:30pm"
	api.WriteJSON(w, http.StatusOK, api.ClaudeUsageResponse{
		Available:          available,
		AccountTier:        &tier,
		SessionPercentUsed: &session,
		SessionResetText:   &sessionText,
		WeeklyPercentUsed:  &weekly,
		WeeklyResetText:    &weeklyText,
	})
}

func (s *SimulationServer) ListProjects(w http.ResponseWriter, r *http.Request) {
	simUnread := 1   // matches the one unread agent in ListAgents
	otherUnread := 3 // updates waiting in a project you're not looking at
	resp := api.ListProjects200JSONResponse{
		{
			Id:          "sim-project",
			Path:        "/simulated/project",
			Name:        "simulated-project",
			UnreadCount: &simUnread,
		},
		{
			Id:          "mobile-app",
			Path:        "/simulated/mobile-app",
			Name:        "mobile-app",
			UnreadCount: &otherUnread,
		},
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) AddProject(w http.ResponseWriter, r *http.Request) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) GetProjectConfigToml(w http.ResponseWriter, r *http.Request, projectId string) {
	api.WriteJSON(w, http.StatusOK, api.ConfigTomlResponse{Content: "", Exists: false})
}

func (s *SimulationServer) RemoveProject(w http.ResponseWriter, r *http.Request, projectId string) {
	w.WriteHeader(http.StatusNoContent)
}

// simAgent1Prompt is the seeded prompt for the live simulated agent (agent-1),
// shared by ListAgents and GetAgent so the detail page (populated from either)
// always renders the prompt block.
const simAgent1Prompt = "Let agents be renamed with a human-friendly title instead of only showing the stable ID.\n\n" +
	"- Add a mutable `title` field to the agent model and a PATCH endpoint to update it.\n" +
	"- Render the title in the sidebar and the detail header, with an inline rename (pencil) control; keep the Copy-ID button exposing the underlying id.\n" +
	"- Fall back to the id when no title is set, and persist the title across daemon restarts."

// simAgentMdPrompt is the seeded prompt for the markdown-demo agent (agent-md),
// shared by ListAgents and GetAgent. It is written to exercise the inline-
// markdown renderer thoroughly: `code`, *italic* and **bold** runs, a long
// inline-code reference that wraps across lines, a line that mixes code with
// prose (to prove a code span doesn't change the line height), and a literal
// "$ …" run that must stay ordinary code in a prompt (the $-command override is
// activity-only). It is also long enough to overflow the detail PromptBlock's
// max height so the bottom-fade-on-scroll is visible.
const simAgentMdPrompt = "Add **simple inline-markdown** rendering so prompts and the live-activity line aren't flat text.\n\n" +
	"- In the spawn box and this detail view, highlight `inline code`, *italic* and **bold** runs — but leave #headings alone.\n" +
	"- Reuse the same pass for the live-activity line; when an activity begins with a `$`, render the whole line as a command (e.g. a build or test invocation), overriding markdown — but do that *only* for activity, never for a prompt.\n" +
	"- A long inline-code reference such as `web/src/components/AgentComponents.tsx` must wrap across lines cleanly, and a line that contains `code` must stay exactly as tall as a `plain` one.\n" +
	"- A long command in backticks like `go test ./internal/heads/... -run TestResumeLazy -count=1 -race -v` should wrap mid-span, with each line fragment keeping its own rounded code background.\n" +
	"- Proof the override is activity-only: this literal `$ run-this-command --now` sitting inside the prompt should stay ordinary code, not a highlighted command line.\n" +
	"- Tighten the gap between the metadata above and this box, and add a soft bottom fade so a tall prompt doesn't cut off hard as it scrolls out of view.\n" +
	"- A fenced block must render as its own code chip in both the spawn box and this detail view, e.g.\n" +
	"```ts\nconst seg = parseInline(text)\nrenderMarkdown(seg) // code/bold/italic\n```\n" +
	"- Keep it dependency-free: a tiny hand-rolled tokenizer beats pulling in a whole markdown library just for `code`, *italic* and **bold**.\n" +
	"- Finally, share one renderer across the spawn box, the agent-detail prompt and the sidebar activity line so the three never drift apart."

// simAgent2Prompt is agent-2's seeded prompt. It opens with task text, then
// lists upload paths the way the spawn form appends them — three images and one
// non-image (.pdf) — so the agent-2 detail page's PromptBlock renders them as
// attachment chips (image thumbnails + a generic icon) instead of raw links.
// agent-2 already sits in ListAgents, so its detail page renders straight from
// the store (no one-shot getAgent, which never resolves in simulation), and no
// other shot captures its detail view — so adding this prompt is churn-free. See
// take-screenshots.ts agent-prompt-attachments, which serves the thumbnails a
// fixed image so they render deterministically.
const simAgent2Prompt = "Migrate the auth providers to OAuth 2.0 with PKCE. Match the attached sign-in mockups (light + dark) and the error states; the full provider list is in the spec PDF.\n\n" +
	"/home/you/acme/.hydra/local/uploads/1782072241514128486-signin-light.png\n" +
	"/home/you/acme/.hydra/local/uploads/1782072347433312262-signin-dark.png\n" +
	"/home/you/acme/.hydra/local/uploads/1782072458377091686-error-states.png\n" +
	"/home/you/acme/.hydra/local/uploads/1782072717310298418-oauth-providers.pdf"

func (s *SimulationServer) ListAgents(w http.ResponseWriter, r *http.Request, projectId string) {
	createdAt0 := simNow().Add(-30 * time.Minute).Unix()
	createdAt1 := simNow().Add(-1 * time.Hour).Unix()
	createdAt2 := simNow().Add(-2 * time.Hour).Unix()
	createdAt3 := simNow().Add(-3 * time.Hour).Unix()

	running := api.Running
	waiting := api.Waiting
	unread := true

	resp := api.ListAgents200JSONResponse{
		{
			// Markdown-rendering demo agent. Its live-activity line carries inline
			// markdown (code + bold + italic) so the sidebar shows the rendered
			// activity; see agent-3 for the $-command override.
			Id:            "agent-md",
			Title:         ptr("Add inline markdown rendering"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-markdown"),
			SessionPid:    1004,
			SessionStatus: "running",
			CreatedAt:     &createdAt0,
			Prompt:        simAgentMdPrompt,
			AgentStatus: &api.AgentStatusInfo{
				Status:    running,
				Timestamp: simNow().Format(time.RFC3339),
				Activity:  ptr("Wrapping `renderMarkdown()` over the **prompt** & *activity*"),
			},
		},
		{
			Id:            "agent-1",
			Title:         ptr("Add renameable agent titles"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-1"),
			SessionPid:    1001,
			SessionStatus: "running",
			CreatedAt:     &createdAt1,
			Prompt:        simAgent1Prompt,
			AgentStatus: &api.AgentStatusInfo{
				Status:    running,
				Timestamp: simNow().Format(time.RFC3339),
			},
		},
		{
			// Finished while you were away → unread-changes dot lit.
			Id:               "agent-2",
			Title:            ptr("Migrate auth providers to OAuth"),
			AgentType:        "gemini",
			BaseBranch:       "main",
			BranchName:       ptr("hydra/feat-2"),
			SessionPid:       1002,
			SessionStatus:    "running",
			CreatedAt:        &createdAt2,
			HasUnreadChanges: &unread,
			// Carries upload paths so its detail-page PromptBlock renders the
			// attachment chips (agent-prompt-attachments shot). Not shown in the
			// sidebar, so the home/unread shots are unaffected.
			Prompt: simAgent2Prompt,
			AgentStatus: &api.AgentStatusInfo{
				Status:      waiting,
				Timestamp:   simNow().Format(time.RFC3339),
				LastMessage: ptr("The spike is built, tested, and committed. Here's what landed…"),
			},
		},
		{
			// Deeply-nested refactor — exercises the diff tree's VS Code-style
			// "compact folders" rendering (see GetAgentDiff for agent-3).
			Id:            "agent-3",
			Title:         ptr("Refactor auth into nested packages"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-3"),
			SessionPid:    1003,
			SessionStatus: "running",
			CreatedAt:     &createdAt3,
			AgentStatus: &api.AgentStatusInfo{
				Status:    running,
				Timestamp: simNow().Format(time.RFC3339),
				// A "$"-prefixed activity renders as a command (whole line styled
				// as code), overriding markdown — demos the activity-only override.
				Activity: ptr("$ go test ./internal/heads/ -run TestResumeLazy"),
			},
		},
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

// simArchivedAgents returns the seeded archived (killed/merged) history used by
// the archived sidebar section + the read-only archived agent page.
func simArchivedAgents() []api.AgentResponse {
	archived := true
	finished := api.Finished
	stopped := api.Stopped
	mk := func(id, title, agentType, branch, endState, prompt string, status api.AgentStatus, ageHours time.Duration) api.AgentResponse {
		createdAt := simNow().Add(-ageHours * time.Hour).Unix()
		es := endState
		return api.AgentResponse{
			Id:            id,
			Title:         ptr(title),
			AgentType:     agentType,
			BaseBranch:    "main",
			BranchName:    ptr(branch),
			SessionStatus: "stopped",
			Prompt:        prompt,
			CreatedAt:     &createdAt,
			Archived:      &archived,
			EndState:      &es,
			AgentStatus: &api.AgentStatusInfo{
				Status:    status,
				Timestamp: simNow().Format(time.RFC3339),
			},
		}
	}
	return []api.AgentResponse{
		mk("archived-1", "Add dark-mode toggle to settings", "claude", "hydra/feat-darkmode", "merged", "Add a dark-mode toggle to the settings page, persisted to localStorage and respecting the OS preference by default.", finished, 5),
		mk("archived-2", "Spike: WebSocket diff refresh", "gemini", "hydra/spike-ws", "killed", "Prototype pushing diff_refresh over the existing terminal WebSocket instead of the 20s poll, and measure the latency win.", stopped, 8),
		mk("archived-3", "Fix flaky terminal resize test", "claude", "hydra/fix-resize", "merged", "TestTerminalResize fails intermittently in CI. Track down the race and make it deterministic.", finished, 26),
		mk("archived-4", "Investigate sandbox netns isolation", "claude", "hydra/spike-netns", "killed", "Explore giving each agent its own network namespace with a rootless userspace NAT (pasta/slirp4netns) for per-agent port isolation.", stopped, 30),
		mk("archived-5", "Render ANSI colour in artifact logs", "copilot", "hydra/feat-ansi", "merged", "Replace stripAnsi in the artifact log panes with a real SGR renderer so build output keeps its colour.", finished, 49),
	}
}

func (s *SimulationServer) ListArchivedAgents(w http.ResponseWriter, r *http.Request, projectId string, params api.ListArchivedAgentsParams) {
	all := simArchivedAgents()
	offset := 0
	if params.Offset != nil && *params.Offset > 0 {
		offset = *params.Offset
	}
	if offset > len(all) {
		offset = len(all)
	}
	page := all[offset:]
	if params.Limit != nil && *params.Limit > 0 && *params.Limit < len(page) {
		page = page[:*params.Limit]
	}
	resp := api.ListArchivedAgents200JSONResponse(page)
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) GetAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	for _, a := range simArchivedAgents() {
		if a.Id == id {
			api.WriteJSON(w, http.StatusOK, a)
			return
		}
	}
	if id == "agent-1" {
		createdAt := simNow().Add(-1 * time.Hour).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			Id:            "agent-1",
			Title:         ptr("Add renameable agent titles"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-1"),
			SessionPid:    1001,
			SessionStatus: "running",
			CreatedAt:     &createdAt,
			Prompt:        simAgent1Prompt,
			AgentStatus: &api.AgentStatusInfo{
				Status:    api.Running,
				Timestamp: simNow().Format(time.RFC3339),
			},
		})
		return
	}
	if id == "agent-md" {
		createdAt := simNow().Add(-30 * time.Minute).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			Id:            "agent-md",
			Title:         ptr("Add inline markdown rendering"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-markdown"),
			SessionPid:    1004,
			SessionStatus: "running",
			CreatedAt:     &createdAt,
			Prompt:        simAgentMdPrompt,
			AgentStatus: &api.AgentStatusInfo{
				Status:    api.Running,
				Timestamp: simNow().Format(time.RFC3339),
				Activity:  ptr("Wrapping `renderMarkdown()` over the **prompt** & *activity*"),
			},
		})
		return
	}
	if id == "agent-3" {
		createdAt := simNow().Add(-3 * time.Hour).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			Id:            "agent-3",
			Title:         ptr("Refactor auth into nested packages"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-3"),
			SessionPid:    1003,
			SessionStatus: "running",
			CreatedAt:     &createdAt,
			Prompt:        "Refactor the auth providers into a deeply nested package layout so the diff tree shows VS Code-style compacted folders.",
			AgentStatus: &api.AgentStatusInfo{
				Status:    api.Running,
				Timestamp: simNow().Format(time.RFC3339),
			},
		})
		return
	}
	if id == "agent-2" {
		// agent-2 carries upload paths in its prompt so its detail page documents
		// the PromptBlock attachment chips (agent-prompt-attachments shot). Mirrors
		// its ListAgents entry; served here too so a direct/cold load of the detail
		// URL resolves even before the agent list poll populates the store.
		createdAt := simNow().Add(-2 * time.Hour).Unix()
		unread := true
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			Id:               "agent-2",
			Title:            ptr("Migrate auth providers to OAuth"),
			AgentType:        "gemini",
			BaseBranch:       "main",
			BranchName:       ptr("hydra/feat-2"),
			SessionPid:       1002,
			SessionStatus:    "running",
			CreatedAt:        &createdAt,
			HasUnreadChanges: &unread,
			Prompt:           simAgent2Prompt,
			AgentStatus: &api.AgentStatusInfo{
				Status:      api.Waiting,
				Timestamp:   simNow().Format(time.RFC3339),
				LastMessage: ptr("The spike is built, tested, and committed. Here's what landed…"),
			},
		})
		return
	}
	api.WriteError(w, http.StatusNotFound, "Agent not found")
}

func (s *SimulationServer) SpawnAgent(w http.ResponseWriter, r *http.Request, projectId string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) KillAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) PurgeAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) UpdateAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) RestartAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) MergeAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) MarkAgentRead(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) UpdateAgentFromBase(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) GetAgentCommits(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	if id == "agent-1" {
		resp := api.GetAgentCommits200JSONResponse{
			{
				Sha:         "abcd1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "abcd123",
				Subject:     ptr("Add feature X"),
				Message:     "Add feature X\n\nMore details about feature X",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-10 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "bcde1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "bcde123",
				Subject:     ptr("Fix bug Y"),
				Message:     "Fix bug Y",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-20 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "cdef1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "cdef123",
				Subject:     ptr("Refactor Z"),
				Message:     "Refactor Z",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-30 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "defg1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "defg123",
				Subject:     ptr("Initial work for feature X"),
				Message:     "Initial work for feature X",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-40 * time.Minute).Format(time.RFC3339),
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	api.WriteJSON(w, http.StatusOK, api.GetAgentCommits200JSONResponse{})
}

func (s *SimulationServer) GetAgentDiff(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentDiffParams) {
	ctx := simContext(params)
	if id == "agent-2" {
		// Mock uncommitted changes
		uncommitted := true
		resp := api.DiffResponse{
			BaseRef:            "main",
			HeadRef:            "hydra/feat-2",
			UncommittedChanges: &uncommitted,
			UncommittedSummary: &api.UncommittedSummary{
				TrackedCount:   2,
				UntrackedCount: 1,
			},
			Files: []api.DiffFile{
				{
					Path:       "README.md",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  2,
					Deletions:  1,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,3 +1,4 @@",
							OldStart: 1,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "# Hydra", OldLineNum: ptr(1), NewLineNum: ptr(1)},
								{Type: api.Deletion, Content: "Old description", OldLineNum: ptr(2)},
								{Type: api.Addition, Content: "New improved description", NewLineNum: ptr(2)},
								{Type: api.Addition, Content: "With more info", NewLineNum: ptr(3)},
								{Type: api.Context, Content: "", OldLineNum: ptr(3), NewLineNum: ptr(4)},
							},
						},
					},
				},
				{
					Path:       "new_file.txt",
					ChangeType: api.DiffFileChangeTypeAdded,
					Additions:  1,
					Deletions:  0,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -0,0 +1 @@",
							OldStart: 0,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Addition, Content: "Hello world", NewLineNum: ptr(1)},
							},
						},
					},
				},
			},
		}
		resp.Files = expandDiffContext(resp.Files, ctx)
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}

	if id == "agent-1" {
		resp := api.DiffResponse{
			BaseRef: "main",
			HeadRef: "hydra/feat-1",
			Files: []api.DiffFile{
				{
					Path:       "internal/heads/heads.go",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  47,
					Deletions:  18,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,12 +1,14 @@",
							OldStart: 1,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "package heads", OldLineNum: ptr(1), NewLineNum: ptr(1)},
								{Type: api.Context, Content: "", OldLineNum: ptr(2), NewLineNum: ptr(2)},
								{Type: api.Context, Content: "import (", OldLineNum: ptr(3), NewLineNum: ptr(3)},
								{Type: api.Context, Content: "\t\"context\"", OldLineNum: ptr(4), NewLineNum: ptr(4)},
								{Type: api.Addition, Content: "\t\"errors\"", NewLineNum: ptr(5)},
								{Type: api.Context, Content: "\t\"fmt\"", OldLineNum: ptr(5), NewLineNum: ptr(6)},
								{Type: api.Context, Content: "\t\"log\"", OldLineNum: ptr(6), NewLineNum: ptr(7)},
								{Type: api.Addition, Content: "\t\"sync\"", NewLineNum: ptr(8)},
								{Type: api.Context, Content: "\t\"time\"", OldLineNum: ptr(7), NewLineNum: ptr(9)},
								{Type: api.Context, Content: ")", OldLineNum: ptr(8), NewLineNum: ptr(10)},
							},
						},
						{
							Header:   "@@ -42,19 +44,31 @@ type Head struct {",
							OldStart: 42,
							NewStart: 44,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "// SpawnHead creates a new agent head.", OldLineNum: ptr(42), NewLineNum: ptr(44)},
								{Type: api.Deletion, Content: "func SpawnHead(ctx context.Context, opts SpawnOptions) (*Head, error) {", OldLineNum: ptr(43)},
								{Type: api.Addition, Content: "func SpawnHead(ctx context.Context, store *db.Store, opts SpawnOptions) (*Head, error) {", NewLineNum: ptr(45)},
								{Type: api.Context, Content: "\tif opts.ID == \"\" {", OldLineNum: ptr(44), NewLineNum: ptr(46)},
								{Type: api.Context, Content: "\t\topts.ID = generateID()", OldLineNum: ptr(45), NewLineNum: ptr(47)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(46), NewLineNum: ptr(48)},
								{Type: api.Deletion, Content: "\tif err := validateOptions(opts); err != nil {", OldLineNum: ptr(47)},
								{Type: api.Deletion, Content: "\t\treturn nil, err", OldLineNum: ptr(48)},
								{Type: api.Addition, Content: "\tif err := validateOptions(opts); err != nil {", NewLineNum: ptr(49)},
								{Type: api.Addition, Content: "\t\treturn nil, fmt.Errorf(\"spawn %s: %w\", opts.ID, err)", NewLineNum: ptr(50)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(49), NewLineNum: ptr(51)},
								{Type: api.Context, Content: "", OldLineNum: ptr(50), NewLineNum: ptr(52)},
								{Type: api.Addition, Content: "\tif store != nil {", NewLineNum: ptr(53)},
								{Type: api.Addition, Content: "\t\tif err := store.UpsertAgent(&db.Agent{ID: opts.ID, SessionStatus: \"pending\"}); err != nil {", NewLineNum: ptr(54)},
								{Type: api.Addition, Content: "\t\t\treturn nil, fmt.Errorf(\"upsert agent: %w\", err)", NewLineNum: ptr(55)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(56)},
								{Type: api.Addition, Content: "\t}", NewLineNum: ptr(57)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(58)},
								{Type: api.Context, Content: "\treturn spawnInternal(ctx, opts)", OldLineNum: ptr(51), NewLineNum: ptr(59)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(52), NewLineNum: ptr(60)},
							},
						},
						{
							Header:   "@@ -98,22 +112,28 @@ func SpawnHead(ctx context.Context, opts SpawnOptions) (*Head, error) {",
							OldStart: 98,
							NewStart: 112,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "// KillHead stops a head's session, worktree, and branch.", OldLineNum: ptr(98), NewLineNum: ptr(112)},
								{Type: api.Deletion, Content: "func KillHead(ctx context.Context, reg *session.Registry, head Head) error {", OldLineNum: ptr(99)},
								{Type: api.Addition, Content: "func KillHead(ctx context.Context, reg *session.Registry, store *db.Store, head Head) error {", NewLineNum: ptr(113)},
								{Type: api.Context, Content: "\tlog.Printf(\"heads: kill requested for agent %s\", head.ID)", OldLineNum: ptr(100), NewLineNum: ptr(114)},
								{Type: api.Deletion, Content: "\tsessionPID := head.SessionPID", OldLineNum: ptr(101)},
								{Type: api.Addition, Content: "\tif store != nil {", NewLineNum: ptr(115)},
								{Type: api.Addition, Content: "\t\tok, err := store.TrySetHeadStatus(head.ID, \"idle\", \"killing\")", NewLineNum: ptr(116)},
								{Type: api.Addition, Content: "\t\tif err != nil {", NewLineNum: ptr(117)},
								{Type: api.Addition, Content: "\t\t\treturn errtrace.Wrap(err)", NewLineNum: ptr(118)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(119)},
								{Type: api.Addition, Content: "\t\tif !ok {", NewLineNum: ptr(120)},
								{Type: api.Addition, Content: "\t\t\treturn errtrace.Wrap(db.ErrOperationInProgress)", NewLineNum: ptr(121)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(122)},
								{Type: api.Addition, Content: "\t}", NewLineNum: ptr(123)},
								{Type: api.Addition, Content: "\tsessionPID := head.SessionPID", NewLineNum: ptr(124)},
								{Type: api.Context, Content: "\tif sessionPID == 0 {", OldLineNum: ptr(102), NewLineNum: ptr(125)},
								{Type: api.Context, Content: "\t\tlog.Printf(\"heads: %s has no live session\", head.ID)", OldLineNum: ptr(103), NewLineNum: ptr(126)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(104), NewLineNum: ptr(127)},
								{Type: api.Deletion, Content: "\treturn killInternal(ctx, reg, head, sessionPID)", OldLineNum: ptr(105)},
								{Type: api.Addition, Content: "\treturn killInternal(ctx, reg, store, head, sessionPID)", NewLineNum: ptr(128)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(106), NewLineNum: ptr(129)},
							},
						},
					},
				},
				{
					Path:       "internal/http/simulation.go",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  22,
					Deletions:  8,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -61,14 +61,28 @@ func (s *SimulationServer) ListAgents(...) {",
							OldStart: 61,
							NewStart: 61,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "\trunning := api.Running", OldLineNum: ptr(61), NewLineNum: ptr(61)},
								{Type: api.Context, Content: "\twaiting := api.Waiting", OldLineNum: ptr(62), NewLineNum: ptr(62)},
								{Type: api.Addition, Content: "\tbuilding := api.Building", NewLineNum: ptr(63)},
								{Type: api.Addition, Content: "\tkilling := api.Killing", NewLineNum: ptr(64)},
								{Type: api.Context, Content: "", OldLineNum: ptr(63), NewLineNum: ptr(65)},
								{Type: api.Context, Content: "\tresp := api.ListAgents200JSONResponse{", OldLineNum: ptr(64), NewLineNum: ptr(66)},
								{Type: api.Deletion, Content: "\t\t{Id: \"agent-1\", AgentType: \"claude\", AgentStatus: &api.AgentStatusInfo{Status: running}},", OldLineNum: ptr(65)},
								{Type: api.Deletion, Content: "\t\t{Id: \"agent-2\", AgentType: \"gemini\", AgentStatus: &api.AgentStatusInfo{Status: waiting}},", OldLineNum: ptr(66)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-1\", AgentType: \"claude\", AgentStatus: &api.AgentStatusInfo{Status: running}},", NewLineNum: ptr(67)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-2\", AgentType: \"gemini\", AgentStatus: &api.AgentStatusInfo{Status: waiting}},", NewLineNum: ptr(68)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-3\", AgentType: \"claude\", AgentStatus: &api.AgentStatusInfo{Status: building}},", NewLineNum: ptr(69)},
								{Type: api.Addition, Content: "\t\t{Id: \"agent-4\", AgentType: \"gemini\", AgentStatus: &api.AgentStatusInfo{Status: killing}},", NewLineNum: ptr(70)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(67), NewLineNum: ptr(71)},
							},
						},
					},
				},
				{
					Path:       "web/src/components/AgentDetail.tsx",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  38,
					Deletions:  14,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,8 +1,10 @@",
							OldStart: 1,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "import { useState, useEffect, useCallback } from 'react'", OldLineNum: ptr(1), NewLineNum: ptr(1)},
								{Type: api.Deletion, Content: "import { api } from '../stores/apiClient'", OldLineNum: ptr(2)},
								{Type: api.Addition, Content: "import { api, type RequestError } from '../stores/apiClient'", NewLineNum: ptr(2)},
								{Type: api.Context, Content: "import type { AgentResponse } from '../api'", OldLineNum: ptr(3), NewLineNum: ptr(3)},
								{Type: api.Addition, Content: "import { useAgentStore } from '../stores/agentStore'", NewLineNum: ptr(4)},
								{Type: api.Context, Content: "import { DiffViewer } from '../DiffViewer'", OldLineNum: ptr(4), NewLineNum: ptr(5)},
								{Type: api.Deletion, Content: "import { GitMerge, Trash2 } from 'lucide-react'", OldLineNum: ptr(5)},
								{Type: api.Addition, Content: "import { GitMerge, Trash2, RefreshCw, AlertCircle } from 'lucide-react'", NewLineNum: ptr(6)},
							},
						},
						{
							Header:   "@@ -44,18 +46,32 @@ export function AgentDetail({ agent, projectId }: Props) {",
							OldStart: 44,
							NewStart: 46,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "  const [killing, setKilling] = useState(false)", OldLineNum: ptr(44), NewLineNum: ptr(46)},
								{Type: api.Addition, Content: "  const [restarting, setRestarting] = useState(false)", NewLineNum: ptr(47)},
								{Type: api.Addition, Content: "  const [error, setError] = useState<string | null>(null)", NewLineNum: ptr(48)},
								{Type: api.Context, Content: "", OldLineNum: ptr(45), NewLineNum: ptr(49)},
								{Type: api.Deletion, Content: "  async function handleKill() {", OldLineNum: ptr(46)},
								{Type: api.Addition, Content: "  async function handleKill() {", NewLineNum: ptr(50)},
								{Type: api.Context, Content: "    setKilling(true)", OldLineNum: ptr(47), NewLineNum: ptr(51)},
								{Type: api.Deletion, Content: "    await api.killAgent(projectId, agent.id)", OldLineNum: ptr(48)},
								{Type: api.Deletion, Content: "    setKilling(false)", OldLineNum: ptr(49)},
								{Type: api.Addition, Content: "    setError(null)", NewLineNum: ptr(52)},
								{Type: api.Addition, Content: "    try {", NewLineNum: ptr(53)},
								{Type: api.Addition, Content: "      await api.killAgent(projectId, agent.id)", NewLineNum: ptr(54)},
								{Type: api.Addition, Content: "    } catch (e) {", NewLineNum: ptr(55)},
								{Type: api.Addition, Content: "      setError((e as RequestError).message ?? 'Kill failed')", NewLineNum: ptr(56)},
								{Type: api.Addition, Content: "    } finally {", NewLineNum: ptr(57)},
								{Type: api.Addition, Content: "      setKilling(false)", NewLineNum: ptr(58)},
								{Type: api.Addition, Content: "    }", NewLineNum: ptr(59)},
								{Type: api.Context, Content: "  }", OldLineNum: ptr(50), NewLineNum: ptr(60)},
								{Type: api.Context, Content: "", OldLineNum: ptr(51), NewLineNum: ptr(61)},
								{Type: api.Addition, Content: "  async function handleRestart() {", NewLineNum: ptr(62)},
								{Type: api.Addition, Content: "    setRestarting(true)", NewLineNum: ptr(63)},
								{Type: api.Addition, Content: "    setError(null)", NewLineNum: ptr(64)},
								{Type: api.Addition, Content: "    try {", NewLineNum: ptr(65)},
								{Type: api.Addition, Content: "      await api.restartAgent(projectId, agent.id)", NewLineNum: ptr(66)},
								{Type: api.Addition, Content: "    } catch (e) {", NewLineNum: ptr(67)},
								{Type: api.Addition, Content: "      setError((e as RequestError).message ?? 'Restart failed')", NewLineNum: ptr(68)},
								{Type: api.Addition, Content: "    } finally {", NewLineNum: ptr(69)},
								{Type: api.Addition, Content: "      setRestarting(false)", NewLineNum: ptr(70)},
								{Type: api.Addition, Content: "    }", NewLineNum: ptr(71)},
								{Type: api.Addition, Content: "  }", NewLineNum: ptr(72)},
							},
						},
						{
							Header:   "@@ -89,10 +103,14 @@ export function AgentDetail({ agent, projectId }: Props) {",
							OldStart: 89,
							NewStart: 103,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "  return (", OldLineNum: ptr(89), NewLineNum: ptr(103)},
								{Type: api.Context, Content: "    <div className=\"flex flex-col gap-4\">", OldLineNum: ptr(90), NewLineNum: ptr(104)},
								{Type: api.Addition, Content: "      {error && (", NewLineNum: ptr(105)},
								{Type: api.Addition, Content: "        <div className=\"flex items-center gap-2 text-red-400 text-sm\">", NewLineNum: ptr(106)},
								{Type: api.Addition, Content: "          <AlertCircle className=\"w-4 h-4\" />", NewLineNum: ptr(107)},
								{Type: api.Addition, Content: "          <span>{error}</span>", NewLineNum: ptr(108)},
								{Type: api.Addition, Content: "        </div>", NewLineNum: ptr(109)},
								{Type: api.Addition, Content: "      )}", NewLineNum: ptr(110)},
								{Type: api.Context, Content: "      <div className=\"flex gap-2\">", OldLineNum: ptr(91), NewLineNum: ptr(111)},
								{Type: api.Deletion, Content: "        <KillButton onClick={handleKill} loading={killing} />", OldLineNum: ptr(92)},
								{Type: api.Addition, Content: "        <KillButton onClick={handleKill} loading={killing} />", NewLineNum: ptr(112)},
								{Type: api.Addition, Content: "        <RestartButton onClick={handleRestart} loading={restarting} />", NewLineNum: ptr(113)},
								{Type: api.Context, Content: "      </div>", OldLineNum: ptr(93), NewLineNum: ptr(114)},
								{Type: api.Context, Content: "    </div>", OldLineNum: ptr(94), NewLineNum: ptr(115)},
							},
						},
					},
				},
				{
					Path:       "internal/db/queries.go",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  29,
					Deletions:  4,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -78,10 +78,35 @@ func (s *Store) SoftDeleteAgent(id string) error {",
							OldStart: 78,
							NewStart: 78,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "// TrySetHeadStatus atomically sets head_status from expected to next.", OldLineNum: ptr(78), NewLineNum: ptr(78)},
								{Type: api.Context, Content: "// Returns (true, nil) on success, (false, nil) if CAS failed.", OldLineNum: ptr(79), NewLineNum: ptr(79)},
								{Type: api.Deletion, Content: "func (s *Store) TrySetHeadStatus(id, from, to string) (bool, error) {", OldLineNum: ptr(80)},
								{Type: api.Deletion, Content: "\tres := s.db.Model(&Agent{}).Where(\"id = ? AND head_status = ?\", id, from).Update(\"head_status\", to)", OldLineNum: ptr(81)},
								{Type: api.Deletion, Content: "\treturn res.RowsAffected > 0, res.Error", OldLineNum: ptr(82)},
								{Type: api.Deletion, Content: "}", OldLineNum: ptr(83)},
								{Type: api.Addition, Content: "func (s *Store) TrySetHeadStatus(id, from, to string) (bool, error) {", NewLineNum: ptr(80)},
								{Type: api.Addition, Content: "\tvar affected int64", NewLineNum: ptr(81)},
								{Type: api.Addition, Content: "\terr := s.db.Transaction(func(tx *gorm.DB) error {", NewLineNum: ptr(82)},
								{Type: api.Addition, Content: "\t\tvar a Agent", NewLineNum: ptr(83)},
								{Type: api.Addition, Content: "\t\tif err := tx.First(&a, \"id = ?\", id).Error; err != nil {", NewLineNum: ptr(84)},
								{Type: api.Addition, Content: "\t\t\treturn err", NewLineNum: ptr(85)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(86)},
								{Type: api.Addition, Content: "\t\tif a.HeadStatus != from {", NewLineNum: ptr(87)},
								{Type: api.Addition, Content: "\t\t\treturn nil", NewLineNum: ptr(88)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(89)},
								{Type: api.Addition, Content: "\t\tres := tx.Model(&a).Update(\"head_status\", to)", NewLineNum: ptr(90)},
								{Type: api.Addition, Content: "\t\taffected = res.RowsAffected", NewLineNum: ptr(91)},
								{Type: api.Addition, Content: "\t\treturn res.Error", NewLineNum: ptr(92)},
								{Type: api.Addition, Content: "\t})", NewLineNum: ptr(93)},
								{Type: api.Addition, Content: "\tif err != nil {", NewLineNum: ptr(94)},
								{Type: api.Addition, Content: "\t\treturn false, errtrace.Wrap(err)", NewLineNum: ptr(95)},
								{Type: api.Addition, Content: "\t}", NewLineNum: ptr(96)},
								{Type: api.Addition, Content: "\treturn affected > 0, nil", NewLineNum: ptr(97)},
								{Type: api.Addition, Content: "}", NewLineNum: ptr(98)},
								{Type: api.Context, Content: "", OldLineNum: ptr(84), NewLineNum: ptr(99)},
								{Type: api.Addition, Content: "var ErrOperationInProgress = errors.New(\"operation already in progress\")", NewLineNum: ptr(100)},
								{Type: api.Context, Content: "", OldLineNum: ptr(85), NewLineNum: ptr(101)},
								{Type: api.Context, Content: "// ClearHeadStatus resets head_status back to idle.", OldLineNum: ptr(86), NewLineNum: ptr(102)},
							},
						},
					},
				},
				{
					Path:       "internal/http/server.go",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  12,
					Deletions:  3,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -134,9 +134,18 @@ func (s *Server) KillAgent(w http.ResponseWriter, r *http.Request, ...) {",
							OldStart: 134,
							NewStart: 134,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "\thead, err := heads.GetHeadByID(r.Context(), s.Sessions, s.DB, projectRoot, id)", OldLineNum: ptr(134), NewLineNum: ptr(134)},
								{Type: api.Context, Content: "\tif err != nil || head == nil {", OldLineNum: ptr(135), NewLineNum: ptr(135)},
								{Type: api.Context, Content: "\t\tapi.WriteError(w, http.StatusNotFound, \"agent not found\")", OldLineNum: ptr(136), NewLineNum: ptr(136)},
								{Type: api.Context, Content: "\t\treturn", OldLineNum: ptr(137), NewLineNum: ptr(137)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(138), NewLineNum: ptr(138)},
								{Type: api.Deletion, Content: "\tif err := heads.KillHead(r.Context(), s.Sessions, *head); err != nil {", OldLineNum: ptr(139)},
								{Type: api.Deletion, Content: "\t\tapi.WriteError(w, http.StatusInternalServerError, err.Error())", OldLineNum: ptr(140)},
								{Type: api.Deletion, Content: "\t\treturn", OldLineNum: ptr(141)},
								{Type: api.Addition, Content: "\tif err := heads.KillHead(r.Context(), s.Sessions, s.DB, *head); err != nil {", NewLineNum: ptr(139)},
								{Type: api.Addition, Content: "\t\tif errors.Is(err, db.ErrOperationInProgress) {", NewLineNum: ptr(140)},
								{Type: api.Addition, Content: "\t\t\tapi.WriteError(w, http.StatusConflict, \"kill already in progress\")", NewLineNum: ptr(141)},
								{Type: api.Addition, Content: "\t\t\treturn", NewLineNum: ptr(142)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(143)},
								{Type: api.Addition, Content: "\t\tapi.WriteError(w, http.StatusInternalServerError, err.Error())", NewLineNum: ptr(144)},
								{Type: api.Addition, Content: "\t\treturn", NewLineNum: ptr(145)},
								{Type: api.Context, Content: "\t}", OldLineNum: ptr(142), NewLineNum: ptr(146)},
								{Type: api.Context, Content: "\tw.WriteHeader(http.StatusNoContent)", OldLineNum: ptr(143), NewLineNum: ptr(147)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(144), NewLineNum: ptr(148)},
							},
						},
					},
				},
				{
					Path:       "internal/db/model.go",
					ChangeType: api.DiffFileChangeTypeDeleted,
					Additions:  0,
					Deletions:  42,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,42 +0,0 @@",
							OldStart: 1,
							NewStart: 0,
							Lines: []api.DiffLine{
								{Type: api.Deletion, Content: "package db", OldLineNum: ptr(1)},
								{Type: api.Deletion, Content: "", OldLineNum: ptr(2)},
								{Type: api.Deletion, Content: "import \"time\"", OldLineNum: ptr(3)},
								{Type: api.Deletion, Content: "", OldLineNum: ptr(4)},
								{Type: api.Deletion, Content: "// Agent is the GORM model for a Hydra agent.", OldLineNum: ptr(5)},
								{Type: api.Deletion, Content: "type Agent struct {", OldLineNum: ptr(6)},
								{Type: api.Deletion, Content: "\tID              string    `gorm:\"primaryKey\"`", OldLineNum: ptr(7)},
								{Type: api.Deletion, Content: "\tProjectPath     string", OldLineNum: ptr(8)},
								{Type: api.Deletion, Content: "\tSessionPID      int", OldLineNum: ptr(9)},
								{Type: api.Deletion, Content: "\tLastError       *string", OldLineNum: ptr(10)},
								{Type: api.Deletion, Content: "\tSessionStatus   string", OldLineNum: ptr(11)},
								{Type: api.Deletion, Content: "\tAgentStatus     *string", OldLineNum: ptr(12)},
								{Type: api.Deletion, Content: "\tAgentStatusTime string", OldLineNum: ptr(13)},
								{Type: api.Deletion, Content: "\tHeadStatus      string    `gorm:\"default:idle\"`", OldLineNum: ptr(14)},
								{Type: api.Deletion, Content: "\tBranchName      string", OldLineNum: ptr(15)},
								{Type: api.Deletion, Content: "\tBaseBranch      string", OldLineNum: ptr(16)},
								{Type: api.Deletion, Content: "\tAgentType       string", OldLineNum: ptr(17)},
								{Type: api.Deletion, Content: "\tPrePrompt       string", OldLineNum: ptr(18)},
								{Type: api.Deletion, Content: "\tPrompt          string", OldLineNum: ptr(19)},
								{Type: api.Deletion, Content: "\tEphemeral       bool", OldLineNum: ptr(20)},
								{Type: api.Deletion, Content: "\tCreatedAt       time.Time", OldLineNum: ptr(21)},
								{Type: api.Deletion, Content: "\tDeletedAt       gorm.DeletedAt `gorm:\"index\"`", OldLineNum: ptr(22)},
								{Type: api.Deletion, Content: "}", OldLineNum: ptr(23)},
							},
						},
					},
				},
				{
					Path:       "internal/db/schema.go",
					ChangeType: api.DiffFileChangeTypeAdded,
					Additions:  58,
					Deletions:  0,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -0,0 +1,58 @@",
							OldStart: 0,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Addition, Content: "package db", NewLineNum: ptr(1)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(2)},
								{Type: api.Addition, Content: "import (", NewLineNum: ptr(3)},
								{Type: api.Addition, Content: "\t\"errors\"", NewLineNum: ptr(4)},
								{Type: api.Addition, Content: "\t\"time\"", NewLineNum: ptr(5)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(6)},
								{Type: api.Addition, Content: "\t\"gorm.io/gorm\"", NewLineNum: ptr(7)},
								{Type: api.Addition, Content: ")", NewLineNum: ptr(8)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(9)},
								{Type: api.Addition, Content: "// Agent is the GORM model for a Hydra agent.", NewLineNum: ptr(10)},
								{Type: api.Addition, Content: "type Agent struct {", NewLineNum: ptr(11)},
								{Type: api.Addition, Content: "\tID              string         `gorm:\"primaryKey\"`", NewLineNum: ptr(12)},
								{Type: api.Addition, Content: "\tProjectPath     string", NewLineNum: ptr(13)},
								{Type: api.Addition, Content: "\tSessionPID      int", NewLineNum: ptr(14)},
								{Type: api.Addition, Content: "\tLastError       *string", NewLineNum: ptr(15)},
								{Type: api.Addition, Content: "\tSessionStatus   string", NewLineNum: ptr(16)},
								{Type: api.Addition, Content: "\tAgentStatus     *string", NewLineNum: ptr(17)},
								{Type: api.Addition, Content: "\tAgentStatusTime string", NewLineNum: ptr(18)},
								{Type: api.Addition, Content: "\tHeadStatus      string         `gorm:\"default:idle\"`", NewLineNum: ptr(19)},
								{Type: api.Addition, Content: "\tBranchName      string", NewLineNum: ptr(20)},
								{Type: api.Addition, Content: "\tBaseBranch      string", NewLineNum: ptr(21)},
								{Type: api.Addition, Content: "\tAgentType       string", NewLineNum: ptr(22)},
								{Type: api.Addition, Content: "\tPrePrompt       string", NewLineNum: ptr(23)},
								{Type: api.Addition, Content: "\tPrompt          string", NewLineNum: ptr(24)},
								{Type: api.Addition, Content: "\tEphemeral       bool", NewLineNum: ptr(25)},
								{Type: api.Addition, Content: "\tCreatedAt       time.Time", NewLineNum: ptr(26)},
								{Type: api.Addition, Content: "\tDeletedAt       gorm.DeletedAt `gorm:\"index\"`", NewLineNum: ptr(27)},
								{Type: api.Addition, Content: "}", NewLineNum: ptr(28)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(29)},
								{Type: api.Addition, Content: "// ErrOperationInProgress is returned when a CAS update fails.", NewLineNum: ptr(30)},
								{Type: api.Addition, Content: "var ErrOperationInProgress = errors.New(\"operation already in progress\")", NewLineNum: ptr(31)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(32)},
								{Type: api.Addition, Content: "// Migrate runs auto-migration for all models.", NewLineNum: ptr(33)},
								{Type: api.Addition, Content: "func Migrate(db *gorm.DB) error {", NewLineNum: ptr(34)},
								{Type: api.Addition, Content: "\treturn db.AutoMigrate(&Agent{})", NewLineNum: ptr(35)},
								{Type: api.Addition, Content: "}", NewLineNum: ptr(36)},
							},
						},
					},
				},
			},
		}
		resp.Files = expandDiffContext(resp.Files, ctx)
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}

	if id == "agent-3" {
		// Deeply-nested paths chosen to exercise every branch of the diff tree's
		// "compact folders" logic (web/src/DiffViewer.tsx → compactTree):
		//   - README.md                       top-level file, no folder to fold.
		//   - docs/architecture/diagrams/...   a pure single-child chain that
		//                                      fully collapses onto one row.
		//   - internal/app/services/...        two sibling chains (auth, billing)
		//                                      under one trunk: the trunk folds to
		//                                      `internal/app/services`, then each
		//                                      branch folds independently — auth's
		//                                      chain stops at `google` because it
		//                                      holds two files.
		//   - web/src/{index.ts,components/…}  `web` folds into `src`, but `src`
		//                                      holds a file AND a folder so the
		//                                      chain stops there (no over-merging).
		resp := api.DiffResponse{
			BaseRef: "main",
			HeadRef: "hydra/feat-3",
			Files: []api.DiffFile{
				simFile("README.md", api.DiffFileChangeTypeModified, 1, 0,
					"@@ -1,2 +1,3 @@", 1, 1,
					api.DiffLine{Type: api.Context, Content: "# Hydra", OldLineNum: ptr(1), NewLineNum: ptr(1)},
					api.DiffLine{Type: api.Addition, Content: "Now with deeply nested auth providers.", NewLineNum: ptr(2)},
					api.DiffLine{Type: api.Context, Content: "", OldLineNum: ptr(2), NewLineNum: ptr(3)},
				),
				simFile("docs/architecture/diagrams/overview.md", api.DiffFileChangeTypeAdded, 2, 0,
					"@@ -0,0 +1,2 @@", 0, 1,
					api.DiffLine{Type: api.Addition, Content: "# Architecture overview", NewLineNum: ptr(1)},
					api.DiffLine{Type: api.Addition, Content: "See the provider tree below.", NewLineNum: ptr(2)},
				),
				simFile("internal/app/services/auth/providers/oauth/google/client.go", api.DiffFileChangeTypeAdded, 3, 0,
					"@@ -0,0 +1,3 @@", 0, 1,
					api.DiffLine{Type: api.Addition, Content: "package google", NewLineNum: ptr(1)},
					api.DiffLine{Type: api.Addition, Content: "", NewLineNum: ptr(2)},
					api.DiffLine{Type: api.Addition, Content: "type Client struct{ token string }", NewLineNum: ptr(3)},
				),
				simFile("internal/app/services/auth/providers/oauth/google/handler.go", api.DiffFileChangeTypeAdded, 2, 0,
					"@@ -0,0 +1,2 @@", 0, 1,
					api.DiffLine{Type: api.Addition, Content: "package google", NewLineNum: ptr(1)},
					api.DiffLine{Type: api.Addition, Content: "func Handle() {}", NewLineNum: ptr(2)},
				),
				simFile("internal/app/services/billing/stripe/webhook.go", api.DiffFileChangeTypeModified, 1, 1,
					"@@ -3,3 +3,3 @@", 3, 3,
					api.DiffLine{Type: api.Context, Content: "func Webhook() {", OldLineNum: ptr(3), NewLineNum: ptr(3)},
					api.DiffLine{Type: api.Deletion, Content: "\t// TODO", OldLineNum: ptr(4)},
					api.DiffLine{Type: api.Addition, Content: "\tverifySignature()", NewLineNum: ptr(4)},
					api.DiffLine{Type: api.Context, Content: "}", OldLineNum: ptr(5), NewLineNum: ptr(5)},
				),
				simFile("web/src/index.ts", api.DiffFileChangeTypeModified, 1, 0,
					"@@ -1,1 +1,2 @@", 1, 1,
					api.DiffLine{Type: api.Context, Content: "import './app'", OldLineNum: ptr(1), NewLineNum: ptr(1)},
					api.DiffLine{Type: api.Addition, Content: "import './components/Button'", NewLineNum: ptr(2)},
				),
				simFile("web/src/components/Button.tsx", api.DiffFileChangeTypeAdded, 1, 0,
					"@@ -0,0 +1,1 @@", 0, 1,
					api.DiffLine{Type: api.Addition, Content: "export const Button = () => null", NewLineNum: ptr(1)},
				),
			},
		}
		resp.Files = expandDiffContext(resp.Files, ctx)
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}

	api.WriteJSON(w, http.StatusOK, api.DiffResponse{Files: []api.DiffFile{}})
}

// simFile builds a single-hunk DiffFile for the simulation server, keeping the
// nested-folder fixtures (agent-3) terse.
func simFile(path string, ct api.DiffFileChangeType, add, del int, header string, oldStart, newStart int, lines ...api.DiffLine) api.DiffFile {
	return api.DiffFile{
		Path:       path,
		ChangeType: ct,
		Additions:  add,
		Deletions:  del,
		Hunks: []api.DiffHunk{
			{Header: header, OldStart: oldStart, NewStart: newStart, Lines: lines},
		},
	}
}

// maxSimContext caps the requested diff context. The real server feeds the
// value to `git diff -U<n>`, which never emits more context than a file
// actually has, so its memory is bounded by the checkout. The simulation has no
// backing file: expandHunkContext *synthesizes* one "context line N" per
// requested line, per hunk, so an unbounded client value (e.g. a stray
// ?context=5000000) allocates millions of DiffLines — each with a heap string
// and two heap *int — across every hunk, ballooning RSS into the gigabytes (a
// single large request OOM-kills the process). The mock diffs are tiny and the
// UI only ever asks for gapSize/2 (tens of lines), so this ceiling is far above
// any legitimate request while keeping a hostile/buggy one cheap.
const maxSimContext = 1000

func simContext(params api.GetAgentDiffParams) int {
	// Deliberately ignore full_context: the fixtures are compact -U3 hunks, not
	// whole-file-contiguous content, so synthesizing full context for them just
	// yields a long, unhelpful diff on load (bad for screenshots). The real
	// server handles full_context; the sim keeps the compact view and still
	// expands a file on demand via an explicit larger Context (network expand).
	if params.Context != nil {
		return min(*params.Context, maxSimContext)
	}
	return 3
}

func (s *SimulationServer) GetAgentDiffFiles(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentDiffFilesParams) {
	if id == "agent-1" {
		resp := api.DiffResponse{
			Files: []api.DiffFile{
				{Path: "internal/heads/heads.go", ChangeType: api.DiffFileChangeTypeModified, Additions: 47, Deletions: 18},
				{Path: "internal/http/simulation.go", ChangeType: api.DiffFileChangeTypeModified, Additions: 22, Deletions: 8},
				{Path: "web/src/components/AgentDetail.tsx", ChangeType: api.DiffFileChangeTypeModified, Additions: 38, Deletions: 14},
				{Path: "internal/db/queries.go", ChangeType: api.DiffFileChangeTypeModified, Additions: 29, Deletions: 4},
				{Path: "internal/http/server.go", ChangeType: api.DiffFileChangeTypeModified, Additions: 12, Deletions: 3},
				{Path: "internal/db/model.go", ChangeType: api.DiffFileChangeTypeDeleted, Additions: 0, Deletions: 42},
				{Path: "internal/db/schema.go", ChangeType: api.DiffFileChangeTypeAdded, Additions: 58, Deletions: 0},
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	if id == "agent-3" {
		resp := api.DiffResponse{
			BaseRef: "main",
			HeadRef: "hydra/feat-3",
			Files: []api.DiffFile{
				{Path: "README.md", ChangeType: api.DiffFileChangeTypeModified, Additions: 1, Deletions: 0},
				{Path: "docs/architecture/diagrams/overview.md", ChangeType: api.DiffFileChangeTypeAdded, Additions: 2, Deletions: 0},
				{Path: "internal/app/services/auth/providers/oauth/google/client.go", ChangeType: api.DiffFileChangeTypeAdded, Additions: 3, Deletions: 0},
				{Path: "internal/app/services/auth/providers/oauth/google/handler.go", ChangeType: api.DiffFileChangeTypeAdded, Additions: 2, Deletions: 0},
				{Path: "internal/app/services/billing/stripe/webhook.go", ChangeType: api.DiffFileChangeTypeModified, Additions: 1, Deletions: 1},
				{Path: "web/src/index.ts", ChangeType: api.DiffFileChangeTypeModified, Additions: 1, Deletions: 0},
				{Path: "web/src/components/Button.tsx", ChangeType: api.DiffFileChangeTypeAdded, Additions: 1, Deletions: 0},
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	if id == "agent-2" {
		uncommitted := true
		resp := api.DiffResponse{
			UncommittedChanges: &uncommitted,
			UncommittedSummary: &api.UncommittedSummary{
				TrackedCount:   2,
				UntrackedCount: 1,
			},
			Files: []api.DiffFile{},
		}
		if params.IncludeUncommitted != nil && *params.IncludeUncommitted {
			resp.Files = []api.DiffFile{
				{Path: "README.md", ChangeType: api.DiffFileChangeTypeModified, Additions: 2, Deletions: 1},
				{Path: "new_file.txt", ChangeType: api.DiffFileChangeTypeAdded, Additions: 1, Deletions: 0},
			}
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	api.WriteJSON(w, http.StatusOK, api.DiffResponse{Files: []api.DiffFile{}})
}

// simSVG builds an inline data-URL SVG image (w×h) so the demo can render
// artifacts without any on-disk blob serving. Mixing tall "phone" shapes with
// wide "desktop" ones shows off the flex-wrap artifact layout: narrow shots
// pack several per row while a wide one claims its own.
func simSVG(label, color string, w, h int) string {
	doc := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d">`+
		`<rect width="%d" height="%d" fill="%s"/>`+
		`<text x="%d" y="%d" font-family="sans-serif" font-size="18" fill="white" text-anchor="middle">%s</text></svg>`,
		w, h, w, h, color, w/2, h/2, label)
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(doc))
}

// simArtifactLog is a believable multi-line generation log for the in-flight
// artifact set, so the diff viewer can document the expanded live-log view
// (stdout plus a couple of stderr warnings rendered in red). The final stdout
// line matches the header progress.
func simArtifactLog() []api.ArtifactLogLine {
	out := func(t string) api.ArtifactLogLine { return api.ArtifactLogLine{Text: t, Stream: api.Stdout} }
	errLine := func(t string) api.ArtifactLogLine { return api.ArtifactLogLine{Text: t, Stream: api.Stderr} }
	return []api.ArtifactLogLine{
		out("Rendering Hydra UI for ref a1b2c3d from /checkout"),
		out("building frontend"),
		out("+ (/checkout/web) bun install"),
		out("bun install v1.1.34"),
		out("+ playwright@1.49.0"),
		out("120 packages installed [2.31s]"),
		out("+ (/checkout/web) bun x vite build"),
		out("vite v6.0.7 building for production..."),
		errLine("warning: \"motion\" is imported by src/App.tsx but never used"),
		out("✓ 1432 modules transformed."),
		out("✓ built in 4.21s"),
		out("building hydra binary"),
		out("booting simulation server"),
		out("capturing screenshots"),
		out("home.png 1/12"),
		out("wrote /out/home.png"),
		out("repository.png 2/12"),
		out("wrote /out/repository.png"),
		errLine("[chromium] Failed to decode font hint table (non-fatal)"),
		out("artifacts-side-by-side.png 5/12"),
		out("wrote /out/artifacts-side-by-side.png"),
		out("artifacts-ab-dark.png 7/12"),
	}
}

// simArtifactSets returns the mock artifact sets for the simulated agent, shared
// by the HTTP poll handler and the streaming WS handler.
func simArtifactSets(id string) []api.ArtifactSet {
	if id != "agent-1" {
		return []api.ArtifactSet{}
	}
	leftProgress := "building frontend"
	rightProgress := "artifacts-ab-dark.png 7/12"
	startedAt := simNow().Add(-8 * time.Second).Unix()
	leftLog := simArtifactLog()
	rightLog := simArtifactLog()
	return []api.ArtifactSet{
		simReadyChangedSet(),
		// In-flight generation: the header shows a spinner, both sides' progress
		// lines joined by "·", and how long it has been running; expanding the card
		// reveals the two side-by-side stdout+stderr logs (stderr in red).
		{
			Name:          "components",
			Status:        api.ArtifactSetStatusGenerating,
			LeftProgress:  &leftProgress,
			RightProgress: &rightProgress,
			StartedAt:     &startedAt,
			LeftLog:       &leftLog,
			RightLog:      &rightLog,
			Files:         []api.ArtifactFile{},
		},
		// Failure: the error (script stderr tail) renders monospaced; refresh retries.
		{
			Name:   "storybook",
			Status: api.ArtifactSetStatusError,
			Error:  ptr("exited 1: error: Cannot find module 'playwright'\n  at file:///app/scripts/screenshots/take-screenshots.ts:21:1"),
			Files:  []api.ArtifactFile{},
		},
		// Partial failure: the LEFT (before) side died, but the RIGHT (after) side
		// rendered, so the card stays "ready" and shows an amber warning plus the
		// surviving side's images (here surfacing as "added") instead of hiding
		// everything behind a whole-set error.
		{
			Name:      "dashboard",
			Status:    api.ArtifactSetStatusReady,
			Changed:   true,
			LeftError: ptr("exited 1: Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/dashboard\n  at /app/scripts/screenshots/take-screenshots.ts:88:14"),
			Files: []api.ArtifactFile{
				{
					Name:       "overview.png",
					ChangeType: api.ArtifactFileChangeTypeAdded,
					RightUrl:   ptr(simSVG("Overview (after)", "#15803d", 360, 220)),
				},
				{
					Name:       "metrics.png",
					ChangeType: api.ArtifactFileChangeTypeAdded,
					RightUrl:   ptr(simSVG("Metrics (after)", "#15803d", 240, 320)),
				},
			},
		},
		// Settled with no visual changes: collapses to a single header row, but is
		// still a card (expandable, refreshable). Its file is unchanged across sides.
		{
			Name:    "emails",
			Status:  api.ArtifactSetStatusReady,
			Changed: false,
			Files: []api.ArtifactFile{
				{
					Name:       "welcome.png",
					ChangeType: api.ArtifactFileChangeTypeUnchanged,
					LeftUrl:    ptr(simSVG("Welcome", "#334155", 360, 220)),
					RightUrl:   ptr(simSVG("Welcome", "#334155", 360, 220)),
				},
			},
		},
	}
}

// artTags returns a pointer to a tag slice for a simulated artifact file. The
// "theme::*" / "viewport::*" tags are scoped labels (one value per category),
// so the diff viewer renders them as single-select dropdowns; "new" is a plain
// free-form tag, rendered as a toggle chip.
func artTags(tags ...string) *[]string {
	s := append([]string{}, tags...)
	return &s
}

// simReadyChangedSet is the finished comparison with visual changes (including an
// added file with no "before", to document the missing-image placeholder). Its
// files carry scoped (theme/viewport) and free-form tags so the panel documents
// its tag badges and the tag filter.
func simReadyChangedSet() api.ArtifactSet {
	return api.ArtifactSet{
		Name:    "screenshots",
		Status:  api.ArtifactSetStatusReady,
		Changed: true,
		Files: []api.ArtifactFile{
			{
				Name:       "home.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::light", "viewport::desktop"),
				LeftUrl:    ptr(simSVG("Home (before)", "#b91c1c", 360, 220)),
				RightUrl:   ptr(simSVG("Home (after)", "#15803d", 360, 220)),
			},
			{
				Name:       "home-dark.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::dark", "viewport::desktop"),
				LeftUrl:    ptr(simSVG("Home dark (before)", "#7f1d1d", 360, 220)),
				RightUrl:   ptr(simSVG("Home dark (after)", "#166534", 360, 220)),
			},
			{
				Name:       "login-phone.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::light", "viewport::phone"),
				LeftUrl:    ptr(simSVG("Login (before)", "#b91c1c", 240, 480)),
				RightUrl:   ptr(simSVG("Login (after)", "#15803d", 240, 480)),
			},
			{
				Name:       "profile-phone-dark.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::dark", "viewport::phone"),
				LeftUrl:    ptr(simSVG("Profile (before)", "#7f1d1d", 240, 480)),
				RightUrl:   ptr(simSVG("Profile (after)", "#166534", 240, 480)),
			},
			{
				Name:       "settings-phone.png",
				ChangeType: api.ArtifactFileChangeTypeAdded,
				Tags:       artTags("theme::dark", "viewport::phone", "new"),
				RightUrl:   ptr(simSVG("Settings (new)", "#15803d", 240, 480)),
			},
			// A .webm artifact: the frontend routes it to the video diff viewer
			// (synchronized before/after playback + per-frame difference) rather
			// than the image one. Same before/after model as the images above.
			{
				Name:       "loader-animation.webm",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::dark", "viewport::desktop"),
				LeftUrl:    ptr(simWebM(simVideoBefore)),
				RightUrl:   ptr(simWebM(simVideoAfter)),
			},
			{
				Name:       "about.png",
				ChangeType: api.ArtifactFileChangeTypeUnchanged,
				Tags:       artTags("theme::light", "viewport::desktop"),
				LeftUrl:    ptr(simSVG("About", "#334155", 360, 220)),
				RightUrl:   ptr(simSVG("About", "#334155", 360, 220)),
			},
		},
	}
}

func (s *SimulationServer) GetAgentArtifacts(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentArtifactsParams) {
	api.WriteJSON(w, http.StatusOK, api.ArtifactsResponse{Scripts: simArtifactSets(id)})
}

func (s *SimulationServer) SendAgentInput(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusOK)
}

// simRepoOrder lists the simulated repository's tracked files in git's natural
// (lexical) order, so the browser renders a stable, GitHub-like tree.
var simRepoOrder = []string{
	".gitignore",
	".hydra/config.toml",
	"CLAUDE.md",
	"LICENSE",
	"README.md",
	"go.mod",
	"hydra.toml",
	"package.json",
	"server-link.go",
	"config/env/staging/region/eu/settings.toml",
	"internal/server/server.go",
	"internal/store/store.go",
	"web/public/logo.png",
	"web/src/App.tsx",
	"web/src/components/Button.tsx",
	"web/src/main.tsx",
}

// simRepoSymlinks maps a simulated symlink path to the repo-relative file it
// points at, so the repository browser's symlink support (the "→ target" header
// and rendering the pointed-to file) has something to demonstrate.
var simRepoSymlinks = map[string]string{
	"server-link.go": "internal/server/server.go",
}

// simRepoImage is the path of the one binary (image) file in the simulated repo,
// served as raw PNG bytes by the simulation blob handler so the repository
// browser's image preview (PLAN.md #41k) has something to render.
const simRepoImage = "web/public/logo.png"

// simLogoPNG is a small, deterministic PNG used as the simulated repo's binary
// image file. Kept as a fixed blob so screenshot artifacts stay byte-stable.
const simLogoPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAIAAABaGO0eAAAC10lEQVR42u3dzVHDQAwF4Bw5URYVUQi0QjdUQQmQgZkcQuz900pP78njY5JZ6wPi3ecVl+86Qo9LlaAACuD3+Hz5mjufX9/Wz6f3D5PTZDAO47EEWGdQq/4WgGkDwervAphg0Kz+XoB+BtnqewA0DZSr7wRwwiBefVeA/wxV/QCAm0FV/xDg+im7Da5nVf8M4O8EZyCofgMA2YCj+m0ATAaa6ncB3F4KwsBU/TbA3avDDciq3wA4ek8UA1/1zwCa73RmoKz+IUDnm90MWKt//agHAKOf4sBAnLUZAKRggF35MANANkBed7IEwGQAX/UzBvCcPHNkbZYA/gsYBFmbGcDR6KMYsuQNNgDNy3BmSJT2GAB0XoybQa6sbRVg9Koqa7MEmL68ytoMABZ/xCprWwKw+jtbWdsMgPm3nHLWNgyw6R5DNmsbA9h9hyeYtQ0AuN1fS2VtvQDOsxudrK0LIGpuqZC1tQHCZ/bcWVsDAGRdhThrOwNAW9WizNoOAWDXFMmytscA4Cu6TFlb19PRmKtaHFnbLgC3++vsWdsWAOfZTeqszR4gam6ZNGszBgif2afL2iwBQJ5hzpW1mQGgPUGeJWuzAYB9fh8/azMAAN89AZ61rQJk2bsCm7UtAaTbOQSYtc0DJN23hZa1TQJk3zWHs7I9A0CzZxGBYRiAbMdouMEYAOt+3UCGAQDi3dKBAUMvAH31owy6AESqH8Iw0C9IrSu3D8NYvyC1rtwOBjP9gtS6cscAVPV9GJb6Bal15XYCqOp7MuwCoO9MDA0g0hcaFECtKzcWgGxPdAgA8Y70wQD1/wDmGJz6Bal15XYFqOqvGHj3C6qszRKgqr+etYX1C6qsbQmgqm+VtUH0C1LO2lD6BclmbVj9ggSzNsR+QVJ3AaD9gnS+h6D7BSn8LiboF8Q9nhz9gojHk6lfEOV48vULIhtPyn5BTON5AFBHyFEABaB9/ACuVNk1U+d1vQAAAABJRU5ErkJggg=="

// simRepoFiles holds the simulated content for each path in simRepoOrder.
var simRepoFiles = map[string]string{
	".gitignore": "node_modules/\ndist/\n.env\n*.log\n.hydra/local/\n",
	// The project config. Its [[artifacts]] blocks are what the repository
	// browser's dynamic ".hydra/artifacts" folder lists (the names here match the
	// scripts GetRepositoryArtifacts returns below).
	".hydra/config.toml": "[[artifacts]]\nname = \"screenshots\"\ncommand = \"bun run screenshots.ts\"\ntimeout_sec = 900\n\n" +
		"[[artifacts]]\nname = \"components\"\ncommand = \"bun run storybook-shots.ts\"\n",
	"CLAUDE.md": "# Project guidelines\n\nThis demo repo powers Hydra's **Repository** view.\n\n- Use `bun` instead of `npm`.\n- Run the formatter before committing.\n",
	"LICENSE":    "MIT License\n\nCopyright (c) 2026 Hydra Demo\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction.\n",
	"hydra.toml": "pre_prompt = \"\"\"\n- Use bun instead of npm\n\"\"\"\n\n[sandbox]\nwritable_paths = [\"~/.cache/go-build\"]\n",
	// A deeply-nested single-child chain; each folder holds only the next, so the
	// tree compacts config/env/staging/region/eu onto one row (PLAN.md #41 compact
	// folders, like the diff viewer).
	"config/env/staging/region/eu/settings.toml": "[region]\nname = \"eu\"\nenv = \"staging\"\n\n[limits]\nmax_requests = 1000\ntimeout_sec = 30\n",
	"README.md": "# Hydra Demo\n\nA simulated repository powering the **Repository** view.\n\n" +
		"This page is a lightweight, GitHub-style browser: pick a file or folder\n" +
		"on the left, read it on the right. By default it opens `README.md`.\n\n" +
		"## Features\n\n" +
		"- Collapsible file & folder tree\n" +
		"- Syntax-highlighted file contents\n" +
		"- Markdown rendering for `README` files\n\n" +
		"## Getting started\n\n" +
		"```sh\nbun install\nbun run dev\n```\n\n" +
		"Enjoy exploring the tree!\n",
	"go.mod": "module github.com/example/hydra-demo\n\ngo 1.26\n",
	"package.json": "{\n  \"name\": \"hydra-demo\",\n  \"version\": \"1.0.0\",\n" +
		"  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"vite build\"\n  }\n}\n",
	"internal/server/server.go": "package server\n\nimport \"net/http\"\n\n" +
		"// New returns the demo HTTP handler.\nfunc New() http.Handler {\n" +
		"\tmux := http.NewServeMux()\n\tmux.HandleFunc(\"/\", func(w http.ResponseWriter, r *http.Request) {\n" +
		"\t\tw.Write([]byte(\"hello from hydra-demo\"))\n\t})\n\treturn mux\n}\n",
	"internal/store/store.go": "package store\n\n// Store is an in-memory key/value store.\n" +
		"type Store struct {\n\tdata map[string]string\n}\n\n" +
		"func New() *Store {\n\treturn &Store{data: map[string]string{}}\n}\n",
	"web/src/App.tsx": "export function App() {\n  return <h1>Hydra Demo</h1>\n}\n",
	"web/src/components/Button.tsx": "export function Button({ label }: { label: string }) {\n" +
		"  return <button className=\"btn\">{label}</button>\n}\n",
	"web/src/main.tsx": "import { createRoot } from 'react-dom/client'\n" +
		"import { App } from './App'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n",
}

func (s *SimulationServer) GetRepositoryTree(w http.ResponseWriter, r *http.Request, projectId string, params api.GetRepositoryTreeParams) {
	ref := "HEAD"
	if params.Ref != nil && *params.Ref != "" {
		ref = *params.Ref
	}
	defaultPath := "README.md"
	files := append([]string(nil), simRepoOrder...)
	api.WriteJSON(w, http.StatusOK, api.RepositoryTreeResponse{
		Ref:         ref,
		Files:       files,
		DefaultPath: &defaultPath,
	})
}

func (s *SimulationServer) GetRepositoryBranches(w http.ResponseWriter, r *http.Request, projectId string) {
	api.WriteJSON(w, http.StatusOK, api.RepositoryBranchesResponse{
		Current: "main",
		Branches: []api.RepositoryBranch{
			{Name: "hydra/add-line-numbers", IsAgent: true, IsCurrent: false},
			{Name: "hydra/branch-selector", IsAgent: true, IsCurrent: false},
			{Name: "main", IsAgent: false, IsCurrent: true},
			{Name: "release", IsAgent: false, IsCurrent: false},
		},
	})
}

func (s *SimulationServer) GetRepositoryFile(w http.ResponseWriter, r *http.Request, projectId string, params api.GetRepositoryFileParams) {
	ref := "HEAD"
	if params.Ref != nil && *params.Ref != "" {
		ref = *params.Ref
	}
	if target, ok := simRepoSymlinks[params.Path]; ok {
		// A symlink: report it as such and serve the target file's content, so the
		// browser renders the pointed-to file with a "→ target" header.
		content := simRepoFiles[target]
		api.WriteJSON(w, http.StatusOK, api.RepositoryFileResponse{
			Path:          params.Path,
			Ref:           ref,
			Size:          len(content),
			Binary:        false,
			Symlink:       true,
			SymlinkTarget: &target,
			TargetPath:    &target,
			Content:       &content,
		})
		return
	}
	if params.Path == simRepoImage {
		// Binary image: report it as binary with a size but no inline content, so
		// the browser fetches it via the blob route and renders <img>.
		png, _ := base64.StdEncoding.DecodeString(simLogoPNGBase64)
		api.WriteJSON(w, http.StatusOK, api.RepositoryFileResponse{
			Path:   params.Path,
			Ref:    ref,
			Size:   len(png),
			Binary: true,
		})
		return
	}
	content, ok := simRepoFiles[params.Path]
	if !ok {
		api.WriteError(w, http.StatusNotFound, "file not found: "+params.Path)
		return
	}
	api.WriteJSON(w, http.StatusOK, api.RepositoryFileResponse{
		Path:    params.Path,
		Ref:     ref,
		Size:    len(content),
		Binary:  false,
		Content: &content,
	})
}

// HandleRepositoryBlob serves the simulated repo's binary image as raw PNG bytes.
func (s *SimulationServer) HandleRepositoryBlob(w http.ResponseWriter, r *http.Request) {
	if strings.TrimPrefix(path.Clean(r.URL.Query().Get("path")), "/") != simRepoImage {
		http.NotFound(w, r)
		return
	}
	png, err := base64.StdEncoding.DecodeString(simLogoPNGBase64)
	if err != nil {
		http.Error(w, "decode error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(png)
}

// GetRepositoryArtifacts lists the artifact scripts the simulated repo declares in
// .hydra/config.toml, so the repository browser shows its dynamic
// ".hydra/artifacts" folder with these entries.
func (s *SimulationServer) GetRepositoryArtifacts(w http.ResponseWriter, r *http.Request, projectId string, params api.GetRepositoryArtifactsParams) {
	ref := "HEAD"
	if params.Ref != nil && *params.Ref != "" {
		ref = *params.Ref
	}
	api.WriteJSON(w, http.StatusOK, api.RepositoryArtifactsResponse{
		Ref: ref,
		Scripts: []api.RepositoryArtifactScript{
			{Name: "screenshots"},
			{Name: "components"},
		},
	})
}

// GetRepositoryArtifact returns a single-sided artifact set for the simulated repo.
// "screenshots" renders a few inline-SVG images (mixing desktop + phone shapes to
// show off the flex-wrap layout); "components" demonstrates the in-flight
// generating state; any other name is a 404.
func (s *SimulationServer) GetRepositoryArtifact(w http.ResponseWriter, r *http.Request, projectId string, name string, params api.GetRepositoryArtifactParams) {
	logURL := "/artifacts/projects/" + projectId + "/log?script=" + name + "&key=commit/a1b2c3d"
	switch name {
	case "screenshots":
		api.WriteJSON(w, http.StatusOK, api.RepositoryArtifactResponse{
			Name:   "screenshots",
			Status: api.RepositoryArtifactResponseStatusReady,
			LogUrl: &logURL,
			Files: []api.RepositoryArtifactFile{
				{Name: "home.png", Url: ptr(simSVG("home", "#15803d", 360, 220)), Tags: artTags("theme::light", "viewport::desktop")},
				{Name: "home-dark.png", Url: ptr(simSVG("home dark", "#166534", 360, 220)), Tags: artTags("theme::dark", "viewport::desktop")},
				{Name: "login-phone.png", Url: ptr(simSVG("login", "#1d4ed8", 150, 300)), Tags: artTags("theme::light", "viewport::phone")},
			},
		})
	case "components":
		startedAt := simNow().Add(-6 * time.Second).Unix()
		progress := "rendering Button.stories 3/8"
		log := simArtifactLog()
		api.WriteJSON(w, http.StatusOK, api.RepositoryArtifactResponse{
			Name:      "components",
			Status:    api.RepositoryArtifactResponseStatusGenerating,
			StartedAt: &startedAt,
			Progress:  &progress,
			Log:       &log,
			Files:     []api.RepositoryArtifactFile{},
		})
	default:
		api.WriteError(w, http.StatusNotFound, "artifact script not found: "+name)
	}
}

func (s *SimulationServer) GetConfig(w http.ResponseWriter, r *http.Request, projectId string, params api.GetConfigParams) {
	resp := api.ConfigResponse{
		Defaults: api.AgentConfig{
			PrePrompt: ptr("Default pre-prompt"),
		},
		Agents: map[string]api.AgentConfig{
			"claude": {
				PrePrompt: ptr("Claude pre-prompt"),
			},
		},
	}
	// Seed a multi-line pre-spawn script so the settings screenshot exercises
	// the ShellEditor's bash highlighting and line-number gutter. Only the
	// project scope carries it; the user scope (fetched as the *inherited*
	// config when editing the project) leaves it empty, matching a realistic
	// setup where a project overrides the global default — so the editor isn't
	// shadowed by a redundant "Inherited:" echo of its own value.
	if params.Scope == nil || *params.Scope != api.GetConfigParamsScopeUser {
		resp.Defaults.Sandbox = &api.SandboxConfig{
			PreSpawnScript: ptr("#!/bin/bash\nset -euo pipefail\ncp -r \"$HYDRA_PROJECT_ROOT/pipeline/out\" \"$HYDRA_WORKTREE/pipeline/out\"\n"),
			PreExitScript:  ptr("source \"$HYDRA_WORKTREE/.hydra/emu.env\" 2>/dev/null && scripts/emu-claim-slot.sh release\n"),
		}
		resp.Artifacts = &[]api.ArtifactScript{
			{Name: "screenshots", Command: "bun run screenshots.ts", TimeoutSec: ptr(900)},
		}
		resp.Services = &[]api.ServiceScript{
			{Name: "emu-pool", Command: "scripts/emu-pool.sh up 3 --foreground", Host: ptr(true), MaxRestarts: ptr(3)},
		}
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) SaveConfig(w http.ResponseWriter, r *http.Request, projectId string, params api.SaveConfigParams) {
	w.WriteHeader(http.StatusOK)
}

func (s *SimulationServer) GetServices(w http.ResponseWriter, r *http.Request, projectId string) {
	// mobile-app's emulator pool has crashed out (exhausted restarts) — drives the
	// failed-service badge and the top-bar warning indicator in the screenshots.
	// Every other project's pool is healthy.
	if projectId == "mobile-app" {
		api.WriteJSON(w, http.StatusOK, api.ServiceStatusResponse{
			Services: []api.ServiceStatus{
				{Name: "emu-pool", Command: "scripts/emu-pool.sh up 3 --foreground", Host: true, State: api.Failed, Restarts: 3, MaxRestarts: 3, Pid: ptr(0),
					Message: ptr("exit status 1 (last output: emulator: ERROR: x86_64 emulation requires hardware acceleration — /dev/kvm not found)")},
			},
		})
		return
	}
	api.WriteJSON(w, http.StatusOK, api.ServiceStatusResponse{
		Services: []api.ServiceStatus{
			{Name: "emu-pool", Command: "scripts/emu-pool.sh up 3 --foreground", Host: true, State: api.Up, Restarts: 0, MaxRestarts: 3, Pid: ptr(40123)},
		},
	})
}

func (s *SimulationServer) RestartServices(w http.ResponseWriter, r *http.Request, projectId string) {
	s.GetServices(w, r, projectId)
}

func (s *SimulationServer) DevRestart(w http.ResponseWriter, r *http.Request) {
	api.WriteError(w, http.StatusForbidden, "Not available in simulation mode")
}

func (s *SimulationServer) GetDevToolsConfig(w http.ResponseWriter, r *http.Request) {
	if !s.Development {
		api.WriteError(w, http.StatusForbidden, "not in dev mode")
		return
	}

	root := "/simulated/project"
	uuid := "sim-uuid-1"

	api.WriteJSON(w, http.StatusOK, struct {
		Workspace *struct {
			Root *string `json:"root,omitempty"`
			Uuid *string `json:"uuid,omitempty"`
		} `json:"workspace,omitempty"`
	}{
		Workspace: &struct {
			Root *string `json:"root,omitempty"`
			Uuid *string `json:"uuid,omitempty"`
		}{
			Root: &root,
			Uuid: &uuid,
		},
	})
}

// HandleTerminalWS handles WebSocket connections for simulated agent terminal access.
func (s *SimulationServer) HandleTerminalWS(w http.ResponseWriter, r *http.Request) {
	// Extract agent ID from path: /ws/projects/{project_id}/agents/{id}/terminal
	agentID := r.PathValue("id")

	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	// 1. Simulate sandbox startup. Emit the whole boot transcript in one burst
	// rather than pacing it with sleeps: the screenshot generator captures this
	// terminal, and a wall-clock-paced stream means a capture catches a
	// nondeterministic number of "Step N/3" lines depending on how long its
	// navigate+settle happened to take — which shows up as a spurious diff
	// between the before/after renders. Writing every line up front makes the
	// captured terminal a fixed, complete transcript.
	sendStatusUpdate(conn, "building")
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32m[Simulation] Starting agent "+agentID+"...\x1b[0m\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 1/3: Creating git worktree...\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 2/3: Preparing sandbox...\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 3/3: Launching agent session...\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32mSimulated agent ready.\x1b[0m\r\n\r\n"))

	// 2. Transition to Running
	sendStatusUpdate(conn, "running")
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("agent@hydra-sim:~$ \x1b[?25h"))

	// 3. Simulate interactive session (echo what user types)
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if msgType == websocket.BinaryMessage {
			// Echo back with a slight modification to show it's a simulation
			if string(data) == "\r" {
				_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\r\nagent@hydra-sim:~$ "))
			} else {
				_ = conn.WriteMessage(websocket.BinaryMessage, data)
			}
		}
	}
}

// HandleEventsWS mirrors the real server's events stream. Simulation data is
// static, so it just sends the one-time "refetch everything" nudge on connect and
// then holds the connection open (ignoring client messages) until the peer
// closes — enough for the client to do its initial load without a reconnect loop.
func (s *SimulationServer) HandleEventsWS(w http.ResponseWriter, r *http.Request) {
	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	for _, t := range []string{"agents_changed", "projects_changed", "services_changed"} {
		if err := conn.WriteJSON(eventMsg{Type: t}); err != nil {
			return
		}
	}
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// HandleArtifactsWS streams the mock artifact sets over a WebSocket, mirroring
// the real server's endpoint. It sends one snapshot (the simulated states,
// including the in-flight set's live log) and then keeps the connection open,
// ignoring client messages, until the peer closes it.
func (s *SimulationServer) HandleArtifactsWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	msg := artifactWSMessage{Type: "snapshot", Scripts: simArtifactSets(id)}
	data, _ := json.Marshal(msg)
	_ = conn.WriteMessage(websocket.TextMessage, data)

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// expandHunkContext adds extra context lines before/after a hunk's existing lines
// when the requested context is greater than the default 3.
// expandHunkContext pads a hunk with up to extraCtx synthetic context lines on
// each side. The prefix stops at line 1 and the suffix stops at the file's known
// extent (fileLastOld/fileLastNew — the largest line numbers across the file's
// real hunks), so a full-context request (git diff -U<huge> in production)
// returns the complete short fixture rather than an unbounded fabricated tail.
func expandHunkContext(hunk api.DiffHunk, extraCtx, fileLastOld, fileLastNew int, fileExt string) api.DiffHunk {
	if extraCtx <= 0 {
		return hunk
	}

	comment := "//"
	if fileExt == "tsx" || fileExt == "ts" || fileExt == "js" || fileExt == "jsx" {
		comment = "//"
	}

	// Find the old/new line ranges in the hunk
	firstOld, firstNew := hunk.OldStart, hunk.NewStart
	lastOld, lastNew := firstOld, firstNew
	for _, l := range hunk.Lines {
		if l.OldLineNum != nil && *l.OldLineNum > lastOld {
			lastOld = *l.OldLineNum
		}
		if l.NewLineNum != nil && *l.NewLineNum > lastNew {
			lastNew = *l.NewLineNum
		}
	}

	// Prepend context lines before the hunk
	var prefix []api.DiffLine
	for i := extraCtx; i > 0; i-- {
		oldN := firstOld - i
		newN := firstNew - i
		if oldN < 1 || newN < 1 {
			continue
		}
		prefix = append(prefix, api.DiffLine{
			Type:       api.Context,
			Content:    comment + fmt.Sprintf(" context line %d", oldN),
			OldLineNum: ptr(oldN),
			NewLineNum: ptr(newN),
		})
	}

	// Append context lines after the hunk, stopping at the file's last line so
	// we never fabricate content past the (short) fixture's real end.
	var suffix []api.DiffLine
	for i := 1; i <= extraCtx; i++ {
		oldN := lastOld + i
		newN := lastNew + i
		if oldN > fileLastOld || newN > fileLastNew {
			break
		}
		suffix = append(suffix, api.DiffLine{
			Type:       api.Context,
			Content:    comment + fmt.Sprintf(" context line %d", oldN),
			OldLineNum: ptr(oldN),
			NewLineNum: ptr(newN),
		})
	}

	newLines := append(prefix, hunk.Lines...)
	newLines = append(newLines, suffix...)
	hunk.Lines = newLines
	return hunk
}

func expandDiffContext(files []api.DiffFile, context int) []api.DiffFile {
	extra := context - 3
	if extra <= 0 {
		return files
	}
	result := make([]api.DiffFile, len(files))
	for i, f := range files {
		ext := ""
		parts := strings.Split(f.Path, ".")
		if len(parts) > 1 {
			ext = parts[len(parts)-1]
		}
		// The file's real extent: the largest old/new line numbers across its
		// hunks. Synthetic suffix context stops here so we don't fabricate lines
		// past the fixture's end (which would make every file look 1000 lines
		// long under a full-context request).
		lastOld, lastNew := 0, 0
		for _, h := range f.Hunks {
			for _, l := range h.Lines {
				if l.OldLineNum != nil && *l.OldLineNum > lastOld {
					lastOld = *l.OldLineNum
				}
				if l.NewLineNum != nil && *l.NewLineNum > lastNew {
					lastNew = *l.NewLineNum
				}
			}
		}
		hunks := make([]api.DiffHunk, len(f.Hunks))
		for j, h := range f.Hunks {
			hunks[j] = expandHunkContext(h, extra, lastOld, lastNew, ext)
		}
		f.Hunks = hunks
		result[i] = f
	}
	return result
}

func ptr[T any](v T) *T {
	return &v
}

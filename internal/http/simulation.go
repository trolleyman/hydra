package http

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/forge"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/projects"
	"github.com/trolleyman/hydra/internal/selfupdate"
)

// simAgentByID returns a minimal fixture AgentResponse for the given id, used by
// the review/publish simulation handlers that echo an updated agent.
func simAgentByID(id string) api.AgentResponse {
	createdAt := simNow().Add(-1 * time.Hour).Unix()
	return api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindWorktree,
		Id:            id,
		Title:         ptr("Simulated agent " + id),
		AgentType:     "claude",
		BaseBranch:    "main",
		BranchName:    ptr("hydra/" + id),
		SessionStatus: "running",
		CreatedAt:     &createdAt,
		AgentStatus:   &api.AgentStatusInfo{Status: api.Finished, Timestamp: simNow().Format(time.RFC3339)},
	}
}

// SimulationServer implements api.ServerInterface with mock data.
type SimulationServer struct {
	Development                    bool
	projectDirectoryMu             sync.Mutex
	projectDirectory               map[string]simProjectDirectoryPermissions
	projectDirectoryCheckoutBranch string

	// updateMu and friends back the simulated self-update job (see UpdateServer),
	// so the update panel - phases, streaming build log, the failure path - can
	// be driven and screenshotted without a real build.
	updateMu      sync.Mutex
	updateRunning bool
	updateRuns    int
	updateHistory []selfupdate.Event
	updateSubs    map[chan selfupdate.Event]struct{}

	// previewMu/previewPolls back the mock previews endpoints: a started
	// instance advances starting -> running by counting status polls, so the
	// panel is drivable deterministically (no wall clock - see simNow).
	previewMu    sync.Mutex
	previewPolls map[string]int

	// approvalMu/approvalKind/approvalGen back the approval picker (the
	// agent-approvals head): answering its question card parks one kind of
	// security-gate approval, which the normal endpoints then serve exactly like
	// a real one. approvalGen bumps on every change so the events stream can nudge
	// the client to refetch. Empty kind = nothing parked, which is the state every
	// other page (and every screenshot) sees.
	approvalMu   sync.Mutex
	approvalKind string
	approvalGen  int

	// hiddenMu/hiddenProjects back SetProjectHidden: simulation serves a fixed
	// project list, so a hide is kept here for the life of the process instead of
	// being persisted. That is enough to drive the whole flow (hide in edit mode
	// -> the row leaves the list -> show it again) against the real endpoint.
	// Nothing is hidden at boot, so every other page and screenshot is unchanged.
	projectListMu   sync.Mutex
	hiddenProjects  map[string]bool
	renamedProjects map[string]string

	// askRunning is true while agent-ask's answered turn is streaming. The chat's
	// live "working" indicator keys off the AGENT RECORD's status (the store's
	// list), not the WS status frame, so a fixture pinned to needs_input can
	// never show it - even mid-stream. Flipping this makes ListAgents/GetAgent
	// report `running` for exactly as long as the turn is in flight.
	askRunning atomic.Bool
}

type simProjectDirectoryPermissions struct {
	mode         api.ProjectDirectoryFilesystemMode
	allowCommits bool
}

// setSimHidden records a project as hidden (or shown again) for this process.
func (s *SimulationServer) setSimHidden(id string, hidden bool) {
	s.projectListMu.Lock()
	defer s.projectListMu.Unlock()
	if s.hiddenProjects == nil {
		s.hiddenProjects = map[string]bool{}
	}
	s.hiddenProjects[id] = hidden
}

// simHidden reports whether a project has been hidden this session.
func (s *SimulationServer) simHidden(id string) bool {
	s.projectListMu.Lock()
	defer s.projectListMu.Unlock()
	return s.hiddenProjects[id]
}

func (s *SimulationServer) setSimName(id, name string) {
	s.projectListMu.Lock()
	defer s.projectListMu.Unlock()
	if s.renamedProjects == nil {
		s.renamedProjects = map[string]string{}
	}
	s.renamedProjects[id] = name
}

func (s *SimulationServer) simName(id, fallback string) string {
	s.projectListMu.Lock()
	defer s.projectListMu.Unlock()
	if name := s.renamedProjects[id]; name != "" {
		return name
	}
	return fallback
}

// setSimApproval parks (or with "" clears) the picked approval kind.
func (s *SimulationServer) setSimApproval(kind string) {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	s.approvalKind = kind
	s.approvalGen++
}

// simApproval reports the parked kind and the current generation.
func (s *SimulationServer) simApproval() (string, int) {
	s.approvalMu.Lock()
	defer s.approvalMu.Unlock()
	return s.approvalKind, s.approvalGen
}

// simNow is the fixed wall-clock instant ALL time-derived simulation values are
// computed from, instead of time.Now(). The diff viewer renders the two sides of
// a comparison in separate server boots and hashes the resulting screenshots, so
// any value that moves with the real clock (an agent's "spawned X ago", the
// artifacts panel's elapsed timer) would make otherwise-identical renders differ
// and show up as a spurious visual change. Pinning the server's clock - together
// with the screenshot script pinning the browser's clock to the SAME instant
// (web/scripts/screenshots/take-screenshots.ts, page.clock) - makes every duration
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
	commit := "0123456789abcdef0123456789abcdef01234567"
	databaseDirectory := "/home/sim/.local/state/hydra"
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
	runtimeOS := "linux"
	development := s.Development
	// The simulated server offers both controls so the update panel is drivable
	// here; neither actually replaces this process (see UpdateServer).
	canRestart := true
	canUpdate := true

	api.WriteJSON(w, http.StatusOK, api.StatusResponse{
		Status:            &status,
		Version:           &v,
		GitCommit:         &commit,
		DatabaseDirectory: &databaseDirectory,
		UptimeSeconds:     &uptime,
		ProjectRoot:       &projectRoot,
		DefaultProjectId:  &defaultProjectID,
		RuntimeOs:         &runtimeOS,
		Development:       &development,
		CanRestart:        &canRestart,
		CanUpdate:         &canUpdate,
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

func (s *SimulationServer) GetCodexUsage(w http.ResponseWriter, r *http.Request, params api.GetCodexUsageParams) {
	available := true
	session := float32(38)
	weekly := float32(65)
	sessionText := "5h"
	weeklyText := "week"
	api.WriteJSON(w, http.StatusOK, api.CodexUsageResponse{
		Available:          available,
		SessionPercentUsed: &session,
		SessionResetText:   &sessionText,
		WeeklyPercentUsed:  &weekly,
		WeeklyResetText:    &weeklyText,
	})
}

func (s *SimulationServer) ListProjects(w http.ResponseWriter, r *http.Request) {
	simUnread := 1             // matches the one unread agent in ListAgents
	simNeedsInput := 1         // matches the one needs_input agent in ListAgents
	otherUnread := 3           // updates waiting in a project you're not looking at
	otherNeedsInput := 1       // one of those is blocked on you → red dot elsewhere
	simIcon := "🚀"             // emoji icon
	mobileIcon := "Smartphone" // lucide icon name
	// Per-project agent tallies for the switcher (total = sum of the breakdown,
	// including the needs_input count above).
	simTotal, simRunning, simWaiting, simFinished := 5, 2, 1, 1
	otherTotal, otherRunning, otherWaiting, otherFinished := 4, 1, 1, 1
	simDisplayPath := "~/code/simulated/project"
	mobileDisplayPath := "~/code/some/quite/deeply/nested/dir/mobile-app"
	// The built-in chat project (docs/chat-project.md). Deliberately listed
	// *last* so the dropdown's pin-to-top sort is actually exercised rather than
	// accidentally satisfied by server order.
	chatBuiltin := true
	chatIcon := "MessageSquare"
	chatDisplayPath := "~/.local/share/hydra/chat"
	chatTotal, chatRunning, chatWaiting, chatFinished := 2, 0, 1, 1
	chatUnread, chatNeedsInput := 0, 0
	resp := api.ListProjects200JSONResponse{
		{
			Id:              "sim-project",
			Path:            "/simulated/project",
			DisplayPath:     &simDisplayPath,
			Name:            "simulated-project",
			Icon:            &simIcon,
			UnreadCount:     &simUnread,
			NeedsInputCount: &simNeedsInput,
			AgentCount:      &simTotal,
			RunningCount:    &simRunning,
			WaitingCount:    &simWaiting,
			FinishedCount:   &simFinished,
		},
		{
			Id:              "mobile-app",
			Path:            "/simulated/mobile-app",
			DisplayPath:     &mobileDisplayPath,
			Name:            "mobile-app",
			Icon:            &mobileIcon,
			UnreadCount:     &otherUnread,
			NeedsInputCount: &otherNeedsInput,
			AgentCount:      &otherTotal,
			RunningCount:    &otherRunning,
			WaitingCount:    &otherWaiting,
			FinishedCount:   &otherFinished,
		},
		{
			Id:              projects.ChatProjectID,
			Path:            "/home/sim/.local/share/hydra/chat",
			DisplayPath:     &chatDisplayPath,
			Name:            projects.ChatProjectName,
			Builtin:         &chatBuiltin,
			Icon:            &chatIcon,
			UnreadCount:     &chatUnread,
			NeedsInputCount: &chatNeedsInput,
			AgentCount:      &chatTotal,
			RunningCount:    &chatRunning,
			WaitingCount:    &chatWaiting,
			FinishedCount:   &chatFinished,
		},
	}
	// Reflect any hide made this session (see hiddenProjects). Each entry needs
	// its own bool - the response holds pointers.
	for i := range resp {
		hidden := s.simHidden(resp[i].Id)
		resp[i].Hidden = &hidden
		resp[i].Name = s.simName(resp[i].Id, resp[i].Name)
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

// ReorderProjects accepts and discards the new order: simulation serves a fixed
// project list, so persisting it would have nothing to persist into. Answering
// 204 still lets the dropdown's drag-to-reorder be exercised end to end (the
// client keeps its own optimistic order until the server disagrees).
func (s *SimulationServer) ReorderProjects(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusNoContent)
}

// RenameProject keeps the label in memory so the simulation exercises the same
// refetch-driven rename flow as the real server.
func (s *SimulationServer) RenameProject(w http.ResponseWriter, r *http.Request, projectId string) {
	var body api.RenameProjectRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		api.WriteError(w, http.StatusBadRequest, "project name is required")
		return
	}
	if projectId == projects.ChatProjectID {
		api.WriteError(w, http.StatusBadRequest, "built-in projects cannot be renamed")
		return
	}
	s.setSimName(projectId, strings.TrimSpace(body.Name))
	w.WriteHeader(http.StatusNoContent)
}

// SetProjectHidden records the hide in memory (see hiddenProjects) and answers
// 204, so the dropdown's edit-list visibility toggle works end to end against
// the simulation server.
func (s *SimulationServer) SetProjectHidden(w http.ResponseWriter, r *http.Request, projectId string) {
	var body api.SetProjectHiddenRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		api.WriteError(w, http.StatusBadRequest, "hidden is required")
		return
	}
	s.setSimHidden(projectId, body.Hidden)
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) SetProjectIcon(w http.ResponseWriter, r *http.Request, projectId string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) AddProject(w http.ResponseWriter, r *http.Request) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) GetProjectConfigToml(w http.ResponseWriter, r *http.Request, projectId string) {
	api.WriteJSON(w, http.StatusOK, api.ConfigTomlResponse{Content: "", Exists: false})
}

func (s *SimulationServer) PreviewConfigToml(w http.ResponseWriter, r *http.Request, params api.PreviewConfigTomlParams) {
	api.WriteJSON(w, http.StatusOK, api.ConfigTomlResponse{Content: "", Exists: false})
}

// ResolvePath answers for real (unlike AddProject) - it only reads path
// metadata, and the add-project input's live "this is where that lands" hint is
// worth exercising against the actual filesystem.
func (s *SimulationServer) ResolvePath(w http.ResponseWriter, r *http.Request, params api.ResolvePathParams) {
	resolved := resolveProjectPath(params.Path)
	if resolved == "" {
		api.WriteError(w, http.StatusBadRequest, "path is required")
		return
	}
	resp := api.ResolvedPathResponse{Path: resolved, DisplayPath: *displayPathPtr(resolved)}
	if st, err := os.Stat(resolved); err == nil {
		resp.Exists = true
		resp.IsDir = st.IsDir()
	}
	if root, err := paths.GetProjectRoot(resolved); err == nil {
		resp.IsGitRepo = true
		resp.RepoRoot = &root
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) RemoveProject(w http.ResponseWriter, r *http.Request, projectId string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) EnsureTrackRemote(w http.ResponseWriter, r *http.Request, projectId string, params api.EnsureTrackRemoteParams) {
	api.WriteJSON(w, http.StatusOK, api.TrackRemoteResponse{Remote: "hydra-agents", LocalBranchExists: false})
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
// "$ ..." run that must stay ordinary code in a prompt (the $-command override is
// activity-only). It is also long enough to overflow the detail PromptBlock's
// max height so the bottom-fade-on-scroll is visible.
const simAgentMdPrompt = "Add **simple inline-markdown** rendering so prompts and the live-activity line aren't flat text.\n\n" +
	"- In the spawn box and this detail view, highlight `inline code`, *italic* and **bold** runs - but leave #headings alone.\n" +
	"- Reuse the same pass for the live-activity line; when an activity begins with a `$`, render the whole line as a command (e.g. a build or test invocation), overriding markdown - but do that *only* for activity, never for a prompt.\n" +
	"- A long inline-code reference such as `web/src/components/AgentComponents.tsx` must wrap across lines cleanly, and a line that contains `code` must stay exactly as tall as a `plain` one.\n" +
	"- A long command in backticks like `go test ./internal/heads/... -run TestResumeLazy -count=1 -race -v` should wrap mid-span, with each line fragment keeping its own rounded code background.\n" +
	"- Proof the override is activity-only: this literal `$ run-this-command --now` sitting inside the prompt should stay ordinary code, not a highlighted command line.\n" +
	"- Tighten the gap between the metadata above and this box, and add a soft bottom fade so a tall prompt doesn't cut off hard as it scrolls out of view.\n" +
	"- A fenced block must render as its own code chip in both the spawn box and this detail view, e.g.\n" +
	"```ts\nconst seg = parseInline(text)\nrenderMarkdown(seg) // code/bold/italic\n```\n" +
	"- Keep it dependency-free: a tiny hand-rolled tokenizer beats pulling in a whole markdown library just for `code`, *italic* and **bold**.\n" +
	"- Finally, share one renderer across the spawn box, the agent-detail prompt and the sidebar activity line so the three never drift apart."

// simAgent2Prompt is agent-2's seeded prompt. It opens with task text, then
// lists upload paths the way the spawn form appends them - three images and one
// non-image (.pdf) - so the agent-2 detail page's PromptBlock renders them as
// attachment chips (image thumbnails + a generic icon) instead of raw links.
// agent-2 already sits in ListAgents, so its detail page renders straight from
// the store (no one-shot getAgent, which never resolves in simulation), and no
// other shot captures its detail view - so adding this prompt is churn-free. See
// take-screenshots.ts agent-prompt-attachments, which serves the thumbnails a
// fixed image so they render deterministically.
const simAgent2Prompt = "Migrate the auth providers to OAuth 2.0 with PKCE. Match the attached sign-in mockups (light + dark) and the error states; the full provider list is in the spec PDF.\n\n" +
	"/home/you/acme/.hydra/local/projects/sim-project/uploads/1782072241514128486-signin-light.png\n" +
	"/home/you/acme/.hydra/local/projects/sim-project/uploads/1782072347433312262-signin-dark.png\n" +
	"/home/you/acme/.hydra/local/projects/sim-project/uploads/1782072458377091686-error-states.png\n" +
	"/home/you/acme/.hydra/local/projects/sim-project/uploads/1782072717310298418-oauth-providers.pdf"

// simAgentChatPrompt seeds the chat-mode demo agent (agent-chat), whose detail
// page renders the chat view instead of a terminal.
const simAgentChatPrompt = "Add a retry with exponential backoff to the artifact uploader, and cover the giving-up path with a test."

const simAgentCodexPrompt = "Exercise Codex chat tools, file edits, and a sub-agent, then report the result."

// simAgentChat is the chat-mode demo agent, shared by ListAgents and GetAgent.
func simAgentChat() api.AgentResponse {
	createdAt := simNow().Add(-45 * time.Minute).Unix()
	return api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindWorktree,
		Id:            "agent-chat",
		Title:         ptr("Add uploader retry with backoff"),
		AgentType:     "claude",
		BaseBranch:    "main",
		BranchName:    ptr("hydra/feat-uploader-retry"),
		SessionPid:    1006,
		SessionStatus: "running",
		CreatedAt:     &createdAt,
		Prompt:        simAgentChatPrompt,
		ChatMode:      ptr(true),
		// A worktree path so the chat can trim it out of the commands the agent
		// runs (an agent opens half its scripts with `cd <the worktree>`).
		WorktreePath: ptr("/repo/.hydra/local/worktrees/feat-uploader-retry"),
		// Model as the daemon would have captured it from the head's system:init
		// line (see simChatEvents); the chat selector seeds its label from this.
		Model: ptr("claude-opus-4-8"),
		AgentStatus: &api.AgentStatusInfo{
			Status:    api.Waiting,
			Timestamp: simNow().Format(time.RFC3339),
		},
	}
}

// simAgentCodex is the provider-neutral chat-event demo. Keeping it separate
// from agent-chat means the simulation exercises both the legacy Claude input
// adapter and the normalized Codex replay path in a real rendered page.
func simAgentCodex() api.AgentResponse {
	createdAt := simNow().Add(-40 * time.Minute).Unix()
	return api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindWorktree,
		Id:            "agent-chat-codex", Title: ptr("Exercise Codex chat events"), AgentType: "codex",
		BaseBranch: "main", BranchName: ptr("hydra/sim-codex-chat"), SessionPid: 1007,
		SessionStatus: "running", CreatedAt: &createdAt, Prompt: simAgentCodexPrompt,
		ChatMode: ptr(true), Model: ptr(""),
		AgentStatus: &api.AgentStatusInfo{Status: api.Finished, Timestamp: simNow().Format(time.RFC3339)},
	}
}

// simProjectDirectoryAgents exercise the shared branchless chat surface without needing
// a real provider process or project checkout. Each reuses one of the existing
// durable chat streams so the transcript remains as rich as the ordinary chat
// fixtures while the surrounding layout and permissions are project-directory-specific.
func simProjectDirectoryAgents() []api.AgentResponse {
	chatMode := true
	allowCommits := true
	disallowCommits := false
	edit := api.ProjectDirectoryFilesystemEdit
	readonly := api.ProjectDirectoryFilesystemReadonly
	createdEdit := simNow().Add(-14 * time.Minute).Unix()
	createdReadonly := simNow().Add(-38 * time.Minute).Unix()
	createdWorking := simNow().Add(-3 * time.Minute).Unix()
	return []api.AgentResponse{
		{
			Id: "project-directory-edit", Title: ptr("Tidy the release notes"), AgentType: "claude",
			BranchName: nil, SessionPid: 1010, SessionStatus: "running", CreatedAt: &createdEdit,
			ProjectPath: "/Users/callum/code/hydra", BaseBranch: "main", Prompt: simAgentChatPrompt, ChatMode: &chatMode,
			WorkspaceKind: api.WorkspaceKindProjectDirectory, FilesystemMode: &edit, AllowCommits: &allowCommits, Model: ptr("claude-opus-4-8"), WorkspaceBaseRef: ptr("0123456789abcdef0123456789abcdef01234567"),
			NetworkEnforcement: ptr("filtered-advisory"), GitIsolation: ptr("readonly"), Tests: simTestSummary("project-directory-edit"),
			AgentStatus: &api.AgentStatusInfo{Status: api.Waiting, Timestamp: simNow().Format(time.RFC3339)},
		},
		{
			Id: "project-directory-readonly", Title: ptr("Review the desktop architecture"), AgentType: "codex",
			BranchName: nil, SessionPid: 1011, SessionStatus: "running", CreatedAt: &createdReadonly,
			ProjectPath: "/Users/callum/code/hydra", BaseBranch: "main", Prompt: simAgentCodexPrompt, ChatMode: &chatMode,
			WorkspaceKind: api.WorkspaceKindProjectDirectory, FilesystemMode: &readonly, AllowCommits: &disallowCommits, Model: ptr("gpt-5.6-sol"), WorkspaceBaseRef: ptr("0123456789abcdef0123456789abcdef01234567"),
			NetworkEnforcement: ptr("filtered-advisory"), GitIsolation: ptr("readonly"), Tests: simTestSummary("project-directory-readonly"),
			AgentStatus: &api.AgentStatusInfo{Status: api.Finished, Timestamp: simNow().Format(time.RFC3339)},
		},
		{
			Id: "project-directory-working", Title: ptr("Trace preview port allocation"), AgentType: "claude",
			BranchName: nil, SessionPid: 1012, SessionStatus: "running", CreatedAt: &createdWorking,
			ProjectPath: "/Users/callum/code/hydra", BaseBranch: "main", Prompt: simAgentWorkingPrompt, ChatMode: &chatMode,
			WorkspaceKind: api.WorkspaceKindProjectDirectory, FilesystemMode: &edit, AllowCommits: &disallowCommits, Model: ptr("claude-opus-4-8"), WorkspaceBaseRef: ptr("0123456789abcdef0123456789abcdef01234567"),
			NetworkEnforcement: ptr("filtered-advisory"), GitIsolation: ptr("readonly"), Tests: simTestSummary("project-directory-working"),
			AgentStatus: &api.AgentStatusInfo{Status: api.Running, Timestamp: simNow().Format(time.RFC3339), Activity: ptr("Reading `internal/preview/ports.go`")},
		},
	}
}

func (s *SimulationServer) projectDirectoryAgents() []api.AgentResponse {
	agents := simProjectDirectoryAgents()
	s.projectDirectoryMu.Lock()
	defer s.projectDirectoryMu.Unlock()
	for i := range agents {
		if override, ok := s.projectDirectory[agents[i].Id]; ok {
			agents[i].FilesystemMode = &override.mode
			agents[i].AllowCommits = &override.allowCommits
		}
	}
	return agents
}

func (s *SimulationServer) projectDirectoryAgent(id string) (api.AgentResponse, bool) {
	for _, agent := range s.projectDirectoryAgents() {
		if agent.Id == id {
			return agent, true
		}
	}
	return api.AgentResponse{}, false
}

// simAgentAskPrompt seeds the AskUserQuestion demo agent (agent-ask), whose
// chat view is parked on a live native question card (see handleSimAskWS).
const simAgentAskPrompt = "Refactor the config loader to support per-environment overrides."

// simAgentAsk is the AskUserQuestion demo agent, shared by ListAgents and
// GetAgent. It reports needs_input while parked on its question and running
// while the answered turn streams (see askRunning), so the chat's live working
// indicator - which reads this record, not the WS status frame - lights up for
// that stretch and settles when the result footer lands.
func (s *SimulationServer) simAgentAsk() api.AgentResponse {
	createdAt := simNow().Add(-20 * time.Minute).Unix()
	if s.askRunning.Load() {
		return api.AgentResponse{
			WorkspaceKind: api.WorkspaceKindWorktree,
			Id:            "agent-ask",
			Title:         ptr("Per-environment config overrides"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-config-overrides"),
			SessionPid:    1007,
			SessionStatus: "running",
			CreatedAt:     &createdAt,
			Prompt:        simAgentAskPrompt,
			ChatMode:      ptr(true),
			Model:         ptr("claude-opus-4-8"),
			AgentStatus: &api.AgentStatusInfo{
				Status:    api.Running,
				Timestamp: simNow().Format(time.RFC3339),
				Activity:  ptr("Wiring the per-environment overlay into `Load`"),
			},
		}
	}
	return api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindWorktree,
		Id:            "agent-ask",
		Title:         ptr("Per-environment config overrides"),
		AgentType:     "claude",
		BaseBranch:    "main",
		BranchName:    ptr("hydra/feat-config-overrides"),
		SessionPid:    1007,
		SessionStatus: "running",
		CreatedAt:     &createdAt,
		Prompt:        simAgentAskPrompt,
		ChatMode:      ptr(true),
		Model:         ptr("claude-opus-4-8"),
		AgentStatus: &api.AgentStatusInfo{
			Status:      api.NeedsInput,
			Timestamp:   simNow().Format(time.RFC3339),
			LastMessage: ptr("Which override layering should I implement?"),
		},
	}
}

// simAgentWorkingPrompt seeds the mid-turn demo agent (agent-working), whose
// chat never reaches a result: it parks with a turn in flight (see
// handleSimWorkingWS).
const simAgentWorkingPrompt = "Trace how a preview server gets its port and write up the allocation rules."

// simAgentWorking is the only simulated head that is parked MID-TURN. Every
// other chat agent's canned stream ends with a result footer, which settles the
// turn - so the live chrome that only exists while a turn is in flight (the
// working spark + shimmering verb, the ticking elapsed/token counter, the
// streaming thinking card, the composer's queue-instead-of-send path) had no
// home in simulation and could only be seen against a real running head.
func simAgentWorking() api.AgentResponse {
	createdAt := simNow().Add(-6 * time.Minute).Unix()
	return api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindWorktree,
		Id:            "agent-working",
		Title:         ptr("Document preview port allocation"),
		AgentType:     "claude",
		BaseBranch:    "main",
		BranchName:    ptr("hydra/sim-working"),
		SessionPid:    1009,
		SessionStatus: "running",
		CreatedAt:     &createdAt,
		Prompt:        simAgentWorkingPrompt,
		ChatMode:      ptr(true),
		Model:         ptr("claude-opus-4-8"),
		AgentStatus: &api.AgentStatusInfo{
			Status:    api.Running,
			Timestamp: simNow().Format(time.RFC3339),
			Activity:  ptr("Reading `internal/preview/ports.go`"),
		},
	}
}

// simAgentApprovalsPrompt seeds the approval-preview head, whose chat parks on a
// question card listing every kind of security-gate approval (see
// handleSimApprovalsWS).
const simAgentApprovalsPrompt = "Check what the daemon is listening on, then show me each approval card in turn."

// simApprovalsHostRun is the command the transcript's `hydra host-run` card asks
// to run on the host. The host_command option parks this SAME text, so picking it
// grows the Allow/Deny row on that very card (a host-run approval is matched to
// its card by the command itself).
const simApprovalsHostRun = "echo '== listeners 26600-26699 =='; ss -Hltnp | grep -E ':266[0-9][0-9]' | sort -t: -k2 | head -60; echo; echo '== count =='; ss -Hltn | grep -cE ':266[0-9][0-9]'; echo; echo '== tailscale serve status =='; tailscale serve status 2>&1 | head -30"

// simApprovalsHostRunWhy is the `host-run --why` explanation that goes with it:
// the agent's account of what it wants and which sandbox limit blocks it, shown
// above the command in the card.
const simApprovalsHostRunWhy = "I need to see which ports the daemon and its previews are actually listening on, and whether tailscale serve is up. My sandbox has its own network namespace, so ss/tailscale inside it only ever see my own namespace - the host's listener table isn't visible from in here at all. Read-only inspection; it changes nothing."

// simAgentApprovals is the approval-picker head, shared by ListAgents and
// GetAgent. While a kind is parked it reports the policy_approval wait a real
// gated head would, which is what makes the client fetch the approval and raise
// the toast.
//
// Not to be confused with `agent-approval` (singular), the static head the
// approval-card screenshots are attributed to: this one is the live playground.
func (s *SimulationServer) simAgentApprovals() api.AgentResponse {
	createdAt := simNow().Add(-15 * time.Minute).Unix()
	status := &api.AgentStatusInfo{
		Status:      api.NeedsInput,
		Timestamp:   simNow().Format(time.RFC3339),
		LastMessage: ptr("Which approval card should I raise?"),
	}
	if kind, _ := s.simApproval(); kind != "" {
		req, ok := simApprovalRequest(kind)
		if ok {
			status.NotificationType = ptr("policy_approval")
			status.LastMessage = ptr(req.Summary)
		}
	}
	return api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindWorktree,
		Id:            "agent-approvals",
		Title:         ptr("Preview the approval cards"),
		AgentType:     "claude",
		BaseBranch:    "main",
		BranchName:    ptr("hydra/sim-approvals"),
		SessionPid:    1008,
		SessionStatus: "running",
		CreatedAt:     &createdAt,
		Prompt:        simAgentApprovalsPrompt,
		ChatMode:      ptr(true),
		Model:         ptr("claude-opus-4-8"),
		AgentStatus:   status,
	}
}

func (s *SimulationServer) ListAgents(w http.ResponseWriter, r *http.Request, projectId string, params api.ListAgentsParams) {
	// ?archived=true is the archived listing - one operation now, because the old
	// /agents/archived path shadowed a head whose id was "archived".
	if params.Archived != nil && *params.Archived {
		simListArchivedAgents(w, params)
		return
	}
	createdAt0 := simNow().Add(-30 * time.Minute).Unix()
	createdAt1 := simNow().Add(-1 * time.Hour).Unix()
	createdAt2 := simNow().Add(-2 * time.Hour).Unix()
	createdAt3 := simNow().Add(-3 * time.Hour).Unix()

	running := api.Running
	needsInput := api.NeedsInput
	finished := api.Finished
	unread := true

	resp := api.ListAgents200JSONResponse{
		{
			// Markdown-rendering demo agent. Its live-activity line carries inline
			// markdown (code + bold + italic) plus a backslash-escaped file name
			// (the shape the backend emits for a file like _LAYOUT_.tsx, which must
			// show verbatim - not "LAYOUT" in italics) so the sidebar shows the
			// rendered activity; see agent-3 for the $-command override.
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
				Activity:  ptr("Editing \\_LAYOUT\\_.tsx - `renderMarkdown()` over the **prompt** & *activity*"),
			},
		},
		{
			// Finished its turn with a terse closing instruction. "run it" is a
			// suggested next message - short, single-clause - so the sidebar marks
			// it with a `❯ ` caret (see isSuggestedNextMessage in AgentComponents),
			// in contrast to agent-2's multi-sentence report, which stays plain.
			// Also carries the blue unread-changes dot: it went quiet (running→
			// finished) while you were away, the classic case the blue marker is
			// for - distinct from agent-2's red needs-input marker right below it.
			Id:               "agent-1",
			Title:            ptr("Add renameable agent titles"),
			AgentType:        "claude",
			BaseBranch:       "main",
			BranchName:       ptr("hydra/feat-1"),
			SessionPid:       1001,
			SessionStatus:    "running",
			CreatedAt:        &createdAt1,
			HasUnreadChanges: &unread,
			// agent-1 is the head with review fixtures on it, and one of them (the
			// agent's own reply, #6) is unread - so the sidebar badge has something
			// to show alongside the has_unread_changes dot, which is the pairing
			// worth being able to look at.
			UnreadComments: ptr(1),
			// ...and more of them are merely UNRESOLVED, which is the count the
			// badge shows. The two disagreeing is the whole reason both exist, so
			// the fixture makes them disagree.
			OpenComments: ptr(4),
			Prompt:       simAgent1Prompt,
			AgentStatus: &api.AgentStatusInfo{
				Status:                            finished,
				Timestamp:                         simNow().Format(time.RFC3339),
				LastMessage:                       ptr("run it"),
				LastMessageIsSuggestedNextMessage: ptr(true),
			},
		},
		// Chat-mode demo agent: its detail page renders the chat view instead of
		// a terminal; HandleTerminalWS serves it chat framing.
		simAgentChat(),
		// Same presentation over the durable provider-neutral Codex event stream.
		simAgentCodex(),
		// Chat-mode agent blocked on a native AskUserQuestion - its page shows
		// a live, answerable question card.
		s.simAgentAsk(),
		// Chat-mode agent parked mid-turn: the only place the live working
		// indicator is visible in simulation.
		simAgentWorking(),
		// A long, finished conversation that never streams - the still transcript
		// to scroll, fold and copy (see handleSimHistoryWS).
		simAgentHistory(),
		// The approval picker: its question card raises any one of the gate's
		// approval cards on demand (nothing is parked until you pick).
		s.simAgentApprovals(),
		{
			// Blocked on the user (AskUserQuestion) while you were away → the red
			// "needs you" status, which also lights the red needs-input marker on
			// the right of the row (instead of the blue unread dot). Demos how an
			// explicit question stands apart from the softer yellow "waiting".
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
				Status:    needsInput,
				Timestamp: simNow().Format(time.RFC3339),
				// A multi-line message - the sidebar's activity row collapses it to a
				// single truncated line (singleLine), so a code block can no longer
				// render as a multi-line block and clip.
				LastMessage: ptr("Two providers expose refresh tokens differently:\n```\nGoogle: offline access\nGitHub: no refresh\n```\nShould I store refresh tokens or re-auth on expiry?"),
			},
		},
		{
			// Deeply-nested refactor - exercises the diff tree's VS Code-style
			// "compact folders" rendering (see GetAgentDiff for agent-3).
			Id:         "agent-3",
			Title:      ptr("Refactor auth into nested packages"),
			AgentType:  "claude",
			BaseBranch: "main",
			BranchName: ptr("hydra/feat-3"),
			// A worktree path, so the merge-conflict panel's "Resolving locally"
			// script shows a real `cd` target rather than its <worktree-path>
			// placeholder (the merge-conflict-dialog screenshot captures it).
			WorktreePath:  ptr("/repo/.hydra/local/worktrees/feat-3"),
			SessionPid:    1003,
			SessionStatus: "running",
			CreatedAt:     &createdAt3,
			AgentStatus: &api.AgentStatusInfo{
				Status:    running,
				Timestamp: simNow().Format(time.RFC3339),
				// A "$"-prefixed activity renders as a command (whole line styled
				// as code), overriding markdown - demos the activity-only override.
				Activity: ptr("$ go test ./internal/heads/ -run TestResumeLazy"),
			},
		},
		{
			// A plain needs-input agent asking a clarifying question. (Security-gate
			// approval cards are documented as their own harness shots -
			// agent-approvals-*.png - not via a live simulated agent, so nothing
			// here sits in a policy_approval wait; otherwise the global approval
			// toasts would leak onto every simulated page.)
			Id:                 "agent-approval",
			Title:              ptr("Wire up the GitHub MCP server"),
			AgentType:          "claude",
			BaseBranch:         "main",
			BranchName:         ptr("hydra/feat-mcp"),
			SessionPid:         1005,
			SessionStatus:      "running",
			CreatedAt:          &createdAt0,
			Prompt:             "Use the linear MCP server to pull the open issues and start on the highest-priority one.",
			NetworkEnforcement: ptr("filtered-advisory"),
			GitIsolation:       ptr("readonly"),
			AgentStatus: &api.AgentStatusInfo{
				Status:      needsInput,
				Timestamp:   simNow().Format(time.RFC3339),
				LastMessage: ptr("Which Linear team should I scope the sync to?"),
			},
		},
		{
			// Auto-merge armed AND blocked on you: it queued a merge (tests already
			// green) but is now asking a question (needs_input), so the "Merge queued"
			// pill's tooltip reports it's waiting on YOU - the agent-status gate, not
			// tests (merge-queued-tooltip shot).
			Id:            "agent-queued",
			Title:         ptr("Add a command palette"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-palette"),
			SessionPid:    1006,
			SessionStatus: "running",
			CreatedAt:     &createdAt0,
			AgentStatus: &api.AgentStatusInfo{
				Status:      needsInput,
				Timestamp:   simNow().Format(time.RFC3339),
				LastMessage: ptr("Bind the palette to Cmd+K or Cmd+P - which do you prefer?"),
			},
		},
	}
	resp = append(resp, s.projectDirectoryAgents()...)
	// Attach test-verdict chips (PLAN #68) so the sidebar shows passing/failing/
	// running states; agent-md and agent-queued are also shown with auto-merge armed.
	for i := range resp {
		if resp[i].WorkspaceKind == "" {
			resp[i].WorkspaceKind = api.WorkspaceKindWorktree
		}
		resp[i].Tests = simTestSummary(resp[i].Id)
		if resp[i].Id == "agent-md" || resp[i].Id == "agent-queued" {
			resp[i].MergeWhenGreen = ptr(true)
		}
		// agent-approval demonstrates a linked MR that is BEHIND its remote branch
		// (View MR + the amber pull chip); agent-1 a linked, ahead-by-1 head (the
		// button leads with Push to MR and the sidebar row shows the up-arrow);
		// agent-2 an unlinked head with a seeded downstream branch (Create MR).
		switch resp[i].Id {
		case "agent-approval":
			resp[i].DownstreamBranch = ptr("feat/mcp-github")
			resp[i].Review = simReviewLink("open", forge.CIRunning, 1, 2, 0, 2)
		case "agent-1":
			resp[i].DownstreamBranch = ptr("feat/rate-limit")
			resp[i].Review = simReviewLink("open", forge.CISuccess, 2, 0, 1, 0)
		case "agent-2":
			resp[i].DownstreamBranch = ptr("feat/small-fix")
		case "agent-3":
			// agent-3 is an ADOPTED PR: linked and pushable, but auto-push is off.
			resp[i].DownstreamBranch = ptr("contrib/auth-packages")
			resp[i].Review = simAdoptedReviewLink()
		}
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

// simArchivedAgents returns the seeded archived (killed/merged) history used by
// the archived sidebar section + the read-only archived agent page.
func simArchivedAgents() []api.AgentResponse {
	archived := true
	finished := api.Finished
	stopped := api.Stopped
	// createdHours / archivedHours are independent so the seeded history shows
	// what the real list does: it is ordered by when a head was killed/merged,
	// not by when it was spawned (a long-running head archived recently sorts
	// above a short one spawned after it). archivedHours < 0 seeds a legacy row
	// with no recorded archive time.
	mk := func(id, title, agentType, branch, endState, prompt string, status api.AgentStatus, createdHours, archivedHours time.Duration) api.AgentResponse {
		createdAt := simNow().Add(-createdHours * time.Hour).Unix()
		var archivedAt *int64
		if archivedHours >= 0 {
			ts := simNow().Add(-archivedHours * time.Hour).Unix()
			archivedAt = &ts
		}
		es := endState
		return api.AgentResponse{
			WorkspaceKind: api.WorkspaceKindWorktree,
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
			ArchivedAt:    archivedAt,
			AgentStatus: &api.AgentStatusInfo{
				Status:    status,
				Timestamp: simNow().Format(time.RFC3339),
			},
		}
	}
	// Listed newest-archived first, as the real ListArchivedAgents orders them.
	createdAt := simNow().Add(-18 * time.Hour).Unix()
	archivedAt := simNow().Add(-3 * time.Hour).Unix()
	chatMode := true
	allowCommits := false
	readonly := api.ProjectDirectoryFilesystemReadonly
	endState := "killed"
	archivedProjectDirectory := api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindProjectDirectory,
		Id:            "archived-project-directory", Title: ptr("Audit the release workflow"), AgentType: "claude",
		BranchName: nil, SessionStatus: "stopped", ProjectPath: "/Users/callum/code/hydra",
		Prompt: "Review the release workflow and list the remaining manual steps.", CreatedAt: &createdAt,
		Archived: &archived, ArchivedAt: &archivedAt, EndState: &endState, ChatMode: &chatMode,
		FilesystemMode: &readonly, AllowCommits: &allowCommits,
		AgentStatus: &api.AgentStatusInfo{Status: stopped, Timestamp: simNow().Format(time.RFC3339)},
	}
	return []api.AgentResponse{
		mk("archived-1", "Add dark-mode toggle to settings", "claude", "hydra/feat-darkmode", "merged", "Add a dark-mode toggle to the settings page, persisted to localStorage and respecting the OS preference by default.", finished, 5, 2),
		archivedProjectDirectory,
		mk("archived-4", "Investigate sandbox netns isolation", "claude", "hydra/spike-netns", "killed", "Explore giving each agent its own network namespace with a rootless userspace NAT (pasta/slirp4netns) for per-agent port isolation.", stopped, 30, 4),
		mk("archived-2", "Spike: WebSocket diff refresh", "gemini", "hydra/spike-ws", "killed", "Prototype pushing diff_refresh over the existing terminal WebSocket instead of the 20s poll, and measure the latency win.", stopped, 8, 7),
		mk("archived-3", "Fix flaky terminal resize test", "claude", "hydra/fix-resize", "merged", "TestTerminalResize fails intermittently in CI. Track down the race and make it deterministic.", finished, 26, 25),
		mk("archived-5", "Render ANSI colour in artifact logs", "copilot", "hydra/feat-ansi", "merged", "Replace stripAnsi in the artifact log panes with a real SGR renderer so build output keeps its colour.", finished, 49, -1),
	}
}

func simListArchivedAgents(w http.ResponseWriter, params api.ListAgentsParams) {
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
	resp := api.ListAgents200JSONResponse(page)
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) GetAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	// The chat plan reaches the client via the chat WS "plan" frame (see
	// handleSimChatWS), mirroring the daemon's incremental tracking.
	write := func(resp api.AgentResponse) {
		api.WriteJSON(w, http.StatusOK, resp)
	}
	for _, a := range simArchivedAgents() {
		if a.Id == id {
			write(a)
			return
		}
	}
	if agent, ok := s.projectDirectoryAgent(id); ok {
		write(agent)
		return
	}
	if id == "agent-1" {
		createdAt := simNow().Add(-1 * time.Hour).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			WorkspaceKind: api.WorkspaceKindWorktree,
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
				Status:                            api.Finished,
				Timestamp:                         simNow().Format(time.RFC3339),
				LastMessage:                       ptr("run it"),
				LastMessageIsSuggestedNextMessage: ptr(true),
			},
		})
		return
	}
	if id == "agent-md" {
		createdAt := simNow().Add(-30 * time.Minute).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			WorkspaceKind: api.WorkspaceKindWorktree,
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
				Activity:  ptr("Editing \\_LAYOUT\\_.tsx - `renderMarkdown()` over the **prompt** & *activity*"),
			},
			Tests:          simTestSummary("agent-md"),
			MergeWhenGreen: ptr(true),
		})
		return
	}
	if id == "agent-chat" || id == "project-directory-edit" {
		write(simAgentChat())
		return
	}
	if id == "agent-chat-codex" {
		write(simAgentCodex())
		return
	}
	if id == "agent-ask" {
		write(s.simAgentAsk())
		return
	}
	if id == "agent-working" {
		write(simAgentWorking())
		return
	}
	if id == "agent-history" {
		write(simAgentHistory())
		return
	}
	if id == "agent-approvals" {
		write(s.simAgentApprovals())
		return
	}
	if id == "agent-approval" {
		createdAt := simNow().Add(-30 * time.Minute).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			WorkspaceKind:      api.WorkspaceKindWorktree,
			Id:                 "agent-approval",
			Title:              ptr("Wire up the GitHub MCP server"),
			AgentType:          "claude",
			BaseBranch:         "main",
			BranchName:         ptr("hydra/feat-mcp"),
			SessionPid:         1005,
			SessionStatus:      "running",
			CreatedAt:          &createdAt,
			Prompt:             "Use the linear MCP server to pull the open issues and start on the highest-priority one.",
			NetworkEnforcement: ptr("filtered-advisory"),
			GitIsolation:       ptr("readonly"),
			AgentStatus: &api.AgentStatusInfo{
				Status:      api.NeedsInput,
				Timestamp:   simNow().Format(time.RFC3339),
				LastMessage: ptr("Which Linear team should I scope the sync to?"),
			},
		})
		return
	}
	if id == "agent-queued" {
		createdAt := simNow().Add(-30 * time.Minute).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			WorkspaceKind: api.WorkspaceKindWorktree,
			Id:            "agent-queued",
			Title:         ptr("Add a command palette"),
			AgentType:     "claude",
			BaseBranch:    "main",
			BranchName:    ptr("hydra/feat-palette"),
			SessionPid:    1006,
			SessionStatus: "running",
			CreatedAt:     &createdAt,
			Prompt:        "Add a command palette (Cmd+K) that fuzzy-searches every action and recent agent.",
			AgentStatus: &api.AgentStatusInfo{
				Status:      api.NeedsInput,
				Timestamp:   simNow().Format(time.RFC3339),
				LastMessage: ptr("Bind the palette to Cmd+K or Cmd+P - which do you prefer?"),
			},
			Tests:          simTestSummary("agent-queued"),
			MergeWhenGreen: ptr(true),
		})
		return
	}
	if id == "agent-3" {
		createdAt := simNow().Add(-3 * time.Hour).Unix()
		api.WriteJSON(w, http.StatusOK, api.AgentResponse{
			WorkspaceKind:    api.WorkspaceKindWorktree,
			Id:               "agent-3",
			Title:            ptr("Refactor auth into nested packages"),
			AgentType:        "claude",
			BaseBranch:       "main",
			BranchName:       ptr("hydra/feat-3"),
			SessionPid:       1003,
			SessionStatus:    "running",
			CreatedAt:        &createdAt,
			Prompt:           "Refactor the auth providers into a deeply nested package layout so the diff tree shows VS Code-style compacted folders.",
			Tests:            simTestSummary("agent-3"),
			DownstreamBranch: ptr("contrib/auth-packages"),
			Review:           simAdoptedReviewLink(),
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
			WorkspaceKind:    api.WorkspaceKindWorktree,
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
				Status:      api.NeedsInput,
				Timestamp:   simNow().Format(time.RFC3339),
				LastMessage: ptr("Should I store refresh tokens or re-auth on expiry?"),
			},
			Tests: simTestSummary("agent-2"),
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
	agent, ok := s.projectDirectoryAgent(id)
	if !ok {
		api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
		return
	}
	var body api.UpdateAgentJSONRequestBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		api.WriteError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	mode := *agent.FilesystemMode
	allowCommits := *agent.AllowCommits
	if body.FilesystemMode != nil {
		mode = *body.FilesystemMode
	}
	if body.AllowCommits != nil {
		allowCommits = *body.AllowCommits
	}
	if mode == api.ProjectDirectoryFilesystemReadonly && allowCommits {
		api.WriteError(w, http.StatusBadRequest, "Read-only project directory agents cannot allow commits")
		return
	}
	if body.CheckoutBranch != nil && *body.CheckoutBranch != "main" && *body.CheckoutBranch != "release" {
		api.WriteError(w, http.StatusBadRequest, "Unknown simulated checkout branch")
		return
	}
	s.projectDirectoryMu.Lock()
	if s.projectDirectory == nil {
		s.projectDirectory = make(map[string]simProjectDirectoryPermissions)
	}
	s.projectDirectory[id] = simProjectDirectoryPermissions{mode: mode, allowCommits: allowCommits}
	if body.CheckoutBranch != nil {
		s.projectDirectoryCheckoutBranch = *body.CheckoutBranch
	}
	s.projectDirectoryMu.Unlock()
	agent.FilesystemMode = &mode
	agent.AllowCommits = &allowCommits
	api.WriteJSON(w, http.StatusOK, agent)
}

func (s *SimulationServer) RestartAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

// RestartAgentSession succeeds (rather than 501) so the UI's restart flow -
// confirm dialog, toast, terminal reconnect - can be exercised in simulation.
func (s *SimulationServer) RestartAgentSession(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

// StopAgentSession succeeds so native desktop close can be exercised without
// deleting the simulated head from the page.
func (s *SimulationServer) StopAgentSession(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) ResumeAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	api.WriteError(w, http.StatusNotImplemented, "Not implemented in simulation mode")
}

func (s *SimulationServer) MergeAgent(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.MergeAgentParams) {
	w.WriteHeader(http.StatusNoContent)
}

// simAdoptedReviewLink builds a fixture ReviewLink for a head spawned ONTO an
// existing PR Hydra did not create (docs/pr-adoption.md). Maintainer edits are
// on, so it can be pushed to by hand - but never automatically, which is what
// the "Pushes to this PR are manual" note in the MR menu documents.
func simAdoptedReviewLink() *api.ReviewLink {
	link := simReviewLink("open", forge.CIRunning, 0, 1, 2, 0)
	link.Provider = forge.ProviderGitHub
	link.Url = "https://github.com/team/repo/pull/128"
	link.Id = "128"
	link.Adopted = ptr(true)
	link.CanPush = ptr(true)
	return link
}

// simReviewLink builds a fixture ReviewLink for the simulation server.
func simReviewLink(state, ci string, approvals, unresolved, ahead, behind int) *api.ReviewLink {
	return &api.ReviewLink{
		Url:          "https://gitlab.example.com/team/repo/-/merge_requests/42",
		Id:           "42",
		Provider:     forge.ProviderGitLab,
		TargetBranch: ptr("main"),
		Ahead:        ptr(ahead),
		Behind:       ptr(behind),
		State: &api.ReviewState{
			State:                 state,
			CiStatus:              ptr(ci),
			Approvals:             ptr(approvals),
			ApprovalsRequired:     ptr(2),
			UnresolvedDiscussions: ptr(unresolved),
			Mergeable:             ptr(state == "open" && ci == forge.CISuccess),
		},
	}
}

func (s *SimulationServer) PublishAgent(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	resp := simAgentByID(id)
	resp.DownstreamBranch = ptr("feat/published")
	resp.Review = simReviewLink("draft", forge.CIPending, 0, 0, 0, 0)
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) PushToMr(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	resp := simAgentByID(id)
	resp.Review = simReviewLink("open", forge.CIRunning, 1, 2, 0, 0)
	// A push does not un-adopt a head: keep agent-3 on its adopted PR so the menu
	// it repaints still shows the adopted affordances.
	if id == "agent-3" {
		resp.Review = simAdoptedReviewLink()
		resp.Review.Ahead = ptr(0)
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) PullFromMr(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	resp := simAgentByID(id)
	resp.Review = simReviewLink("open", forge.CISuccess, 1, 0, 0, 0)
	if id == "agent-3" {
		resp.Review = simAdoptedReviewLink()
		resp.Review.Behind = ptr(0)
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) SetDownstreamBranch(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	var body api.SetDownstreamBranchJSONBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	resp := simAgentByID(id)
	resp.DownstreamBranch = &body.DownstreamBranch
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) ArmAutoPush(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.ArmAutoPushParams) {
	// Mirror the real gate so the adopted-PR warning dialog is exercisable in the
	// simulation: agent-3 is the adopted fixture, and arming it without the
	// acknowledgement is the 400 the dialog exists to prevent.
	if id == "agent-3" && (params.AcknowledgeAdopted == nil || !*params.AcknowledgeAdopted) {
		api.WriteError(w, http.StatusBadRequest, "this head is working on a PR Hydra did not create: pass acknowledge_adopted=true to confirm you want every commit pushed into it")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) DisarmAutoPush(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) GetReviewConfig(w http.ResponseWriter, r *http.Request, projectId string) {
	api.WriteJSON(w, http.StatusOK, api.ReviewConfigResponse{
		Configured:         true,
		Provider:           forge.ProviderGitLab,
		ProviderSetting:    ptr("auto"),
		Remote:             "origin",
		RemoteUrl:          ptr("git@gitlab.example.com:team/repo.git"),
		BrowseUrl:          ptr("https://gitlab.example.com/team/repo"),
		Auth:               "cli",
		AuthStatus:         ptr("glab: logged in to gitlab.example.com as sim-user"),
		Authenticated:      ptr(true),
		DefaultAction:      "create_mr",
		PushBranchTemplate: ptr("feat/{issue}-{id}"),
		Draft:              ptr(true),
		Squash:             ptr(true),
		DeleteRemoteBranch: ptr(true),
		RequireLocalTests:  ptr(true),
		AutoPush:           ptr(true),
		ProtectedBranches:  &[]string{"main"},
	})
}

func (s *SimulationServer) ListReviews(w http.ResponseWriter, r *http.Request, projectId string, params api.ListReviewsParams) {
	api.WriteJSON(w, http.StatusOK, api.ListReviewsResponse{
		Configured:    true,
		Authenticated: true,
		Provider:      ptr(forge.ProviderGitLab),
		Reviews: []api.ReviewRef{
			{
				Id: "128", Url: "https://gitlab.example.com/team/repo/-/merge_requests/128",
				Title: "Add rate limiting to the ingest API", Author: ptr("priya"),
				State: forge.StateOpen, Draft: ptr(false),
				HeadRef: "feat/rate-limit", TargetBranch: "main", CrossRepo: false, CanPush: true,
			},
			{
				Id: "131", Url: "https://gitlab.example.com/team/repo/-/merge_requests/131",
				Title: "Fix flaky screenshot test", Author: ptr("sam"),
				State: forge.StateDraft, Draft: ptr(true),
				HeadRef: "fix/flaky-shot", TargetBranch: "main", CrossRepo: false, CanPush: true,
			},
			{
				Id: "134", Url: "https://gitlab.example.com/team/repo/-/merge_requests/134",
				Title: "Community: typo fixes in docs", Author: ptr("external-contributor"),
				State: forge.StateOpen, Draft: ptr(false),
				HeadRef: "docs/typos", HeadRepoUrl: ptr("https://gitlab.example.com/external-contributor/repo.git"),
				TargetBranch: "main", CrossRepo: true, CanPush: false,
			},
		},
	})
}

// simThreadMu guards the simulation's in-memory review threads, so replies made
// in the UI stick for the rest of the run (the fixtures are seeded lazily on
// first read).
var (
	simThreadMu      sync.Mutex
	simThreadsByHead map[string][]api.ReviewThread
)

// simSeedThreads builds the fixture review conversations for a head. They anchor
// to lines that really exist in the simulated diff (internal/heads/heads.go 5 and
// 45), so the diff viewer renders them inline, and cover the three shapes worth
// looking at: a plain forge thread, a thread with an agent's local-only reply,
// and a resolved one.
// simAvatar stands in for a forge-hosted profile picture. A data: URL rather than
// a real one so the simulation needs no network and hotlinks nobody - what is
// being demonstrated is that the AVATAR PATH works, not whose face is on it.
func simAvatar(name, colour string) string {
	svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">`+
		`<rect width="48" height="48" fill="%s"/>`+
		`<circle cx="24" cy="18" r="8" fill="#ffffff" opacity="0.9"/>`+
		`<path d="M8 48c0-9 7-16 16-16s16 7 16 16z" fill="#ffffff" opacity="0.9"/>`+
		`<title>%s</title></svg>`, colour, name)
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))
}

func simSeedThreads(id string) []api.ReviewThread {
	if id != "agent-1" {
		return nil
	}
	return []api.ReviewThread{
		{
			Id: "701", Path: "internal/heads/heads.go", Line: 5,
			Resolved: ptr(false), Outdated: ptr(false),
			Url: ptr("https://gitlab.example.com/team/repo/-/merge_requests/42#note_701"),
			Notes: []api.ReviewThreadNote{
				{Id: "701", Number: ptr(3), Read: ptr(true), Author: ptr("priya"), AvatarUrl: ptr(simAvatar("priya", "#7c3aed")), Body: "Is `errors` still used after the refactor? If not this import can go.", Origin: api.Forge, CreatedAt: ptr("2026-07-28T09:12:00Z"), Url: ptr("https://gitlab.example.com/team/repo/-/merge_requests/42#note_701")},
			},
		},
		{
			Id: "702", Path: "internal/heads/heads.go", Line: 45,
			Resolved: ptr(false), Outdated: ptr(false),
			Url: ptr("https://gitlab.example.com/team/repo/-/merge_requests/42#note_702"),
			Notes: []api.ReviewThreadNote{
				{Id: "702", Number: ptr(4), Read: ptr(true), Author: ptr("sam"), AvatarUrl: ptr(simAvatar("sam", "#0891b2")), Body: "Threading a `*db.Store` through here couples spawn to the DB - can we pass the narrower interface instead?", Origin: api.Forge, CreatedAt: ptr("2026-07-28T09:20:00Z")},
				{Id: "703", Number: ptr(5), Read: ptr(true), Author: ptr("priya"), AvatarUrl: ptr(simAvatar("priya", "#7c3aed")), Body: "Agreed, and it would make this testable without a temp DB.", Origin: api.Forge, CreatedAt: ptr("2026-07-28T09:26:00Z")},
				// Unread: an agent's reply is news, and this is what the unread dot and
				// the next-unread jump are for.
				{Id: "local-1", Number: ptr(6), Read: ptr(false), Author: ptr("agent"), Body: "Narrowed it to a `HeadStore` interface in 4f21ac9 - spawn now takes just `CreateAgent`/`GetAgent`.", Origin: api.LocalOnly, CreatedAt: ptr("2026-07-28T09:41:00Z")},
			},
		},
		{
			Id: "704", Path: "web/src/components/AgentDetail.tsx", Line: 46,
			Resolved: ptr(true), Outdated: ptr(false),
			Notes: []api.ReviewThreadNote{
				{Id: "704", Number: ptr(7), Read: ptr(true), Author: ptr("sam"), AvatarUrl: ptr(simAvatar("sam", "#0891b2")), Body: "Nit: this could use the shared formatter.", Origin: api.Forge, CreatedAt: ptr("2026-07-27T16:02:00Z")},
			},
		},
	}
}

// simThreads returns the head's threads, seeding the fixtures on first use.
func simThreads(id string) []api.ReviewThread {
	simThreadMu.Lock()
	defer simThreadMu.Unlock()
	if simThreadsByHead == nil {
		simThreadsByHead = map[string][]api.ReviewThread{}
	}
	if _, ok := simThreadsByHead[id]; !ok {
		simThreadsByHead[id] = simSeedThreads(id)
	}
	return simThreadsByHead[id]
}

// simThreadsResponse wraps the head's threads in the API envelope. agent-1 is the
// linked head in the fixtures; everything else reports unlinked, which is what
// makes the diff viewer show local comments only.
func simThreadsResponse(id string) api.ReviewThreadsResponse {
	threads := simThreads(id)
	resp := api.ReviewThreadsResponse{Threads: threads, Linked: id == "agent-1"}
	if resp.Threads == nil {
		resp.Threads = []api.ReviewThread{}
	}
	if resp.Linked {
		resp.Provider = ptr(forge.ProviderGitLab)
		resp.MrUrl = ptr("https://gitlab.example.com/team/repo/-/merge_requests/42")
		resp.FetchedAt = ptr(time.Now().Format(time.RFC3339))
	}
	return resp
}

func (s *SimulationServer) GetReviewThreads(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	api.WriteJSON(w, http.StatusOK, simThreadsResponse(id))
}

func (s *SimulationServer) CreateReviewComment(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	var body api.NewReviewCommentRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	simThreads(id) // seed
	simThreadMu.Lock()
	newID := fmt.Sprintf("sim-%d", len(simThreadsByHead[id])+800)
	simThreadsByHead[id] = append(simThreadsByHead[id], api.ReviewThread{
		Id: newID, Path: body.Path, Line: body.Line,
		Resolved: ptr(false), Outdated: ptr(false),
		Notes: []api.ReviewThreadNote{{
			Id: newID, Author: ptr("you"), Body: body.Body, Origin: api.Forge,
			CreatedAt: ptr(time.Now().Format(time.RFC3339)),
		}},
	})
	simThreadMu.Unlock()
	api.WriteJSON(w, http.StatusOK, simThreadsResponse(id))
}

func (s *SimulationServer) ReplyToReviewThread(w http.ResponseWriter, r *http.Request, projectId string, id string, threadId string) {
	var body api.ReviewReplyRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	simThreads(id) // seed
	origin := api.Forge
	author := "you"
	if body.Local != nil && *body.Local {
		origin = api.LocalOnly
	}
	simThreadMu.Lock()
	for i := range simThreadsByHead[id] {
		if simThreadsByHead[id][i].Id != threadId {
			continue
		}
		simThreadsByHead[id][i].Notes = append(simThreadsByHead[id][i].Notes, api.ReviewThreadNote{
			Id:     fmt.Sprintf("sim-reply-%d", len(simThreadsByHead[id][i].Notes)+900),
			Author: ptr(author), Body: body.Body, Origin: origin,
			CreatedAt: ptr(time.Now().Format(time.RFC3339)),
		})
	}
	simThreadMu.Unlock()
	api.WriteJSON(w, http.StatusOK, simThreadsResponse(id))
}

// Hydra-native review comments (docs/review-agent.md), in memory for the run.
// Seeded with one draft and one published comment on agent-1 so the diff viewer
// has both states to render - the pair is the point, since a draft is the one
// thing no agent may see.
var (
	simCommentMu      sync.Mutex
	simCommentsByHead map[string][]api.ReviewComment
	// The fixtures already use 1-7 across both origins (comments 1-2, forge notes
	// 3-7), so a new comment starts at 8 - one sequence, exactly as the real store
	// does it.
	simCommentNextByID = map[string]int{}
)

func simSeedComments(id string) []api.ReviewComment {
	if id != "agent-1" {
		return nil
	}
	return []api.ReviewComment{
		{
			Number: 1, Status: api.Published, Author: "user",
			Body:      "This drops the error rather than wrapping it - the caller can't tell a missing head from a broken DB.",
			Path:      ptr("internal/heads/heads.go"),
			Line:      ptr(45),
			Diff:      ptr("main -> a1b2c3d"),
			CreatedAt: "2026-07-28T10:02:00Z", PublishedAt: ptr("2026-07-28T10:05:00Z"), Read: ptr(true),
			// An attachment on a published comment: the usual case is a screenshot
			// of the thing being described, so the head can look at what you saw.
			Attachments: ptr([]string{
				"/home/you/acme/.hydra/local/projects/sim-project/uploads/1782072241514128486-error-states.png",
				"/home/you/acme/.hydra/local/projects/sim-project/uploads/1782072347433312262-stack-trace.txt",
			}),
		},
		{
			Number: 2, Status: api.Draft, Author: "user",
			Body:      "Worth a test for the empty case before this goes out.",
			Path:      ptr("internal/heads/heads.go"),
			Line:      ptr(5),
			Diff:      ptr("main -> a1b2c3d"),
			CreatedAt: "2026-07-28T10:09:00Z", Read: ptr(true),
			Attachments: ptr([]string{
				"/home/you/acme/.hydra/local/projects/sim-project/uploads/1782072458377091686-repro.png",
			}),
		},
		// Two comments the DIFF cannot show, which is the normal case rather than
		// an exotic one: a reviewer's remark about an unchanged caller, and a
		// comment about the head as a whole (add_review_comment's path is
		// optional). Both are here so the off-diff section is exercised by the
		// simulation - it is otherwise invisible, and invisible is the exact bug
		// it exists to fix.
		{
			Number: 9, Status: api.Published, Author: "reviewer",
			Body:      "This reads under the lock but `Set` above takes it again on the same goroutine in one caller - not in this diff, but it deadlocks with the change you made to the schema loader.",
			Path:      ptr("internal/store/store.go"),
			Line:      ptr(16),
			CreatedAt: "2026-07-28T11:14:00Z", PublishedAt: ptr("2026-07-28T11:14:00Z"),
		},
		{
			Number: 10, Status: api.Published, Author: "reviewer",
			Body:      "Overall this reads well. The schema split is the right call; my only real worry is the migration ordering.",
			CreatedAt: "2026-07-28T11:16:00Z", PublishedAt: ptr("2026-07-28T11:16:00Z"),
		},
	}
}

func simComments(id string) []api.ReviewComment {
	simCommentMu.Lock()
	defer simCommentMu.Unlock()
	if simCommentsByHead == nil {
		simCommentsByHead = map[string][]api.ReviewComment{}
	}
	if _, ok := simCommentsByHead[id]; !ok {
		seeded := simSeedComments(id)
		simCommentsByHead[id] = seeded
		if len(seeded) > 0 {
			simCommentNextByID[id] = 8
		} else {
			simCommentNextByID[id] = 1
		}
	}
	out := append([]api.ReviewComment(nil), simCommentsByHead[id]...)
	if out == nil {
		out = []api.ReviewComment{}
	}
	return out
}

func simCommentsResponse(id string, notified *string) api.ReviewCommentsResponse {
	return api.ReviewCommentsResponse{Comments: simComments(id), Notified: notified}
}

func (s *SimulationServer) GetReviewComments(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	api.WriteJSON(w, http.StatusOK, simCommentsResponse(id, nil))
}

func (s *SimulationServer) AddReviewComment(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	var body api.NewReviewCommentBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	simComments(id) // seed
	simCommentMu.Lock()
	n := simCommentNextByID[id]
	simCommentNextByID[id] = n + 1
	c := api.ReviewComment{
		Number: n, Status: api.Draft, Author: "user", Body: body.Body,
		Path: body.Path, Line: body.Line, OldSide: body.OldSide,
		Commit: body.Commit, Diff: body.Diff, Context: body.Context,
		HunkHash: body.HunkHash, ReplyTo: body.ReplyTo,
		Attachments: body.Attachments,
		// Carried through, or a pin placed on a picture comes back anchored to
		// nothing and disappears the moment it is saved.
		Image:     body.Image,
		Read:      ptr(true),
		CreatedAt: time.Now().Format(time.RFC3339),
	}
	if c.ReplyTo != nil {
		for _, parent := range simCommentsByHead[id] {
			if parent.Number == *c.ReplyTo {
				c.Path, c.Line, c.OldSide = parent.Path, parent.Line, parent.OldSide
				c.Commit, c.Diff, c.Context, c.HunkHash = parent.Commit, parent.Diff, parent.Context, parent.HunkHash
				break
			}
		}
	}
	if body.Publish != nil && *body.Publish {
		c.Status = api.Published
		c.PublishedAt = ptr(c.CreatedAt)
	}
	simCommentsByHead[id] = append(simCommentsByHead[id], c)
	simCommentMu.Unlock()
	var notified *string
	if c.Status == api.Published {
		notified = ptr(simNotifyLine([]api.ReviewComment{c}))
	}
	api.WriteJSON(w, http.StatusOK, simCommentsResponse(id, notified))
}

func (s *SimulationServer) UpdateReviewComment(w http.ResponseWriter, r *http.Request, projectId string, id string, number int) {
	var body api.UpdateReviewCommentBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	simComments(id)
	simCommentMu.Lock()
	for i := range simCommentsByHead[id] {
		if simCommentsByHead[id][i].Number == number && simCommentsByHead[id][i].Status == api.Draft {
			simCommentsByHead[id][i].Body = body.Body
			// nil leaves them alone, as on the real server.
			if body.Attachments != nil {
				simCommentsByHead[id][i].Attachments = body.Attachments
			}
		}
	}
	simCommentMu.Unlock()
	api.WriteJSON(w, http.StatusOK, simCommentsResponse(id, nil))
}

func (s *SimulationServer) DeleteReviewComment(w http.ResponseWriter, r *http.Request, projectId string, id string, number int) {
	simComments(id)
	simCommentMu.Lock()
	kept := simCommentsByHead[id][:0]
	for _, c := range simCommentsByHead[id] {
		if c.Number == number && c.Status == api.Draft {
			continue // the number is retired, not reused: simCommentNextByID never goes back
		}
		kept = append(kept, c)
	}
	simCommentsByHead[id] = kept
	simCommentMu.Unlock()
	api.WriteJSON(w, http.StatusOK, simCommentsResponse(id, nil))
}

func (s *SimulationServer) ResolveReviewComment(w http.ResponseWriter, r *http.Request, projectId string, id string, number int) {
	var body api.ResolveReviewCommentBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	simComments(id)
	simCommentMu.Lock()
	byNumber := make(map[int]api.ReviewComment, len(simCommentsByHead[id]))
	for _, c := range simCommentsByHead[id] {
		byNumber[c.Number] = c
	}
	root := number
	seen := map[int]bool{}
	for c, ok := byNumber[root]; ok && c.ReplyTo != nil && *c.ReplyTo > 0 && !seen[root]; c, ok = byNumber[root] {
		seen[root] = true
		root = *c.ReplyTo
	}
	inThread := map[int]bool{root: true}
	changed := true
	for changed {
		changed = false
		for _, c := range simCommentsByHead[id] {
			if c.ReplyTo != nil && inThread[*c.ReplyTo] && !inThread[c.Number] {
				inThread[c.Number] = true
				changed = true
			}
		}
	}
	for i := range simCommentsByHead[id] {
		if inThread[simCommentsByHead[id][i].Number] {
			simCommentsByHead[id][i].Resolved = ptr(body.Resolved)
		}
	}
	simCommentMu.Unlock()
	// A number that is not one of Hydra's own names a forge thread; the fixtures
	// number those from simThreadsResponse, so resolve it there.
	simThreads(id)
	simThreadMu.Lock()
	for i := range simThreadsByHead[id] {
		for _, n := range simThreadsByHead[id][i].Notes {
			if n.Number != nil && *n.Number == number {
				simThreadsByHead[id][i].Resolved = ptr(body.Resolved)
				simThreadsByHead[id][i].ResolvedLocally = ptr(body.Resolved)
			}
		}
	}
	simThreadMu.Unlock()
	api.WriteJSON(w, http.StatusOK, simCommentsResponse(id, nil))
}

func (s *SimulationServer) MarkReviewCommentsRead(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	var body api.MarkReadBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	want := map[int]bool{}
	if body.Numbers != nil {
		for _, n := range *body.Numbers {
			want[n] = true
		}
	}
	read := body.Unread == nil || !*body.Unread
	simComments(id)
	simCommentMu.Lock()
	for i := range simCommentsByHead[id] {
		if len(want) == 0 || want[simCommentsByHead[id][i].Number] {
			simCommentsByHead[id][i].Read = ptr(read)
		}
	}
	simCommentMu.Unlock()
	simThreads(id)
	simThreadMu.Lock()
	for i := range simThreadsByHead[id] {
		for j := range simThreadsByHead[id][i].Notes {
			n := &simThreadsByHead[id][i].Notes[j]
			if n.Number != nil && (len(want) == 0 || want[*n.Number]) {
				n.Read = ptr(read)
			}
		}
	}
	simThreadMu.Unlock()
	api.WriteJSON(w, http.StatusOK, simCommentsResponse(id, nil))
}

func (s *SimulationServer) PublishReviewComments(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	var body api.PublishReviewCommentsBody
	_ = json.NewDecoder(r.Body).Decode(&body)
	want := map[int]bool{}
	if body.Numbers != nil {
		for _, n := range *body.Numbers {
			want[n] = true
		}
	}
	simComments(id)
	var published []api.ReviewComment
	simCommentMu.Lock()
	for i := range simCommentsByHead[id] {
		c := &simCommentsByHead[id][i]
		if c.Status != api.Draft || (len(want) > 0 && !want[c.Number]) {
			continue
		}
		c.Status = api.Published
		c.PublishedAt = ptr(time.Now().Format(time.RFC3339))
		// Drafts are authored by the user, so publishing one cannot make it news
		// to that same user. Keep simulation behavior aligned with commentsResponse.
		c.Read = ptr(true)
		published = append(published, *c)
	}
	simCommentMu.Unlock()
	if len(published) == 0 {
		api.WriteJSON(w, http.StatusBadRequest, api.ErrorResponse{
			Code: 400, Error: api.ErrorResponseErrorBadRequest, Details: "there is nothing to publish",
		})
		return
	}
	// Mirror the real routing so the simulation shows both toasts: an @review
	// comment reports as having gone to the reviewer.
	resp := simCommentsResponse(id, ptr(simNotifyLine(published)))
	for _, c := range published {
		if strings.Contains(strings.ToLower(c.Body), "@review") {
			resp.NotifiedReviewer = ptr(true)
		}
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

// simNotifyLine mirrors reviewstore.NotifyLine: handles and locations only, never
// bodies - the property the real one exists to guarantee.
func simNotifyLine(published []api.ReviewComment) string {
	parts := make([]string, 0, len(published))
	for _, c := range published {
		if c.Path != nil && c.Line != nil {
			parts = append(parts, fmt.Sprintf("#%d [%s:%d](%s:%d)", c.Number, *c.Path, *c.Line, *c.Path, *c.Line))
		} else {
			parts = append(parts, fmt.Sprintf("#%d", c.Number))
		}
	}
	noun := "comments"
	if len(published) == 1 {
		noun = "comment"
	}
	return fmt.Sprintf("Review %s added: %s. Read them with the `mcp__hydra__get_review_comments` tool.",
		noun, strings.Join(parts, ", "))
}

func (s *SimulationServer) ArmMergeWhenGreen(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) DisarmMergeWhenGreen(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) GetAgentTests(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentTestsParams) {
	api.WriteJSON(w, http.StatusOK, api.TestsResponse{Runners: simTestRunners(id)})
}

// simTestLogURL mirrors the real server's testLogURL: an opaque (runner, key)
// URL a SETTLED runner hands out, which the "Show build log" toggle resolves.
// Without it a settled card's log button would sit permanently disabled in the
// simulation, which is not what a real settled run looks like.
func simTestLogURL(runner string) string {
	return "/api/projects/sim-project/tests/log?runner=" + runner + "&key=commit/a1b2c3d"
}

// HandleTestLog serves the persisted build log ({lines:[...]}) for a settled
// runner, mirroring the real server's hand-served route (Server.HandleTestLog).
// The failing runner resolves to a failing log, so the red-bordered terminal
// treatment is exercised too.
func (s *SimulationServer) HandleTestLog(w http.ResponseWriter, r *http.Request) {
	lines := []api.ArtifactLogLine{
		{Text: "$ go test ./... -json", Stream: api.Stdout},
		{Text: "ok  \tinternal/heads\t0.42s", Stream: api.Stdout},
		{Text: "ok  \tinternal/sandbox\t1.15s", Stream: api.Stdout},
		{Text: "ok  \tinternal/tests\t0.88s", Stream: api.Stdout},
	}
	if r.URL.Query().Get("runner") == "vitest" {
		lines = []api.ArtifactLogLine{
			{Text: "$ vitest run --reporter=junit", Stream: api.Stdout},
			{Text: " \u2713 diff/onion.test.ts (1)", Stream: api.Stdout},
			{Text: " \u2717 auth/rotation.test.ts (2 failed)", Stream: api.Stderr},
			{Text: "Test Files  1 failed | 12 passed (13)", Stream: api.Stderr},
		}
	}
	api.WriteJSON(w, http.StatusOK, struct {
		Lines []api.ArtifactLogLine `json:"lines"`
	}{Lines: lines})
}

// simTestRunners returns fixture test verdicts so --simulation and the
// tests-panel screenshot exercise both a clean run and a regression (PLAN #68).
func simTestRunners(id string) []api.TestRunResult {
	passing := api.TestRunResult{
		Name: "go", Status: api.TestStatusPassing,
		Total: ptr(152), Passed: ptr(145), Failed: ptr(0), Warnings: ptr(4), Skipped: ptr(3),
		DurationMs: ptr(int64(4200)), Format: ptr("junit"), Ref: ptr("a1b2c3d"), LogUrl: ptr(simTestLogURL("go")),
		// Non-failing warnings (e.g. eslint) surface amber alongside the green pass.
		// Structured locations (path + line/col + scope) exercise the CaseTree. The
		// two Go cases carry a `func TestXxx` subtest parent → ScopeKinds "function"
		// (a ƒ glyph), in contrast to the vitest describe blocks (module) below.
		Cases: &[]api.TestCase{
			{Name: "no-unused-vars", Status: api.TestCaseWarning, Path: ptr("web/src/DiffViewer.tsx"), Line: ptr(1742), Col: ptr(9), Message: ptr("'onionSkin' is assigned a value but never used  no-unused-vars")},
			{Name: "no-console", Status: api.TestCaseWarning, Path: ptr("web/src/lib/theme.ts"), Line: ptr(58), Col: ptr(3), Message: ptr("Unexpected console statement  no-console")},
			{Name: "golint", Status: api.TestCaseWarning, Path: ptr("internal/heads/heads.go"), Line: ptr(212), Message: ptr("exported func SpawnHead should have comment  golint")},
			{Name: "react-hooks/exhaustive-deps", Status: api.TestCaseWarning, Path: ptr("web/src/components/Badge.tsx"), Line: ptr(31), Col: ptr(6), Message: ptr("React Hook useMemo has a missing dependency  react-hooks/exhaustive-deps")},
			{Name: "commits all files", Status: api.TestCasePassed, Path: ptr("internal/git/commit_test.go"), Scope: ptr([]string{"TestListUncommittedFilesAndCommitAll"}), ScopeKinds: ptr([]string{"function"}), Line: ptr(42), DurationMs: ptr(int64(6))},
			{Name: "host allowed", Status: api.TestCasePassed, Path: ptr("internal/sandbox/net_test.go"), Scope: ptr([]string{"TestHostAllowed"}), ScopeKinds: ptr([]string{"function"}), Line: ptr(88), DurationMs: ptr(int64(2))},
			// PathMissing: the runner reported a file the checkout doesn't have (a
			// stale/renamed path). The CaseTree flags the file row amber and drops the
			// open-in-repo link - informational, it doesn't change the verdict.
			{Name: "parses legacy config", Status: api.TestCasePassed, Path: ptr("internal/config/legacy_test.go"), Scope: ptr([]string{"TestParseLegacy"}), ScopeKinds: ptr([]string{"function"}), Line: ptr(17), DurationMs: ptr(int64(1)), PathMissing: ptr(true)},
			// A JUnit runner reports dotted classnames (org.trolleyman.pocoapoco.db.CodesTest):
			// the lowercase package segments classify as "module" ({} braces) and the
			// PascalCase class segment as "class" (a box glyph), so the class stands out.
			{Name: "termKindMatchesMappings", Status: api.TestCasePassed, Scope: ptr([]string{"org", "trolleyman", "pocoapoco", "db", "CodesTest"}), ScopeKinds: ptr([]string{"module", "module", "module", "module", "class"}), DurationMs: ptr(int64(3))},
			{Name: "relationTypeMatchesMappings", Status: api.TestCasePassed, Scope: ptr([]string{"org", "trolleyman", "pocoapoco", "db", "CodesTest"}), ScopeKinds: ptr([]string{"module", "module", "module", "module", "class"}), DurationMs: ptr(int64(2))},
			{Name: "pastSubjunctiveRaAndSeMerge", Status: api.TestCasePassed, Scope: ptr([]string{"org", "trolleyman", "pocoapoco", "practice", "ConjugationDeckTest"}), ScopeKinds: ptr([]string{"module", "module", "module", "module", "class"}), DurationMs: ptr(int64(4))},
			{Name: "resumes on boot", Status: api.TestCaseSkipped, Path: ptr("heads/heads.test.ts"), Message: ptr("it.skip")},
		},
	}
	if id == "agent-2" {
		// A runner with a regression: two failing cases shown first.
		return []api.TestRunResult{{
			Name: "vitest", Status: api.TestStatusFailing,
			Total: ptr(147), Passed: ptr(142), Failed: ptr(2), Skipped: ptr(3),
			DurationMs: ptr(int64(4200)), Format: ptr("junit"), Ref: ptr("a1b2c3d"), LogUrl: ptr(simTestLogURL("vitest")),
			Cases: &[]api.TestCase{
				// Scope levels are vitest describe blocks → ScopeKinds "module".
				{Name: "rotates signing key on expiry", Status: api.TestCaseFailed, Path: ptr("auth/rotation.test.ts"), Scope: ptr([]string{"key rotation"}), ScopeKinds: ptr([]string{"module"}), Line: ptr(48), Col: ptr(24), DurationMs: ptr(int64(38)), Message: ptr("AssertionError: expected 'kid-2' to be 'kid-3'\n  at rotation.test.ts:48:24")},
				// This one's message carries ANSI, as a real runner's does (vitest
				// colours the error class red and dims the stack frame). It renders
				// through AnsiText, so the colour survives and the escape bytes never
				// reach the reader as literal "[0m[2m[35m" garbage. Keep it shaped like
				// a genuine assertion for THIS file - a command echo or a suite summary
				// belongs in the build log, not on a single case.
				{Name: "keeps old sessions valid in grace window", Status: api.TestCaseFailed, Path: ptr("auth/rotation.test.ts"), Scope: ptr([]string{"key rotation"}), ScopeKinds: ptr([]string{"module"}), Line: ptr(63), Col: ptr(11), DurationMs: ptr(int64(12)), Message: ptr("\x1b[31mTypeError\x1b[0m: \x1b[1mcurrentKid\x1b[0m is not a function\n  \x1b[2mat token-service.ts:21:14\x1b[0m\n  \x1b[2mat rotation.test.ts:63:11\x1b[0m")},
				{Name: "blends frames", Status: api.TestCasePassed, Path: ptr("diff/onion.test.ts"), Scope: ptr([]string{"onion skin"}), ScopeKinds: ptr([]string{"module"}), DurationMs: ptr(int64(5))},
				{Name: "resumes on boot", Status: api.TestCaseSkipped, Path: ptr("heads/heads.test.ts"), Message: ptr("it.skip")},
			},
		}}
	}
	if id == "agent-3" {
		// Running, no failures yet - matches agent-3's running verdict summary so the
		// panel and the sidebar/merge-gate agree (it backs the running gate dialog).
		return []api.TestRunResult{{
			Name: "go", Status: api.TestStatusRunning,
			Total: ptr(142), Passed: ptr(82), Failed: ptr(0), Skipped: ptr(0),
			StartedAt: ptr(simNow().Add(-9 * time.Second).Unix()), Progress: ptr("82/142"),
			Log: &[]api.ArtifactLogLine{
				{Text: "$ go test ./...", Stream: "stdout"},
				{Text: "ok  \tinternal/heads\t0.42s", Stream: "stdout"},
			},
		}}
	}
	if id == "agent-md" {
		// Three runs in flight, for the running-state screenshots. "go" declared a
		// ::hydra:test:total:: (142) so its bar is determinate (84/142); "eslint"
		// is a streamed run with NO declared total AND no prior run to estimate
		// from - tallies tick but there's no denominator - so its bar is the
		// indeterminate sliding barber pole. "playwright" also declared no total
		// but a prior run seeded an ESTIMATED denominator (shown as "~48"), so its
		// bar is determinate and the count reads 31/~48.
		return []api.TestRunResult{
			{
				Name: "go", Status: api.TestStatusRunning,
				Total: ptr(142), Passed: ptr(82), Failed: ptr(2), Skipped: ptr(0),
				StartedAt: ptr(simNow().Add(-12 * time.Second).Unix()), Progress: ptr("84/142"),
				Log: &[]api.ArtifactLogLine{
					{Text: "$ vitest run --reporter=dot", Stream: "stdout"},
					{Text: "✓ internal/heads/heads.test.ts (31)", Stream: "stdout"},
					{Text: "✗ auth/rotation.test.ts (2 failed)", Stream: "stderr"},
				},
			},
			{
				Name: "eslint", Status: api.TestStatusRunning,
				// No Total: a streamed runner that never declared ::hydra:test:total::,
				// so the panel shows a sliding barber pole instead of a fill percentage.
				Passed: ptr(213), Warnings: ptr(3),
				StartedAt: ptr(simNow().Add(-3 * time.Second).Unix()), Progress: ptr("216"),
				Log: &[]api.ArtifactLogLine{
					{Text: "$ eslint -f junit .", Stream: "stdout"},
					{Text: "web/src/DiffViewer.tsx", Stream: "stdout"},
					{Text: "  1742:9  warning  'onionSkin' is assigned a value but never used", Stream: "stdout"},
				},
			},
			{
				// QUEUED, not running: test concurrency defaults to 1, so a project with
				// several runners normally has some of them waiting rather than running.
				// A run is marked in-flight before it takes a slot, so this looked
				// exactly like a running one - and its clock read as time spent testing.
				Name: "e2e", Status: api.TestStatusRunning,
				Queued: ptr(2), StartedAt: ptr(simNow().Add(-95 * time.Second).Unix()),
			},
			{
				Name: "playwright", Status: api.TestStatusRunning,
				// No declared ::hydra:test:total::, but a prior run seeded an ESTIMATED
				// denominator (48). TotalEstimated flags it approximate → the panel shows
				// a determinate bar and the count reads "31/~48".
				Total: ptr(48), TotalEstimated: ptr(true), Passed: ptr(31), Failed: ptr(0),
				StartedAt: ptr(simNow().Add(-6 * time.Second).Unix()), Progress: ptr("31/~48"),
				Log: &[]api.ArtifactLogLine{
					{Text: "$ playwright test", Stream: "stdout"},
					{Text: "Running 48 tests using 4 workers", Stream: "stdout"},
					{Text: "  ✓ e2e/login.spec.ts:12:3 › signs in", Stream: "stdout"},
				},
			},
		}
	}
	return []api.TestRunResult{passing}
}

// simTestSummary returns the compact chip verdict for a sim agent, matching
// simTestRunners so the sidebar chip and the panel agree.
func simTestSummary(id string) *api.TestSummary {
	switch id {
	case "agent-2":
		return &api.TestSummary{Status: api.TestStatusFailing, Total: ptr(147), Passed: ptr(142), Failed: ptr(2), Skipped: ptr(3), DurationMs: ptr(int64(4200))}
	case "agent-md":
		return &api.TestSummary{Status: api.TestStatusRunning, Total: ptr(142), Passed: ptr(82), Failed: ptr(2), Progress: ptr("84/142")}
	case "agent-1":
		return &api.TestSummary{Status: api.TestStatusPassing, Total: ptr(151), Passed: ptr(144), Warnings: ptr(4), Skipped: ptr(3), DurationMs: ptr(int64(4200))}
	case "agent-queued":
		// Tests already green, so the merge-when-green queue is waiting purely on the
		// agent (which is at needs_input) - what merge-queued-tooltip demonstrates.
		return &api.TestSummary{Status: api.TestStatusPassing, Total: ptr(88), Passed: ptr(88), DurationMs: ptr(int64(2600))}
	case "agent-3":
		// Running but NOT armed (unlike agent-md), so its Merge button opens the
		// "tests still running" merge-gate dialog (Merge now / Queue merge).
		return &api.TestSummary{Status: api.TestStatusRunning, Total: ptr(142), Passed: ptr(82), Failed: ptr(0), Progress: ptr("84/142")}
	case "agent-approval":
		// A cached verdict that predates the current commit → the gray dashed
		// "stale" chip. Gives the sidebar coverage of the stale state (its chip
		// height must match the other verdict/status chips in the row).
		return &api.TestSummary{Status: api.TestStatusStale, Total: ptr(142), Passed: ptr(140), Skipped: ptr(2), DurationMs: ptr(int64(3900))}
	case "project-directory-edit":
		return &api.TestSummary{Status: api.TestStatusPassing, Total: ptr(96), Passed: ptr(96), DurationMs: ptr(int64(2100))}
	case "project-directory-readonly":
		return &api.TestSummary{Status: api.TestStatusStale, Total: ptr(96), Passed: ptr(94), Skipped: ptr(2), DurationMs: ptr(int64(2050))}
	case "project-directory-working":
		return &api.TestSummary{Status: api.TestStatusRunning, Total: ptr(96), Passed: ptr(61), Progress: ptr("61/96")}
	default:
		return nil
	}
}

func (s *SimulationServer) MarkAgentRead(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) MarkAgentUnread(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

// GenerateAgentTitle fakes the title model with a fixed answer, after a short
// delay so the button's in-flight state is actually visible in the simulator.
func (s *SimulationServer) GenerateAgentTitle(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	time.Sleep(1500 * time.Millisecond)
	api.WriteJSON(w, http.StatusOK, api.GeneratedTitleResponse{Title: "Simulated generated title"})
}

func (s *SimulationServer) UpdateAgentFromBase(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	w.WriteHeader(http.StatusNoContent)
}

func (s *SimulationServer) GetAgentCommits(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	if id == "agent-1" {
		resp := api.GetAgentCommits200JSONResponse{
			{
				// A deliberately HUGE message: taller than any viewport, so the
				// hover card's height cap has to bite and the card has to scroll
				// rather than run off the screen. Also the only fixture with
				// nested lists, a fenced block and a table in a commit message.
				Sha:       "9f8e7d6c5b4a39281706fedcba9876543210abcd",
				ShortSha:  "9f8e7d6",
				ParentSha: ptr("abcd1234efgh5678ijkl9012mnop3456qrst7890"),
				Subject:   ptr("Rework the artifact pipeline end to end"),
				Message: "Rework the artifact pipeline end to end\n\n" +
					"The generator, the uploader and the viewer each had their own\n" +
					"idea of what an artifact was, so a run could produce a file the\n" +
					"viewer refused to show and the uploader happily stored. They\n" +
					"now share one manifest, written once by the generator and\n" +
					"treated as read-only downstream.\n\n" +
					"What moved:\n\n" +
					"- `internal/artifacts/manifest.go` is new and owns the schema.\n" +
					"  Every producer writes through it; nothing else constructs a\n" +
					"  manifest literal any more.\n" +
					"  - The `kind` field is a closed set (`image`, `log`, `server`)\n" +
					"    rather than a free string, so an unknown kind is a load\n" +
					"    error instead of a blank card three screens later.\n" +
					"  - Dimensions are recorded at generation time. The viewer used\n" +
					"    to decode every PNG just to lay out a grid.\n" +
					"- `internal/artifacts/upload.go` retries transport errors and\n" +
					"  5xx with a jittered exponential backoff, and gives up loudly.\n" +
					"- The viewer reads the manifest and nothing else. It no longer\n" +
					"  stats the directory, which is what made a half-written run\n" +
					"  render as a wall of broken tiles.\n\n" +
					"```go\n" +
					"// The one constructor. Everything else is a method on it.\n" +
					"m, err := artifacts.NewManifest(runID, artifacts.KindImage)\n" +
					"if err != nil {\n" +
					"\treturn errtrace.Wrap(err)\n" +
					"}\n" +
					"```\n\n" +
					"| Stage     | Before            | After                |\n" +
					"| --------- | ----------------- | -------------------- |\n" +
					"| Generate  | ad-hoc JSON       | `NewManifest`        |\n" +
					"| Upload    | fail on first 5xx | 5 tries, jittered    |\n" +
					"| View      | stat the dir      | read the manifest    |\n\n" +
					"Migration: an old run has no manifest, so the loader synthesises\n" +
					"one from the directory listing the first time it is opened and\n" +
					"writes it back. That path is deliberately lossy - it cannot\n" +
					"recover the tags a run was generated with - and it will be\n" +
					"removed once no live project has a pre-manifest run left.\n\n" +
					"Not done here, on purpose:\n\n" +
					"- Per-artifact retention. The manifest has the field, nothing\n" +
					"  reads it yet, and the sweeper is its own change.\n" +
					"- Content-addressed storage. Tempting, and it would kill the\n" +
					"  duplicate screenshots entirely, but it changes the on-disk\n" +
					"  layout for every existing project at once.\n\n" +
					"Design decision (no user input): the synthesised manifest is\n" +
					"written back rather than kept in memory, so the lossy path runs\n" +
					"once per run instead of once per page load. It means opening an\n" +
					"old run mutates its directory, which is worth saying out loud.",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-5 * time.Minute).Format(time.RFC3339),
			},
			{
				// A long, hard-wrapped, bulleted message - the shape agents
				// actually write. It is what exercises the commit hover card in
				// the selectors: markdown body, paragraph reflow (no <br> per
				// wrapped line) and the height cap that makes a tall card scroll
				// instead of running off the bottom of the screen.
				Sha:       "abcd1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:  "abcd123",
				ParentSha: ptr("bcde1234efgh5678ijkl9012mnop3456qrst7890"),
				Subject:   ptr("Add feature X"),
				Message: "Add feature X\n\n" +
					"The uploader had no way to express \"retry this, but not\n" +
					"forever\", so a flaky object store took the whole run down with\n" +
					"it. `Put` now retries a failed upload up to `maxAttempts`\n" +
					"times, sleeping a jittered exponential delay between tries.\n\n" +
					"- The delay is 100ms doubled per attempt, +/- 50% jitter, so a\n" +
					"  fleet of heads retrying at once does not synchronise into a\n" +
					"  thundering herd.\n" +
					"- Only transport errors and 5xx are retried; a 4xx is the\n" +
					"  caller's bug and fails immediately.\n" +
					"- The last error is surfaced once every attempt is exhausted,\n" +
					"  rather than a generic \"upload failed\".\n\n" +
					"Design decision (no user input): the cap lives on the uploader\n" +
					"rather than in config - callers that want a different budget\n" +
					"already pass a context deadline, and two knobs for one\n" +
					"behaviour is how they end up disagreeing.",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-10 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "bcde1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "bcde123",
				ParentSha:   ptr("cdef1234efgh5678ijkl9012mnop3456qrst7890"),
				Subject:     ptr("Fix bug Y"),
				Message:     "Fix bug Y",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-20 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "cdef1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "cdef123",
				ParentSha:   ptr("defg1234efgh5678ijkl9012mnop3456qrst7890"),
				Subject:     ptr("Refactor Z"),
				Message:     "Refactor Z",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   simNow().Add(-30 * time.Minute).Format(time.RFC3339),
			},
			{
				Sha:         "defg1234efgh5678ijkl9012mnop3456qrst7890",
				ShortSha:    "defg123",
				ParentSha:   ptr("0123456789abcdef0123456789abcdef01234567"),
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
	// agent-chat: current branch history after the later commit was amended. The
	// canned conversation retains both chronological chips, while this selector
	// inventory exposes only the replacement SHA.
	if id == "agent-chat" {
		resp := api.GetAgentCommits200JSONResponse{
			{
				Sha:         "a11e0ded0123456789abcdef0123456789abcdef",
				ShortSha:    "a11e0de",
				ParentSha:   ptr("cafebabe0123456789abcdef0123456789abcdef"),
				Subject:     ptr("Cover uploader exhaustion and retry paths"),
				Message:     "Cover uploader exhaustion and retry paths",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   "2026-07-09T18:05:33Z",
				Additions:   52,
				Deletions:   9,
			},
			{
				Sha:         "cafebabe0123456789abcdef0123456789abcdef",
				ShortSha:    "cafebab",
				ParentSha:   ptr("0123456789abcdef0123456789abcdef01234567"),
				Subject:     ptr("Add jittered backoff helper to the uploader"),
				Message:     "Add jittered backoff helper to the uploader\n\nBase 100ms, doubled per attempt, +/- 50% jitter, capped at 5 attempts.",
				AuthorName:  "Agent Claude",
				AuthorEmail: "claude@hydra.ai",
				Timestamp:   "2026-07-09T18:01:30Z",
				Additions:   34,
				Deletions:   6,
			},
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	api.WriteJSON(w, http.StatusOK, api.GetAgentCommits200JSONResponse{})
}

func (s *SimulationServer) GetAgentDiff(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentDiffParams) {
	if id == "agent-2" {
		// Mock uncommitted changes + a branch that trails its base, so agent-2's
		// Changes toolbar shows the "behind" button and the redesigned
		// update-from-base dialog (captured by `agent-update-base-dialog`). With
		// uncommitted changes present, that dialog also surfaces its caution note.
		uncommitted := true
		behind := 3
		resp := api.DiffResponse{
			BaseRef:            "main",
			HeadRef:            "hydra/feat-2",
			BehindCount:        &behind,
			UncommittedChanges: &uncommitted,
			UncommittedSummary: simUncommittedSummary(),
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
				// Extension-less scripts: the language comes from the `#!` line,
				// so these exercise the shebang fallback in getLanguage (python
				// and bash respectively).
				{
					Path:       "scripts/release",
					ChangeType: api.DiffFileChangeTypeAdded,
					Additions:  6,
					Deletions:  0,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -0,0 +1,6 @@",
							OldStart: 0,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Addition, Content: "#!/usr/bin/env python3", NewLineNum: ptr(1)},
								{Type: api.Addition, Content: "import subprocess", NewLineNum: ptr(2)},
								{Type: api.Addition, Content: "", NewLineNum: ptr(3)},
								{Type: api.Addition, Content: "def main() -> None:", NewLineNum: ptr(4)},
								{Type: api.Addition, Content: "    \"\"\"Tag and push the release.\"\"\"", NewLineNum: ptr(5)},
								{Type: api.Addition, Content: "    subprocess.run([\"git\", \"tag\", \"v1.0\"], check=True)", NewLineNum: ptr(6)},
							},
						},
					},
				},
				{
					Path:       "hooks/pre-commit",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  1,
					Deletions:  1,
					Hunks: []api.DiffHunk{
						{
							Header:   "@@ -1,5 +1,5 @@",
							OldStart: 1,
							NewStart: 1,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "#!/bin/sh -e", OldLineNum: ptr(1), NewLineNum: ptr(1)},
								{Type: api.Context, Content: "# Refuse a commit that leaves the tree dirty.", OldLineNum: ptr(2), NewLineNum: ptr(2)},
								{Type: api.Deletion, Content: "if [ -n \"$(git status --porcelain)\" ]; then", OldLineNum: ptr(3)},
								{Type: api.Addition, Content: "if [ -n \"$(git status --porcelain --untracked-files=no)\" ]; then", NewLineNum: ptr(3)},
								{Type: api.Context, Content: "  echo \"tree is dirty\" >&2", OldLineNum: ptr(4), NewLineNum: ptr(4)},
								{Type: api.Context, Content: "  exit 1", OldLineNum: ptr(5), NewLineNum: ptr(5)},
								{Type: api.Context, Content: "fi", OldLineNum: ptr(6), NewLineNum: ptr(6)},
							},
						},
					},
				},
			},
		}
		resp.Files = simApplyContext(resp.Files, params)
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
						{
							// Pure re-indent: the body moved one tab deeper when it was
							// wrapped in a loop. Exercises the word diff's whitespace
							// handling - only the added tab should light up, not the
							// whole indent.
							Header:   "@@ -92,6 +96,7 @@ func (s *SimulationServer) simDiff(...) {",
							OldStart: 92,
							NewStart: 96,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "\tfiles := make([]api.DiffFile, 0, 8)", OldLineNum: ptr(92), NewLineNum: ptr(96)},
								{Type: api.Addition, Content: "\tfor _, hunk := range hunks {", NewLineNum: ptr(97)},
								{Type: api.Deletion, Content: "\tstat := statFor(hunk)", OldLineNum: ptr(93)},
								{Type: api.Deletion, Content: "\tif stat.Additions > 0 {", OldLineNum: ptr(94)},
								{Type: api.Deletion, Content: "\t\tfiles = append(files, fileFor(hunk, stat))", OldLineNum: ptr(95)},
								{Type: api.Deletion, Content: "\t}", OldLineNum: ptr(96)},
								{Type: api.Addition, Content: "\t\tstat := statFor(hunk)", NewLineNum: ptr(98)},
								{Type: api.Addition, Content: "\t\tif stat.Additions > 0 {", NewLineNum: ptr(99)},
								{Type: api.Addition, Content: "\t\t\tfiles = append(files, fileFor(hunk, stat))", NewLineNum: ptr(100)},
								{Type: api.Addition, Content: "\t\t}", NewLineNum: ptr(101)},
								{Type: api.Addition, Content: "\t}", NewLineNum: ptr(102)},
								{Type: api.Context, Content: "\treturn files", OldLineNum: ptr(97), NewLineNum: ptr(103)},
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
					Path:       "web/src/lib/handlers.ts",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  4,
					Deletions:  4,
					Hunks: []api.DiffHunk{
						{
							// Intra-line word diff: character granularity + camelCase/snake_case
							// boundary snapping. getUserName->getUserId lights only the changed
							// subword; handleClick->handleClose snaps to "Click"/"Close" (not
							// "lick"/"lose"); counter->pointer stays the precise "cou"/"poi".
							Header:   "@@ -12,6 +12,6 @@ export function wire(el: HTMLElement) {",
							OldStart: 12,
							NewStart: 12,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "export function wire(el: HTMLElement) {", OldLineNum: ptr(12), NewLineNum: ptr(12)},
								{Type: api.Deletion, Content: "  const id = getUserName()", OldLineNum: ptr(13)},
								{Type: api.Addition, Content: "  const id = getUserId()", NewLineNum: ptr(13)},
								{Type: api.Deletion, Content: "  el.addEventListener(\"click\", handleClick)", OldLineNum: ptr(14)},
								{Type: api.Addition, Content: "  el.addEventListener(\"click\", handleClose)", NewLineNum: ptr(14)},
								{Type: api.Deletion, Content: "  register(handle_click)", OldLineNum: ptr(15)},
								{Type: api.Addition, Content: "  register(handle_close)", NewLineNum: ptr(15)},
								{Type: api.Deletion, Content: "  let counter = MAX_CELLS", OldLineNum: ptr(16)},
								{Type: api.Addition, Content: "  let pointer = MAX_LINES", NewLineNum: ptr(16)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(17), NewLineNum: ptr(17)},
							},
						},
					},
				},
				{
					Path:       "internal/config/defaults.go",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  3,
					Deletions:  3,
					Hunks: []api.DiffHunk{
						{
							// Internal realignment: only the spacing around "=" changed. Not a move
							// (leading indent is unchanged, inner spaces differ), so these rows dim
							// as whitespace-only rather than reading as real edits.
							Header:   "@@ -8,5 +8,5 @@ var Defaults = Config{",
							OldStart: 8,
							NewStart: 8,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "var Defaults = Config{", OldLineNum: ptr(8), NewLineNum: ptr(8)},
								{Type: api.Deletion, Content: "	Host        = \"localhost\"", OldLineNum: ptr(9)},
								{Type: api.Deletion, Content: "	Port = 8080", OldLineNum: ptr(10)},
								{Type: api.Deletion, Content: "	ReadTimeout   = 30", OldLineNum: ptr(11)},
								{Type: api.Addition, Content: "	Host = \"localhost\"", NewLineNum: ptr(9)},
								{Type: api.Addition, Content: "	Port        = 8080", NewLineNum: ptr(10)},
								{Type: api.Addition, Content: "	ReadTimeout = 30", NewLineNum: ptr(11)},
								{Type: api.Context, Content: "}", OldLineNum: ptr(12), NewLineNum: ptr(12)},
							},
						},
					},
				},
				{
					Path:       "web/src/components/AgentChat.tsx",
					ChangeType: api.DiffFileChangeTypeModified,
					Additions:  19,
					Deletions:  9,
					// The real file's length. It is what lets the windowed view below
					// count the run under its last hunk (the server sends it from the
					// full read it does anyway), and here it also sizes the tail
					// simReconstructFull fabricates when this file is promoted.
					TotalLines: ptr(11038),
					Hunks: []api.DiffHunk{
						{
							// A realistic modify deep in a large file (a scroll-pin rewrite ~line
							// 6644): high line numbers, a comment-heavy block replacement, and lots
							// of intra-line word highlights (40 -> 4, < -> <=, nearBottom -> atBottom).
							Header:   "@@ -6644,13 +6647,23 @@ const onScroll = useCallback((el: HTMLElement) => {",
							OldStart: 6644,
							NewStart: 6647,
							Lines: []api.DiffLine{
								{Type: api.Context, Content: "		if (el.scrollTop < 300 && chatView === 'main') requestOlderHistory()", OldLineNum: ptr(6644), NewLineNum: ptr(6647)},
								{Type: api.Deletion, Content: "		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40", OldLineNum: ptr(6645)},
								{Type: api.Deletion, Content: "		// While pinned, content can grow FASTER than the follow effects re-pin (a", OldLineNum: ptr(6646)},
								{Type: api.Deletion, Content: "		// card expanding a tall clamped panel adds >40px between frames), so a", OldLineNum: ptr(6647)},
								{Type: api.Deletion, Content: "		// momentarily large gap must not read as \"the user scrolled away\" - that", OldLineNum: ptr(6648)},
								{Type: api.Deletion, Content: "		// froze the follow mid-expansion. Only an UPWARD move unpins; any", OldLineNum: ptr(6649)},
								{Type: api.Deletion, Content: "		// downward/stationary scroll keeps the pin, and reaching the bottom", OldLineNum: ptr(6650)},
								{Type: api.Deletion, Content: "		// (re)pins regardless.", OldLineNum: ptr(6651)},
								{Type: api.Deletion, Content: "		const scrolledUp = el.scrollTop < prevScrollTopRef.current - 1", OldLineNum: ptr(6652)},
								{Type: api.Addition, Content: "		// Re-ACQUIRING the pin needs the view actually AT the bottom (a few px of", NewLineNum: ptr(6648)},
								{Type: api.Addition, Content: "		// sub-pixel slack), not merely \"within 40px\". The old 40px band re-pinned on", NewLineNum: ptr(6649)},
								{Type: api.Addition, Content: "		// any non-upward scroll event while near the bottom, so a small macOS", NewLineNum: ptr(6650)},
								{Type: api.Addition, Content: "		// trackpad nudge unpinned on its own event but the very next settling event", NewLineNum: ptr(6651)},
								{Type: api.Addition, Content: "		// (still inside the band, no further upward move) slammed the pin straight", NewLineNum: ptr(6652)},
								{Type: api.Addition, Content: "		// back on - the reported \"stuck at the bottom\" bug.", NewLineNum: ptr(6653)},
								{Type: api.Addition, Content: "		const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 4", NewLineNum: ptr(6654)},
								{Type: api.Addition, Content: "		// Only a genuine UPWARD user move unpins. A content SHRINK (a card", NewLineNum: ptr(6655)},
								{Type: api.Addition, Content: "		// collapsing, a streamed block replaced by something shorter) clamps", NewLineNum: ptr(6656)},
								{Type: api.Addition, Content: "		// scrollTop down on its own, so don't misread that as a scroll-up.", NewLineNum: ptr(6657)},
								{Type: api.Addition, Content: "		const shrank = el.scrollHeight < prevScrollHeightRef.current - 1", NewLineNum: ptr(6658)},
								{Type: api.Addition, Content: "		const scrolledUp = !shrank && el.scrollTop < prevScrollTopRef.current - 1", NewLineNum: ptr(6659)},
								{Type: api.Context, Content: "		prevScrollTopRef.current = el.scrollTop", OldLineNum: ptr(6653), NewLineNum: ptr(6660)},
								{Type: api.Deletion, Content: "		const pin = nearBottom || (pinnedRef.current && !scrolledUp)", OldLineNum: ptr(6654)},
								{Type: api.Addition, Content: "		prevScrollHeightRef.current = el.scrollHeight", NewLineNum: ptr(6661)},
								{Type: api.Addition, Content: "		// Unpin on an upward move; otherwise HOLD the pin if we already had it, and", NewLineNum: ptr(6662)},
								{Type: api.Addition, Content: "		// (re)acquire it only on reaching the bottom. Holding via pinnedRef is what", NewLineNum: ptr(6663)},
								{Type: api.Addition, Content: "		// keeps content growing faster than the follow effects re-pin (a card", NewLineNum: ptr(6664)},
								{Type: api.Addition, Content: "		// mid-expansion opening a >40px gap for a frame) from reading as \"scrolled\",", NewLineNum: ptr(6665)},
								{Type: api.Addition, Content: "		// away\" - scrolledUp is false there, so the pin holds.", NewLineNum: ptr(6666)},
								{Type: api.Addition, Content: "		const pin = scrolledUp ? false : (pinnedRef.current || atBottom)", NewLineNum: ptr(6667)},
								{Type: api.Context, Content: "		pinnedRef.current = pin", OldLineNum: ptr(6655), NewLineNum: ptr(6668)},
								{Type: api.Context, Content: "		setPinned(pin)", OldLineNum: ptr(6656), NewLineNum: ptr(6669)},
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
				// Deliberately long path: exercises sidebar filename truncation
				// and the right-aligned add/del counts.
				simFile(
					"internal/app/services/notifications/providers/webhooks/outbound/delivery_retry_scheduler_with_exponential_backoff.go",
					api.DiffFileChangeTypeAdded, 1024, 0,
					"@@ -0,0 +1,3 @@", 0, 1,
					api.DiffLine{Type: api.Addition, Content: "package webhooks", NewLineNum: ptr(1)},
					api.DiffLine{Type: api.Addition, Content: "", NewLineNum: ptr(2)},
					api.DiffLine{Type: api.Addition, Content: "// DeliveryRetryScheduler retries failed webhook deliveries.", NewLineNum: ptr(3)},
				),
			},
		}
		resp.Files = simApplyContext(resp.Files, params)
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
		//                                      branch folds independently - auth's
		//                                      chain stops at `google` because it
		//                                      holds two files.
		//   - web/src/{index.ts,components/...}  `web` folds into `src`, but `src`
		//                                      holds a file AND a folder so the
		//                                      chain stops there (no over-merging).
		// agent-3 also conflicts with its base branch, so its diff carries the
		// merge-conflict flag + the offending file. This surfaces the redesigned
		// merge-conflict panel (DiffViewer.tsx → MergeConflictButton) in the Changes
		// toolbar and is captured by the `merge-conflict-dialog` screenshot.
		mergeConflict := true
		conflictFiles := []string{"internal/app/services/billing/stripe/webhook.go"}
		resp := api.DiffResponse{
			BaseRef:       "main",
			HeadRef:       "hydra/feat-3",
			MergeConflict: &mergeConflict,
			ConflictFiles: &conflictFiles,
			Files: []api.DiffFile{
				simFile("README.md", api.DiffFileChangeTypeModified, 3, 0,
					"@@ -1,2 +1,5 @@", 1, 1,
					api.DiffLine{Type: api.Context, Content: "# Hydra", OldLineNum: ptr(1), NewLineNum: ptr(1)},
					api.DiffLine{Type: api.Addition, Content: "Now with deeply nested auth providers.", NewLineNum: ptr(2)},
					// A deliberately long line to exercise the unified diff's soft
					// wrapping (whitespace-pre-wrap) on narrow / mobile viewports -
					// it should reflow across several rows rather than overflow.
					api.DiffLine{Type: api.Addition, Content: "This intentionally very long line verifies that the diff viewer wraps prose gracefully on small screens instead of forcing a horizontal scrollbar: lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.", NewLineNum: ptr(3)},
					// A long unbroken token to exercise break-words (a URL/path with
					// no spaces must still hard-break rather than overflow).
					api.DiffLine{Type: api.Addition, Content: "See https://example.com/internal/app/services/auth/providers/oauth/google/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/client.go", NewLineNum: ptr(4)},
					api.DiffLine{Type: api.Context, Content: "", OldLineNum: ptr(2), NewLineNum: ptr(5)},
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
		resp.Files = simApplyContext(resp.Files, params)
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
// ?context=5000000) allocates millions of DiffLines - each with a heap string
// and two heap *int - across every hunk, ballooning RSS into the gigabytes (a
// single large request OOM-kills the process). The mock diffs are tiny and the
// UI only ever asks for gapSize/2 (tens of lines), so this ceiling is far above
// any legitimate request while keeping a hostile/buggy one cheap.
const maxSimContext = 1000

func simContext(params api.GetAgentDiffParams) int {
	if params.Context != nil {
		return min(*params.Context, maxSimContext)
	}
	return 3
}

// simApplyContext renders a fixture diff at the requested context. For a
// full_context request it reconstructs each file as a single contiguous
// whole-file hunk (mirroring `git diff -U<huge>` in production) so the diff
// viewer drives its full-content reveal model - compact, with "··· N lines ···"
// collapses and no fabricated edge arrows. Otherwise it just widens each hunk's
// surrounding context (network-expand on demand).
// The cap is the caller's max_full_lines, so the simulation reproduces both
// sides of the real server's behaviour: the bulk request (6000) leaves a change
// deep in a big file windowed, and the client's on-demand single-file promotion
// (a much larger cap) expands that same file.
func simApplyContext(files []api.DiffFile, params api.GetAgentDiffParams) []api.DiffFile {
	if params.FullContext != nil && *params.FullContext {
		maxFullLines := 6000
		if params.MaxFullLines != nil {
			maxFullLines = *params.MaxFullLines
		}
		out := make([]api.DiffFile, len(files))
		for i, f := range files {
			out[i] = simReconstructFull(f, maxFullLines)
		}
		return simStampBlobSHAs(out)
	}
	return simStampBlobSHAs(expandDiffContext(files, simContext(params)))
}

// simStampBlobSHAs gives each non-deleted fixture file a deterministic fake
// head-side blob sha (derived from its path + line counts) so the real server's
// per-file "viewed" state has something to key on in the simulation.
func simStampBlobSHAs(files []api.DiffFile) []api.DiffFile {
	for i := range files {
		if files[i].ChangeType == api.DiffFileChangeTypeDeleted {
			continue
		}
		h := fnv.New64a()
		fmt.Fprintf(h, "%s:%d:%d", files[i].Path, files[i].Additions, files[i].Deletions)
		sha := fmt.Sprintf("%016x%016x%08x", h.Sum64(), h.Sum64()*0x9e3779b1, files[i].Additions&0xffffffff)
		files[i].HeadBlobSha = &sha
	}
	return files
}

// simReconstructFull rebuilds a fixture file as one contiguous whole-file hunk
// spanning line 1 through its last real line, filling the unchanged gaps before
// and between its hunks with synthetic context lines. The result looks like a
// full-context diff of a real file, so the viewer collapses the unchanged runs
// itself (rather than us shipping a long fabricated tail). Files are marked
// Expanded; binary / hunkless files pass through untouched.
//
// Line numbers are recomputed from the line types rather than trusting the
// fixtures' stated numbers: the hand-written fixtures don't always keep the
// old/new offset consistent across hunks, and any inconsistency would make the
// reconstructed content non-contiguous - which the client rejects, falling back
// to rendering the whole thing uncollapsed (a wall of synthetic lines). The old
// side stays the source of truth for gap sizing (it's monotonic in the
// fixtures); new line numbers are derived so the result is always a valid,
// contiguous diff.
func simReconstructFull(f api.DiffFile, maxFullLines int) api.DiffFile {
	if f.Binary || len(f.Hunks) == 0 {
		return f
	}
	// A change deeper into the file than the cap can only reconstruct to more
	// lines than the cap allows, so skip the work. The exact rule (reconstructed
	// length vs the cap, as the real server applies it) is checked below.
	if last := f.Hunks[len(f.Hunks)-1]; last.OldStart > maxFullLines || last.NewStart > maxFullLines {
		return f
	}
	ext := ""
	if parts := strings.Split(f.Path, "."); len(parts) > 1 {
		ext = parts[len(parts)-1]
	}
	var lines []api.DiffLine
	oldN, newN := 1, 1
	for _, h := range f.Hunks {
		// Fill the unchanged region before this hunk (sized by the old side); it's
		// identical on both sides, so old and new advance together.
		for gap := h.OldStart - oldN; gap > 0; gap-- {
			lines = append(lines, synthContextLine(ext, oldN, newN))
			oldN++
			newN++
		}
		// Re-emit the hunk's lines, renumbering by type so the whole file stays a
		// self-consistent, contiguous diff regardless of the fixture's numbers.
		for _, l := range h.Lines {
			nl := api.DiffLine{Type: l.Type, Content: l.Content}
			switch l.Type {
			case api.Deletion:
				nl.OldLineNum = ptr(oldN)
				oldN++
			case api.Addition:
				nl.NewLineNum = ptr(newN)
				newN++
			case api.Context:
				nl.OldLineNum, nl.NewLineNum = ptr(oldN), ptr(newN)
				oldN++
				newN++
			default:
				nl.OldLineNum, nl.NewLineNum = l.OldLineNum, l.NewLineNum
			}
			lines = append(lines, nl)
		}
	}
	// A fixture that states its length gets the rest of the file too, so a promoted
	// file ends where it says it ends and its trailing gap is the one the windowed
	// view was counting down to.
	if f.TotalLines != nil {
		// Counted on the head side, as TotalLines is.
		for ; newN <= *f.TotalLines; oldN, newN = oldN+1, newN+1 {
			lines = append(lines, synthContextLine(ext, oldN, newN))
		}
	}
	// The real server drops the expanded version when it blew past the cap (a few
	// changed lines scattered through a long file) and keeps the windowed hunks.
	if len(lines) > maxFullLines {
		return f
	}
	f.Hunks = []api.DiffHunk{{Header: f.Hunks[0].Header, OldStart: 1, NewStart: 1, Lines: lines}}
	f.Expanded = ptr(true)
	return f
}

func synthContextLine(ext string, oldN, newN int) api.DiffLine {
	return api.DiffLine{
		Type:       api.Context,
		Content:    fmt.Sprintf("// context line %d", oldN),
		OldLineNum: ptr(oldN),
		NewLineNum: ptr(newN),
	}
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
				{Path: "internal/app/services/notifications/providers/webhooks/outbound/delivery_retry_scheduler_with_exponential_backoff.go", ChangeType: api.DiffFileChangeTypeAdded, Additions: 1024, Deletions: 0},
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
			UncommittedSummary: simUncommittedSummary(),
			Files:              []api.DiffFile{},
		}
		if params.IncludeUncommitted != nil && *params.IncludeUncommitted {
			resp.Files = []api.DiffFile{
				{Path: "README.md", ChangeType: api.DiffFileChangeTypeModified, Additions: 2, Deletions: 1},
				{Path: "new_file.txt", ChangeType: api.DiffFileChangeTypeAdded, Additions: 1, Deletions: 0},
				{Path: "scripts/release", ChangeType: api.DiffFileChangeTypeAdded, Additions: 6, Deletions: 0},
				{Path: "hooks/pre-commit", ChangeType: api.DiffFileChangeTypeModified, Additions: 1, Deletions: 1},
			}
		}
		api.WriteJSON(w, http.StatusOK, resp)
		return
	}
	api.WriteJSON(w, http.StatusOK, api.DiffResponse{Files: []api.DiffFile{}})
}

// How much bigger the resolution a simulated artifact REPORTS (its Width/Height
// metadata - see simReadyChangedSet) is than the box its placeholder is drawn in.
// Every simulated file declares exactly this multiple, so scaling the SVG by it
// makes the file's own intrinsic size agree with what the API says about it, the
// way a real capture's does.
//
// That agreement matters to more than tidiness: the lightbox reserves a picture's
// box from the declared size before the file loads (see LightboxItem.width), so a
// placeholder that declared 1440x880 and then turned out to be a 360x220 vector
// laid out four times too big for a frame and snapped down - a pop-in visible
// only in simulation, and only because the two disagreed.
//
// The drawing itself is untouched: the coordinates below stay in the small box and
// a viewBox scales the whole vector onto the declared one, so every tile renders
// exactly as it did (a tile's size comes from its column width and the metadata's
// aspect ratio, neither of which moves).
const simArtifactScale = 4

// simSVGDoc wraps one placeholder's markup (drawn in w×h coordinates) as a
// data-URL SVG that DECLARES simArtifactScale×(w×h) - see simArtifactScale.
// The two cache keys the simulated artifact sets compare: a "before" commit and
// an "after" one. Real keys are "commit/<sha>" or "worktree/<content-hash>" (see
// internal/artifacts.versionKey); these are the same shape, so anything reading a
// key - the review pin's anchor, which reports WHICH COMMIT a picture was
// rendered from - behaves here exactly as it does against a real project.
const (
	simKeyLeft  = "commit/aaaa"
	simKeyRight = "commit/bbbb"
)

func simSVGDoc(body string, w, h int) string {
	doc := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">%s</svg>`,
		w*simArtifactScale, h*simArtifactScale, w, h, body)
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(doc))
}

// simTextURL builds an inline data URL serving `body` under `mime`, so a text
// artifact needs no more blob serving than the SVG images do - the lightbox's
// text viewer fetches the URL it is given, and a data URL is one.
func simTextURL(mime, body string) string {
	return "data:" + mime + ";charset=utf-8;base64," + base64.StdEncoding.EncodeToString([]byte(body))
}

// simArtifactBlob dresses an inline data URL as a real artifact blob URL, so a
// simulated picture is addressed the way a generated one is:
// blob?script=&key=&file=.
//
// It exists because that triple is an artifact's IDENTITY, not just a route. The
// review pins read their anchor back out of the URL the picture is loaded from
// (web/src/lib/artifactAnchor.ts), so a data URL - which carries no script, key or
// file - is a picture nothing can be pinned to. Without this the simulation could
// not exercise image comments at all.
//
// The bytes still ride in the URL (the `d` parameter, ignored by everything that
// reads the identity), so this keeps the property that made data URLs attractive
// here: no on-disk blob serving, and no cache to seed.
func simArtifactBlob(script, key, file, dataURL string) string {
	// Also remembered by its (script, key, file) triple, because that is how a
	// REAL daemon addresses a blob - and anything that reconstructs a URL from an
	// artifact's identity rather than reusing the one it was handed will ask that
	// way. A review comment's card is the case in point: it holds an anchor, not a
	// URL, so without this it asks for a picture the simulation would not
	// recognise. The map only grows as the fixtures are built, once, at startup.
	simBlobMu.Lock()
	simBlobs[simBlobKey{script, key, file}] = dataURL
	simBlobMu.Unlock()

	q := url.Values{}
	q.Set("d", dataURL)
	return simArtifactBlobPath("sim-project", script, key, file) + "?" + q.Encode()
}

// simArtifactBlobPath / simArtifactLogPath mirror the real server's blobURL and
// logURL: the (script, key, file) triple lives in the path, laid out like the
// on-disk entry. Kept here rather than reusing those so the simulation stays
// self-contained, but any change to the route has to land in both.
func simArtifactBlobPath(projectID, script, key, file string) string {
	return simArtifactBase(projectID, script, key) + "/files/" + file
}

func simArtifactLogPath(projectID, script, key string) string {
	return simArtifactBase(projectID, script, key) + "/log"
}

func simArtifactBase(projectID, script, key string) string {
	return "/api/projects/" + projectID + "/artifacts/" + script + "/" + key
}

type simBlobKey struct{ script, key, file string }

var (
	simBlobMu sync.Mutex
	simBlobs  = map[simBlobKey]string{}
)

// HandleArtifactBlob serves a simulated artifact's bytes, mirroring the real
// server's hand-served route. The content is carried in the request itself (see
// simArtifactBlob), so there is nothing to look up: this decodes the data URL it
// was handed back into bytes and a content type.
func (s *SimulationServer) HandleArtifactBlob(w http.ResponseWriter, r *http.Request) {
	d := r.URL.Query().Get("d")
	if d == "" {
		// Addressed by identity rather than by the URL we handed out - which is
		// how the real blob route works, and how anything holding an artifact
		// anchor will ask. The triple comes from the path, as it does there.
		script, key, file := artifactPathParts(r)
		simBlobMu.Lock()
		d = simBlobs[simBlobKey{script, key, file}]
		simBlobMu.Unlock()
	}
	mime, body, ok := decodeDataURL(d)
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(body)
}

// decodeDataURL splits "data:<mime>[;charset=...];base64,<payload>" into its mime
// type and decoded bytes. Only the base64 form is produced by the helpers above,
// so anything else is refused rather than guessed at.
func decodeDataURL(s string) (mime string, body []byte, ok bool) {
	const prefix = "data:"
	if !strings.HasPrefix(s, prefix) {
		return "", nil, false
	}
	meta, payload, found := strings.Cut(s[len(prefix):], ",")
	if !found || !strings.HasSuffix(meta, ";base64") {
		return "", nil, false
	}
	mime = strings.TrimSuffix(meta, ";base64")
	// A charset parameter belongs on the Content-Type as written, so keep it.
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return "", nil, false
	}
	return mime, raw, true
}

// simSVG builds an inline data-URL SVG image (w×h) so the demo can render
// artifacts without any on-disk blob serving. Mixing tall "phone" shapes with
// wide "desktop" ones shows off the flex-wrap artifact layout: narrow shots
// pack several per row while a wide one claims its own.
func simSVG(label, color string, w, h int) string {
	return simSVGDoc(fmt.Sprintf(
		`<rect width="%d" height="%d" fill="%s"/>`+
			`<text x="%d" y="%d" font-family="sans-serif" font-size="18" fill="white" text-anchor="middle">%s</text>`,
		w, h, color, w/2, h/2, label), w, h)
}

// simSVGUI renders a minimal, abstract UI mock - a header title, a body panel,
// a small centred tile, and a status badge in the top-right corner. The
// before/after sides of a changed image pass the same title/theme but a
// different accent colour + badge label, so only the centred tile and the
// top-right badge differ between them - everything else is identical. Two small,
// separated changed regions keep the demos honest without painting over the
// whole frame: the pixel-diff "Highlight" overlay marks just those two spots,
// and the centred tile gives the before/after slider (a horizontal mid-frame
// wipe) something to reveal as it sweeps through the centre.
func simSVGUI(title string, dark bool, accent, badgeText string, w, h int) string {
	bg, body, fg := "#e2e8f0", "#cbd5e1", "#0f172a"
	if dark {
		bg, body, fg = "#0f172a", "#1e293b", "#f1f5f9"
	}
	bw, bh := 56, 22      // badge box, top-right
	bx, by := w-bw-12, 12 // 12px inset
	cw, ch := 96, 26      // centred tile (gives the slider a mid-frame change)
	cx, cy := (w-cw)/2, (h-ch)/2
	return simSVGDoc(fmt.Sprintf(
		`<rect width="%d" height="%d" fill="%s"/>`+
			`<text x="16" y="30" font-family="sans-serif" font-size="16" fill="%s">%s</text>`+
			`<rect x="12" y="48" width="%d" height="%d" rx="8" fill="%s"/>`+
			`<rect x="%d" y="%d" width="%d" height="%d" rx="6" fill="%s"/>`+
			`<rect x="%d" y="%d" width="%d" height="%d" rx="6" fill="%s"/>`+
			`<text x="%d" y="%d" font-family="sans-serif" font-size="11" fill="white" text-anchor="middle">%s</text>`,
		w, h, bg,
		fg, title,
		w-24, h-60, body,
		cx, cy, cw, ch, accent,
		bx, by, bw, bh, accent,
		bx+bw/2, by+15, badgeText), w, h)
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

// simArtifactFailedLog is a believable failing build log for the error / partial-
// failure sets, so the diff viewer documents the new "failure shows the red-
// bordered terminal" treatment (the script's stderr is the error detail). The
// tail differs per script so the two failure cases read distinctly.
func simArtifactFailedLog(script string) []api.ArtifactLogLine {
	out := func(t string) api.ArtifactLogLine { return api.ArtifactLogLine{Text: t, Stream: api.Stdout} }
	errLine := func(t string) api.ArtifactLogLine { return api.ArtifactLogLine{Text: t, Stream: api.Stderr} }
	lines := []api.ArtifactLogLine{
		out("Rendering Hydra UI for ref a1b2c3d from /checkout"),
		out("building frontend"),
		out("+ (/checkout/web) bun install"),
		out("bun install v1.1.34"),
		out("120 packages installed [2.31s]"),
	}
	switch script {
	case "dashboard":
		lines = append(lines,
			out("booting simulation server"),
			out("capturing screenshots"),
			errLine("Error: page.goto: net::ERR_CONNECTION_REFUSED"),
			errLine("    at http://localhost:3000/dashboard"),
			errLine("    at /app/web/scripts/screenshots/take-screenshots.ts:88:14"),
			errLine("exited 1"),
		)
	default:
		lines = append(lines,
			out("+ (/checkout/web) bun x scripts/screenshots/take-screenshots.ts"),
			errLine("error: Cannot find module 'playwright'"),
			errLine("    at file:///app/web/scripts/screenshots/take-screenshots.ts:21:1"),
			errLine("exited 1"),
		)
	}
	return lines
}

// simLogURL builds a persisted-log URL for the simulated diff sets. The key is
// opaque to the real server; here HandleArtifactLog inspects it ("error" → failed
// log) so the failure sets resolve to a believable red-bordered terminal.
func simLogURL(script, key string) string {
	return simArtifactLogPath("sim-project", script, key)
}

// The bodies behind the "files" set's text artifacts. Each pair is a before and
// an after that differ in a few lines, so the lightbox has a real diff to show;
// the log's long lines are there to exercise wrapping, and the .go pair to
// exercise syntax highlighting on both sides of a diff.
//
// The timestamps are deliberately NOT in the changed lines: a log whose every
// line carries a clock reads as "all of it changed", which shows the diff off
// badly and is not what a real report-vs-report comparison looks like. Here the
// unchanged lines stay unchanged, so the demo has context rows, two edited lines
// (with word-level marks inside them) and one added line.
const simDeployLogBefore = "resolving 214 packages\n" +
	"building web/ ... a very long line, deliberately: compiling src/components/AgentChat.tsx with the swc transform and the css pipeline, " +
	"then emitting the bundle, the sourcemap and the asset manifest into dist/\n" +
	"uploading dist/ (4.2 MB)\n" +
	"deploy 3f2a91c to staging\n" +
	"ok\n"

const simDeployLogAfter = "resolving 216 packages\n" +
	"building web/ ... a very long line, deliberately: compiling src/components/AgentChat.tsx with the swc transform and the css pipeline, " +
	"then emitting the bundle, the sourcemap and the asset manifest into dist/\n" +
	"uploading dist/ (4.4 MB)\n" +
	"deploy 9b71e04 to staging\n" +
	"warning: 2 assets over the 500 KB budget\n" +
	"ok\n"

// A generated schema - the shape of collectible text output that carries real
// syntax to highlight, on both sides of a diff. Deliberately a .sql and not a
// .go: the artifact pipeline collects reports and generated files (textExts in
// internal/artifacts), not arbitrary source, and a fixture that showed
// otherwise would be documenting a state the product cannot produce.
const simSchemaBefore = "-- generated by `mage schema:dump` - do not edit\n" +
	"CREATE TABLE uploads (\n" +
	"  id      INTEGER PRIMARY KEY,\n" +
	"  key     TEXT NOT NULL,\n" +
	"  size    INTEGER NOT NULL DEFAULT 0\n" +
	");\n\n" +
	"CREATE INDEX uploads_key ON uploads (key);\n"

const simSchemaAfter = "-- generated by `mage schema:dump` - do not edit\n" +
	"CREATE TABLE uploads (\n" +
	"  id       INTEGER PRIMARY KEY,\n" +
	"  key      TEXT NOT NULL,\n" +
	"  size     INTEGER NOT NULL DEFAULT 0,\n" +
	"  attempts INTEGER NOT NULL DEFAULT 0\n" +
	");\n\n" +
	"CREATE INDEX uploads_key ON uploads (key);\n" +
	"CREATE INDEX uploads_attempts ON uploads (attempts) WHERE attempts > 0;\n"

const simReleaseNotes = "# Release notes\n\n" +
	"The lightbox renders a markdown artifact as a **document**, with a Source\n" +
	"switch for the file behind it.\n\n" +
	"## What is in the box\n\n" +
	"- every viewer the lightbox has, one file each\n" +
	"- a `before`/`after` pair for the text ones, so the diff view has something to show\n" +
	"- a long line or two, so wrapping has something to wrap\n\n" +
	"| File | Shows |\n| --- | --- |\n" +
	"| `deploy.log` | wrapping, the line-number gutter, a text diff |\n" +
	"| `schema.sql` | syntax highlighting on both sides of a diff |\n" +
	"| `bundle.tgz` | the \"no preview\" download card |\n\n" +
	"```go\nfunc sleepBackoff(attempt int) {\n\td := 100 * time.Millisecond << attempt\n\ttime.Sleep(d)\n}\n```\n\n" +
	"> Rendered by the same <Markdown variant=\"doc\"> a README gets in the\n> repository browser.\n"

// simLightboxSet is the demo set holding ONE artifact of every kind the lightbox
// can open - image, video, text, markdown, source, and a binary with no preview -
// with a before and an after wherever a diff makes sense. It exists so every
// viewer (and the text diff) can be opened by hand in simulation, which no other
// set covers: the screenshots set is all images plus one .webm and one .apk.
//
// It hangs off agent-chat rather than agent-1 deliberately. agent-1's panel is
// what take-screenshots captures (the artifact grid, the A/B modes, the
// lightbox shots), so a set added there would land in half a dozen screenshots;
// agent-chat is only ever captured viewportOnly at the top of its page, above
// where this card sits.
func simLightboxSet() api.ArtifactSet {
	return api.ArtifactSet{
		Name:    "files",
		Status:  api.ArtifactSetStatusReady,
		Changed: true,
		Files: []api.ArtifactFile{
			{
				Name:       "deploy.log",
				ChangeType: api.ArtifactFileChangeTypeModified,
				LeftUrl:    ptr(simTextURL("text/plain", simDeployLogBefore)),
				RightUrl:   ptr(simTextURL("text/plain", simDeployLogAfter)),
				Size:       ptr(int64(len(simDeployLogAfter))),
			},
			{
				Name:       "schema.sql",
				ChangeType: api.ArtifactFileChangeTypeModified,
				LeftUrl:    ptr(simTextURL("text/plain", simSchemaBefore)),
				RightUrl:   ptr(simTextURL("text/plain", simSchemaAfter)),
				Size:       ptr(int64(len(simSchemaAfter))),
			},
			{
				Name:       "RELEASE-NOTES.md",
				ChangeType: api.ArtifactFileChangeTypeAdded,
				RightUrl:   ptr(simTextURL("text/markdown", simReleaseNotes)),
				Size:       ptr(int64(len(simReleaseNotes))),
			},
			{
				Name:       "preview.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				LeftUrl:    ptr(simSVGUI("Preview", false, "#64748b", "Draft", 360, 220)),
				RightUrl:   ptr(simSVGUI("Preview", false, "#16a34a", "Live", 360, 220)),
				Width:      ptr(1440), Height: ptr(880),
				ChangeRatio: ptr(0.03),
			},
			{
				Name:       "loader-animation.webm",
				ChangeType: api.ArtifactFileChangeTypeModified,
				LeftUrl:    ptr(simWebM(simVideoBefore)),
				RightUrl:   ptr(simWebM(simVideoAfter)),
				Width:      ptr(280), Height: ptr(150),
				ChangeRatio: ptr(0.5),
			},
			{
				// No preview is possible for this one - it is here so the download
				// card is one ←/→ step away from the viewers that do render.
				Name:       "bundle.tgz",
				ChangeType: api.ArtifactFileChangeTypeAdded,
				RightUrl:   ptr(simArtifactBlobPath("sim-project", "files", "commit/bbbb", "bundle.tgz")),
				Size:       ptr(int64(9437184)),
			},
		},
	}
}

// simArtifactSets returns the mock artifact sets for the simulated agent, shared
// by the HTTP poll handler and the streaming WS handler.
func simArtifactSets(id string) []api.ArtifactSet {
	// The one-of-every-lightbox-viewer demo - see simLightboxSet for why it hangs
	// off the chat agent.
	if id == "agent-chat" {
		return []api.ArtifactSet{simLightboxSet()}
	}
	if id != "agent-1" {
		return []api.ArtifactSet{}
	}
	leftProgress := "button.png 4/9"
	rightProgress := "artifacts-ab-dark.png 7/12"
	startedAt := simNow().Add(-8 * time.Second).Unix()
	leftLog := simArtifactLog()
	rightLog := simArtifactLog()
	return []api.ArtifactSet{
		simReadyChangedSet(),
		// In-flight generation where BOTH sides are still building AND tiles are
		// already streaming in: the HandleArtifactsWS handler pushes "file" messages
		// (see simStreamedArtifactFiles) into this set, so an expanded card shows the
		// finished tiles above both live build logs - the per-file ::hydra:artifact::
		// streaming, before the run settles. Files start empty; the WS fills them.
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
		// Queued, not running: an entry is marked in-flight before it acquires a
		// generation slot, so this is the state that used to be indistinguishable
		// from the one above - spinner, climbing clock, no output. Both sides are
		// waiting, so the card says so and names the clock as the wait.
		//
		// Every Name in this slice must be DISTINCT. A real agent's sets come from
		// the [artifacts.<name>] config tables, which merge by name, so two sets
		// can't share one - and the panel relies on that: it keys its cards by
		// name so the cached-chrome skeleton card is reused by the live card that
		// replaces it, with no remount (see displaySets in ArtifactsPanel.tsx).
		// This one used to be a second "screenshots", which collided with
		// simReadyChangedSet above and made React drop a card and warn.
		{
			Name:        "icons",
			Status:      api.ArtifactSetStatusGenerating,
			StartedAt:   &startedAt,
			LeftQueued:  ptr(2),
			RightQueued: ptr(3),
			Files:       []api.ArtifactFile{},
		},
		// Failure: both sides failed, so the card surfaces the build log as two
		// red-bordered terminals (the script's stderr is the error) instead of a
		// separate error box. refresh retries.
		{
			Name:        "storybook",
			Status:      api.ArtifactSetStatusError,
			Error:       ptr("exited 1: error: Cannot find module 'playwright'\n  at file:///app/web/scripts/screenshots/take-screenshots.ts:21:1"),
			LeftLogUrl:  ptr(simLogURL("storybook", "error/left")),
			RightLogUrl: ptr(simLogURL("storybook", "error/right")),
			Files:       []api.ArtifactFile{},
		},
		// Partial failure: the LEFT (before) side died, but the RIGHT (after) side
		// rendered, so the card stays "ready" and shows the surviving side's images
		// (here surfacing as "added"). The build log auto-opens with the before
		// terminal red-bordered (its stderr is the failure detail) instead of a
		// separate amber error box.
		{
			Name:        "dashboard",
			Status:      api.ArtifactSetStatusReady,
			Changed:     true,
			LeftError:   ptr("exited 1: Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/dashboard\n  at /app/web/scripts/screenshots/take-screenshots.ts:88:14"),
			LeftLogUrl:  ptr(simLogURL("dashboard", "error/left")),
			RightLogUrl: ptr(simLogURL("dashboard", "commit/a1b2c3d")),
			Files: []api.ArtifactFile{
				{
					Name:       "overview.png",
					ChangeType: api.ArtifactFileChangeTypeAdded,
					RightUrl:   ptr(simSVG("Overview (after)", "#15803d", 360, 220)),
					Width:      ptr(1440), Height: ptr(880),
				},
				{
					Name:       "metrics.png",
					ChangeType: api.ArtifactFileChangeTypeAdded,
					RightUrl:   ptr(simSVG("Metrics (after)", "#15803d", 240, 320)),
					Width:      ptr(960), Height: ptr(1280),
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
					Width:      ptr(1440), Height: ptr(880),
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
//
// Each file's Width/Height is the resolution a real capture at that viewport would
// have (≈1440×880 desktop, 960×1920 phone), NOT the small size the placeholder SVG
// is drawn at - the SVG is vector and scales to fill its tile, so it stands in for a
// full-resolution screenshot. Sizing them realistically keeps the masonry's
// resolution-aware span (which would otherwise treat a 360px SVG as a tiny image and
// shrink its tile on a high-DPI screen) laying the demo out like real artifacts.
func simReadyChangedSet() api.ArtifactSet {
	return api.ArtifactSet{
		Name:    "screenshots",
		Status:  api.ArtifactSetStatusReady,
		Changed: true,
		Files: []api.ArtifactFile{
			// Each modified pair shares everything except a small centred tile and a
			// top-right status badge (grey "Draft" → green "Live"), so the pixel-diff
			// Highlight marks only those two spots rather than the whole frame, and
			// the centred change gives the before/after slider something to reveal as
			// it wipes through the middle - see simSVGUI.
			{
				Name:       "home.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::light", "viewport::desktop"),
				LeftUrl:    ptr(simArtifactBlob("screenshots", simKeyLeft, "home.png", simSVGUI("Home", false, "#64748b", "Draft", 360, 220))),
				RightUrl:   ptr(simArtifactBlob("screenshots", simKeyRight, "home.png", simSVGUI("Home", false, "#16a34a", "Live", 360, 220))),
				Width:      ptr(1440), Height: ptr(880),
				// Only the centred tile + status badge moved, so a small fraction of
				// pixels differ - below a ~10% threshold this reads as "identical".
				ChangeRatio: ptr(0.03),
			},
			{
				Name:       "home-dark.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::dark", "viewport::desktop"),
				LeftUrl:    ptr(simArtifactBlob("screenshots", simKeyLeft, "home-dark.png", simSVGUI("Home", true, "#64748b", "Draft", 360, 220))),
				RightUrl:   ptr(simArtifactBlob("screenshots", simKeyRight, "home-dark.png", simSVGUI("Home", true, "#16a34a", "Live", 360, 220))),
				Width:      ptr(1440), Height: ptr(880),
				ChangeRatio: ptr(0.03),
			},
			{
				Name:       "login-phone.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::light", "viewport::phone"),
				LeftUrl:    ptr(simArtifactBlob("screenshots", simKeyLeft, "login-phone.png", simSVGUI("Login", false, "#64748b", "Draft", 240, 480))),
				RightUrl:   ptr(simArtifactBlob("screenshots", simKeyRight, "login-phone.png", simSVGUI("Login", false, "#16a34a", "Live", 240, 480))),
				Width:      ptr(960), Height: ptr(1920),
				// A larger fraction differs here, so this one stays "modified" past a
				// ~10% threshold - contrasting with the near-identical home shots.
				ChangeRatio: ptr(0.18),
			},
			{
				Name:       "profile-phone-dark.png",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::dark", "viewport::phone"),
				LeftUrl:    ptr(simArtifactBlob("screenshots", simKeyLeft, "profile-phone-dark.png", simSVGUI("Profile", true, "#64748b", "Draft", 240, 480))),
				RightUrl:   ptr(simArtifactBlob("screenshots", simKeyRight, "profile-phone-dark.png", simSVGUI("Profile", true, "#16a34a", "Live", 240, 480))),
				Width:      ptr(960), Height: ptr(1920),
				ChangeRatio: ptr(0.42),
			},
			{
				Name:       "settings-phone.png",
				ChangeType: api.ArtifactFileChangeTypeAdded,
				Tags:       artTags("theme::dark", "viewport::phone", "new"),
				RightUrl:   ptr(simArtifactBlob("screenshots", simKeyRight, "settings-phone.png", simSVG("Settings (new)", "#15803d", 240, 480))),
				Width:      ptr(960), Height: ptr(1920),
			},
			// A .webm artifact: the frontend routes it to the video diff viewer
			// (synchronized before/after playback + per-frame difference) rather
			// than the image one. Same before/after model as the images above.
			{
				Name:       "loader-animation.webm",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("theme::dark", "viewport::desktop"),
				LeftUrl:    ptr(simArtifactBlob("screenshots", simKeyLeft, "loader-animation.webm", simWebM(simVideoBefore))),
				RightUrl:   ptr(simArtifactBlob("screenshots", simKeyRight, "loader-animation.webm", simWebM(simVideoAfter))),
				Width:      ptr(280), Height: ptr(150),
				// Video ratio is the share of differing frames; this animation changes
				// across much of its run, so it stays "modified" at a ~10% threshold.
				ChangeRatio: ptr(0.5),
			},
			{
				Name:       "about.png",
				ChangeType: api.ArtifactFileChangeTypeUnchanged,
				Tags:       artTags("theme::light", "viewport::desktop"),
				LeftUrl:    ptr(simArtifactBlob("screenshots", simKeyLeft, "about.png", simSVG("About", "#334155", 360, 220))),
				RightUrl:   ptr(simArtifactBlob("screenshots", simKeyRight, "about.png", simSVG("About", "#334155", 360, 220))),
				Width:      ptr(1440), Height: ptr(880),
			},
			// A download-class artifact (an Android build): the frontend renders a
			// download tile (icon + size + change chip) instead of media, and the
			// real blob endpoint serves such files with Content-Disposition:
			// attachment. The URLs 404 in simulation; only the tile matters here.
			{
				Name:       "app-debug.apk",
				ChangeType: api.ArtifactFileChangeTypeModified,
				Tags:       artTags("variant::debug"),
				LeftUrl:    ptr(simArtifactBlobPath("sim-project", "screenshots", "commit/aaaa", "app-debug.apk")),
				RightUrl:   ptr(simArtifactBlobPath("sim-project", "screenshots", "commit/bbbb", "app-debug.apk")),
				Size:       ptr(int64(48522619)),
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

func (s *SimulationServer) ListAgentApprovals(w http.ResponseWriter, r *http.Request, projectId string, id string) {
	// Only the picker head (agent-approvals) ever parks one, and only while its
	// question card has been answered - so no other simulated page (and no
	// screenshot) grows an approval it didn't ask for.
	approvals := []api.ApprovalRequest{}
	if id == "agent-approvals" {
		if kind, _ := s.simApproval(); kind != "" {
			if req, ok := simApprovalRequest(kind); ok {
				approvals = append(approvals, req)
			}
		}
	}
	api.WriteJSON(w, http.StatusOK, api.ApprovalListResponse{Approvals: approvals})
}

func (s *SimulationServer) DecideAgentApproval(w http.ResponseWriter, r *http.Request, projectId string, id string, reqid string) {
	// Answering it (from the toast or the tool card) retires the request, exactly
	// as the real daemon does - the head then leaves its policy_approval wait.
	if id == "agent-approvals" {
		s.setSimApproval("")
	}
	w.WriteHeader(http.StatusNoContent)
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
	"scripts/bootstrap",
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
// browser's image preview has something to render.
const simRepoImage = "web/public/logo.png"

// simLogoPNG is a small, deterministic PNG used as the simulated repo's binary
// image file. Kept as a fixed blob so screenshot artifacts stay byte-stable.
const simLogoPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAIAAABaGO0eAAAC10lEQVR42u3dzVHDQAwF4Bw5URYVUQi0QjdUQQmQgZkcQuz900pP78njY5JZ6wPi3ecVl+86Qo9LlaAACuD3+Hz5mjufX9/Wz6f3D5PTZDAO47EEWGdQq/4WgGkDwervAphg0Kz+XoB+BtnqewA0DZSr7wRwwiBefVeA/wxV/QCAm0FV/xDg+im7Da5nVf8M4O8EZyCofgMA2YCj+m0ATAaa6ncB3F4KwsBU/TbA3avDDciq3wA4ek8UA1/1zwCa73RmoKz+IUDnm90MWKt//agHAKOf4sBAnLUZAKRggF35MANANkBed7IEwGQAX/UzBvCcPHNkbZYA/gsYBFmbGcDR6KMYsuQNNgDNy3BmSJT2GAB0XoybQa6sbRVg9Koqa7MEmL68ytoMABZ/xCprWwKw+jtbWdsMgPm3nHLWNgyw6R5DNmsbA9h9hyeYtQ0AuN1fS2VtvQDOsxudrK0LIGpuqZC1tQHCZ/bcWVsDAGRdhThrOwNAW9WizNoOAWDXFMmytscA4Cu6TFlb19PRmKtaHFnbLgC3++vsWdsWAOfZTeqszR4gam6ZNGszBgif2afL2iwBQJ5hzpW1mQGgPUGeJWuzAYB9fh8/azMAAN89AZ61rQJk2bsCm7UtAaTbOQSYtc0DJN23hZa1TQJk3zWHs7I9A0CzZxGBYRiAbMdouMEYAOt+3UCGAQDi3dKBAUMvAH31owy6AESqH8Iw0C9IrSu3D8NYvyC1rtwOBjP9gtS6cscAVPV9GJb6Bal15XYCqOp7MuwCoO9MDA0g0hcaFECtKzcWgGxPdAgA8Y70wQD1/wDmGJz6Bal15XYFqOqvGHj3C6qszRKgqr+etYX1C6qsbQmgqm+VtUH0C1LO2lD6BclmbVj9ggSzNsR+QVJ3AaD9gnS+h6D7BSn8LiboF8Q9nhz9gojHk6lfEOV48vULIhtPyn5BTON5AFBHyFEABaB9/ACuVNk1U+d1vQAAAABJRU5ErkJggg=="

// The repository diff carries an in-tree image that's modified on the branch and
// one that's added, so the diff viewer's before/after image differ (the
// artifacts panel's ImageDiffView, reused by FileDiff for binary images) has
// something to render instead of "Binary file changed". simDiffImageModified is
// served as a different picture per ref (before vs after, see
// HandleRepositoryBlob + simIsBaseRef) so the comparison shows a real change;
// simDiffImageAdded exists only on the head side.
const (
	simDiffImageModified = "web/public/diff-banner.png"
	simDiffImageAdded    = "web/public/diff-added.png"
)

// Deterministic before/after PNGs for the modified diff image (same size, a
// recoloured + moved badge), kept as fixed blobs so screenshot artifacts stay
// byte-stable. The added image reuses the "after" picture.
const (
	simDiffImageBeforeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABMklEQVR4nOzaoY1CQRhG0V0ydeCfwyHogFbQVEFzOCSSNmgBM5mXm3P0iC+5+d2M8/X2R9dh9QDmEjhO4DiB4wSOEzhO4DiB4wSOEzhO4DiB4wSOEzhO4DiB4wSOEzhO4DiB4wSOG5/3c/UGJnLBcQLHCRwncJzAcQLHCRwncJzAcQLHCRwncJzAcQLHCRwncJzAcQLHCRwncJzAceP3p6/7Hv9fbo/T6gm75oLjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOE7gOIHjBI4TOO7/uF1Wb2AiFxwncJzAcQLHCRwncJzAcQLHCRwncJzAcQLHCRwncJzAcd8AAAD//3IGB9IooGG7AAAAAElFTkSuQmCC"
	simDiffImageAfterBase64  = "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABMklEQVR4nOzTMY0CQBRF0V0yOmioUECBA3TQYQlRGCCUmKDAAVSTITfntL95yc0fh9Plj67N6gHMJXCcwHECxwkcJ3CcwHECxwkcJ3CcwHECxwkcJ3CcwHECxwkcJ3CcwHECxwkcN56P2+oNTOSD4wSOEzhO4DiB4wSOEzhO4DiB4wSOEzhO4DiB4wSOEzhO4DiB48bqAb9uXHerJ3zxOt8/XH1wnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAscJHCdwnMBxAsf9b/fH1RuYyAfHCRwncJzAcQLHCRwncJzAcQLHCRwncNw7AAD//31pB9L/B2l1AAAAAElFTkSuQmCC"
)

// simIsBaseRef reports whether a blob ref query denotes the diff's base side (the
// browsed ref, "main") rather than the head (the agent branch). It picks which
// version of the modified diff image (before vs after) HandleRepositoryBlob
// serves, so the same path renders a different picture on each side of the diff.
func simIsBaseRef(ref string) bool {
	return ref == "" || ref == "HEAD" || ref == "main"
}

// simRepoFiles holds the simulated content for each path in simRepoOrder.
var simRepoFiles = map[string]string{
	".gitignore": "node_modules/\ndist/\n.env\n*.log\n.hydra/local/\n",
	// The project config. Its [[artifacts]] blocks are what the repository
	// browser's dynamic ".hydra/artifacts" folder lists (the names here match the
	// scripts GetRepositoryArtifacts returns below).
	".hydra/config.toml": "[[artifacts]]\nname = \"screenshots\"\ncommand = \"bun run screenshots.ts\"\ntimeout_sec = 900\n\n" +
		"[[artifacts]]\nname = \"components\"\ncommand = \"bun run storybook-shots.ts\"\n",
	"CLAUDE.md":  "# Project guidelines\n\nThis demo repo powers Hydra's **Repository** view.\n\n- Use `bun` instead of `npm`.\n- Run the formatter before committing.\n",
	"LICENSE":    "MIT License\n\nCopyright (c) 2026 Hydra Demo\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction.\n",
	"hydra.toml": "pre_prompt = \"\"\"\n- Use bun instead of npm\n\"\"\"\n\n[sandbox]\nwritable_paths = [\"~/.cache/go-build\"]\n",
	// No extension, so the file viewer has to read the `#!` line to know it is a
	// shell script (getLanguage's shebang fallback).
	"scripts/bootstrap": "#!/usr/bin/env bash\nset -euo pipefail\n\n# Install the toolchain and seed the dev database.\nroot=\"$(cd \"$(dirname \"$0\")/..\" && pwd)\"\ncd \"$root\"\n\nif ! command -v bun >/dev/null; then\n  echo \"bun is required\" >&2\n  exit 1\nfi\n\nbun install\nbun run db:seed\n",
	// A deeply-nested single-child chain; each folder holds only the next, so the
	// tree compacts config/env/staging/region/eu onto one row (compact
	// folders, like the diff viewer).
	"config/env/staging/region/eu/settings.toml": "[region]\nname = \"eu\"\nenv = \"staging\"\n\n[limits]\nmax_requests = 1000\ntimeout_sec = 30\n",
	"README.md": "# Hydra Demo\n\nA simulated repository powering the **Repository** view.\n\n" +
		"This page is a lightweight, GitHub-style browser: pick a file or folder\n" +
		"on the left, read it on the right. By default it opens `README.md`.\n\n" +
		"## Features\n\n" +
		"- Collapsible file & folder tree\n" +
		"- Syntax-highlighted file contents\n" +
		"- Markdown rendering for `README` files\n\n" +
		"| Feature            | Status | Notes                          |\n" +
		"| ------------------ | :----: | ------------------------------ |\n" +
		"| File & folder tree |   Yes  | Collapsible, VS Code-style     |\n" +
		"| Syntax highlight   |   Yes  | Powered by highlight.js        |\n" +
		"| Markdown tables    |   Yes  | Right here in this README      |\n\n" +
		"## Getting started\n\n" +
		"```sh\nbun install\nbun run dev\n```\n\n" +
		"See the [demo server](internal/server/server.go) for the entrypoint, or\n" +
		"browse [the components](web/src/App.tsx). Enjoy exploring the tree!\n",
	"go.mod": "module github.com/example/hydra-demo\n\ngo 1.26\n",
	"package.json": "{\n  \"name\": \"hydra-demo\",\n  \"version\": \"1.0.0\",\n" +
		"  \"scripts\": {\n    \"dev\": \"vite\",\n    \"build\": \"vite build\"\n  }\n}\n",
	"internal/server/server.go": "package server\n\nimport \"net/http\"\n\n" +
		"// New returns the demo HTTP handler.\nfunc New() http.Handler {\n" +
		"\tmux := http.NewServeMux()\n\tmux.HandleFunc(\"/\", func(w http.ResponseWriter, r *http.Request) {\n" +
		"\t\tw.Write([]byte(\"hello from hydra-demo\"))\n\t})\n\treturn mux\n}\n",
	// Long enough that a review comment on Get has real lines either side of it:
	// this file is NOT in any agent's diff, and comment #9 below is anchored to
	// it, which is what exercises the off-diff file card (it reads the file at the
	// head's branch and shows the lines around the comment).
	"internal/store/store.go": "package store\n\nimport \"sync\"\n\n// Store is an in-memory key/value store.\n" +
		"type Store struct {\n\tmu   sync.Mutex\n\tdata map[string]string\n}\n\n" +
		"func New() *Store {\n\treturn &Store{data: map[string]string{}}\n}\n\n" +
		"// Get returns the value for a key, or the empty string.\n" +
		"func (s *Store) Get(key string) string {\n\ts.mu.Lock()\n\tdefer s.mu.Unlock()\n\treturn s.data[key]\n}\n\n" +
		"// Set stores a value.\nfunc (s *Store) Set(key, value string) {\n" +
		"\ts.mu.Lock()\n\tdefer s.mu.Unlock()\n\ts.data[key] = value\n}\n",
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

// GetRepositoryDiff returns a small mock diff between two refs so the repository
// browser's branch-compare view renders in simulation mode. Honours a single-file
// request (FileDiff's network-expand path).
func (s *SimulationServer) GetRepositoryDiff(w http.ResponseWriter, r *http.Request, projectId string, params api.GetRepositoryDiffParams) {
	files := []api.DiffFile{
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
						{Type: api.Deletion, Content: "Old tagline", OldLineNum: ptr(2)},
						{Type: api.Addition, Content: "New tagline", NewLineNum: ptr(2)},
						{Type: api.Addition, Content: "Extra line", NewLineNum: ptr(3)},
						{Type: api.Context, Content: "", OldLineNum: ptr(3), NewLineNum: ptr(4)},
					},
				},
			},
		},
		{
			// A full-context ("expanded") file so the diff viewer's context model
			// kicks in: a single change mid-file with the surrounding lines
			// collapsed behind ⌄/⌃ expanders ("··· N lines ···").
			Path:       "internal/heads/heads.go",
			ChangeType: api.DiffFileChangeTypeModified,
			Additions:  1,
			Deletions:  1,
			Expanded:   ptr(true),
			Hunks: []api.DiffHunk{
				{
					Header:   "@@ -1,22 +1,22 @@",
					OldStart: 1,
					NewStart: 1,
					Lines: []api.DiffLine{
						{Type: api.Context, Content: "package heads", OldLineNum: ptr(1), NewLineNum: ptr(1)},
						{Type: api.Context, Content: "", OldLineNum: ptr(2), NewLineNum: ptr(2)},
						{Type: api.Context, Content: "import \"fmt\"", OldLineNum: ptr(3), NewLineNum: ptr(3)},
						{Type: api.Context, Content: "", OldLineNum: ptr(4), NewLineNum: ptr(4)},
						{Type: api.Context, Content: "// Head is an agent head.", OldLineNum: ptr(5), NewLineNum: ptr(5)},
						{Type: api.Context, Content: "type Head struct {", OldLineNum: ptr(6), NewLineNum: ptr(6)},
						{Type: api.Context, Content: "\tID     string", OldLineNum: ptr(7), NewLineNum: ptr(7)},
						{Type: api.Context, Content: "\tBranch string", OldLineNum: ptr(8), NewLineNum: ptr(8)},
						{Type: api.Context, Content: "}", OldLineNum: ptr(9), NewLineNum: ptr(9)},
						{Type: api.Context, Content: "", OldLineNum: ptr(10), NewLineNum: ptr(10)},
						{Type: api.Context, Content: "// greeting returns a message.", OldLineNum: ptr(11), NewLineNum: ptr(11)},
						{Type: api.Context, Content: "func greeting() string {", OldLineNum: ptr(12), NewLineNum: ptr(12)},
						{Type: api.Deletion, Content: "\treturn \"old\"", OldLineNum: ptr(13)},
						{Type: api.Addition, Content: "\treturn \"new\"", NewLineNum: ptr(13)},
						{Type: api.Context, Content: "}", OldLineNum: ptr(14), NewLineNum: ptr(14)},
						{Type: api.Context, Content: "", OldLineNum: ptr(15), NewLineNum: ptr(15)},
						{Type: api.Context, Content: "// helper is unchanged.", OldLineNum: ptr(16), NewLineNum: ptr(16)},
						{Type: api.Context, Content: "func helper() int {", OldLineNum: ptr(17), NewLineNum: ptr(17)},
						{Type: api.Context, Content: "\treturn 42", OldLineNum: ptr(18), NewLineNum: ptr(18)},
						{Type: api.Context, Content: "}", OldLineNum: ptr(19), NewLineNum: ptr(19)},
						{Type: api.Context, Content: "", OldLineNum: ptr(20), NewLineNum: ptr(20)},
						{Type: api.Context, Content: "// done marks completion.", OldLineNum: ptr(21), NewLineNum: ptr(21)},
						{Type: api.Context, Content: "var done = true", OldLineNum: ptr(22), NewLineNum: ptr(22)},
					},
				},
			},
		},
		{
			Path:       "internal/heads/lines.go",
			ChangeType: api.DiffFileChangeTypeAdded,
			Additions:  2,
			Deletions:  0,
			Hunks: []api.DiffHunk{
				{
					Header:   "@@ -0,0 +1,2 @@",
					OldStart: 0,
					NewStart: 1,
					Lines: []api.DiffLine{
						{Type: api.Addition, Content: "package heads", NewLineNum: ptr(1)},
						{Type: api.Addition, Content: "// line numbering helpers", NewLineNum: ptr(2)},
					},
				},
			},
		},
		{
			Path:       "internal/heads/old_helper.go",
			ChangeType: api.DiffFileChangeTypeDeleted,
			Additions:  0,
			Deletions:  1,
			Hunks: []api.DiffHunk{
				{
					Header:   "@@ -1 +0,0 @@",
					OldStart: 1,
					NewStart: 0,
					Lines: []api.DiffLine{
						{Type: api.Deletion, Content: "// removed", OldLineNum: ptr(1)},
					},
				},
			},
		},
		{
			// A pure rename (no content change): the whole file is shipped as
			// all-context lines so the viewer shows it normally rather than a bare
			// "No changes" - see GetRepositoryDiff's rename synthesis.
			Path:       "internal/heads/renderer.go",
			OldPath:    ptr("internal/heads/render.go"),
			ChangeType: api.DiffFileChangeTypeRenamed,
			Additions:  0,
			Deletions:  0,
			Expanded:   ptr(true),
			Hunks: []api.DiffHunk{
				{
					Header:   "@@ -1,5 +1,5 @@",
					OldStart: 1,
					NewStart: 1,
					Lines: []api.DiffLine{
						{Type: api.Context, Content: "package heads", OldLineNum: ptr(1), NewLineNum: ptr(1)},
						{Type: api.Context, Content: "", OldLineNum: ptr(2), NewLineNum: ptr(2)},
						{Type: api.Context, Content: "// Renderer draws heads.", OldLineNum: ptr(3), NewLineNum: ptr(3)},
						{Type: api.Context, Content: "func Renderer() {}", OldLineNum: ptr(4), NewLineNum: ptr(4)},
						{Type: api.Context, Content: "", OldLineNum: ptr(5), NewLineNum: ptr(5)},
					},
				},
			},
		},
		{
			// A modified in-tree image. Binary, so FileDiff swaps in the before/after
			// image differ (ImageDiffView) in place of "Binary file changed". The
			// blob handler serves a different picture per ref, so before ≠ after and
			// the comparison shows a real change.
			Path:       simDiffImageModified,
			ChangeType: api.DiffFileChangeTypeModified,
			Binary:     true,
		},
		{
			// An added in-tree image: only the after side exists, so the differ
			// shows the new image beside a "No image" before placeholder.
			Path:       simDiffImageAdded,
			ChangeType: api.DiffFileChangeTypeAdded,
			Binary:     true,
		},
	}
	if params.Path != nil && *params.Path != "" {
		filtered := make([]api.DiffFile, 0, 1)
		for _, f := range files {
			if f.Path == *params.Path {
				filtered = append(filtered, f)
			}
		}
		files = filtered
	}
	api.WriteJSON(w, http.StatusOK, api.DiffResponse{
		BaseRef: params.BaseRef,
		HeadRef: params.HeadRef,
		Files:   files,
	})
}

func (s *SimulationServer) GetRepositoryBranches(w http.ResponseWriter, r *http.Request, projectId string) {
	s.projectDirectoryMu.Lock()
	current := s.projectDirectoryCheckoutBranch
	if current == "" {
		current = "main"
	}
	s.projectDirectoryMu.Unlock()
	api.WriteJSON(w, http.StatusOK, api.RepositoryBranchesResponse{
		Current: current,
		Default: "main",
		Branches: []api.RepositoryBranch{
			{Name: "hydra/add-line-numbers", IsAgent: true, IsCurrent: false},
			{Name: "hydra/branch-selector", IsAgent: true, IsCurrent: false},
			{Name: "main", IsAgent: false, IsCurrent: current == "main"},
			{Name: "release", IsAgent: false, IsCurrent: current == "release"},
		},
	})
}

func (s *SimulationServer) GetRepositoryPushStatus(w http.ResponseWriter, r *http.Request, projectId string) {
	branch, remote := "main", "origin"
	api.WriteJSON(w, http.StatusOK, api.RepositoryPushStatus{
		Branch:    &branch,
		Remote:    &remote,
		Ahead:     2,
		Behind:    1,
		HasRemote: true,
		CanPush:   true,
		// A dirty config file, so the sidebar's uncommitted-changes warning
		// (and its commit popover) shows in screenshots.
		Uncommitted: simUncommitted(),
	})
}

// simUncommittedSummary is the mock diff-endpoint working-tree summary, sized so
// the uncommitted-changes badge's tooltip shows both groups and a long path that
// has to wrap.
func simUncommittedSummary() *api.UncommittedSummary {
	tracked := []string{"README.md", "web/src/components/agent/UncommittedChangesPanel.tsx"}
	untracked := []string{"new_file.txt"}
	return &api.UncommittedSummary{
		TrackedCount:   len(tracked),
		UntrackedCount: len(untracked),
		TrackedFiles:   &tracked,
		UntrackedFiles: &untracked,
	}
}

// simUncommitted is the mock working-tree state: the one dirty file a config
// save typically leaves behind. Pushing/syncing doesn't clean the tree, so
// those mocks report it too; only CommitRepository clears it.
func simUncommitted() api.RepositoryUncommittedChanges {
	return api.RepositoryUncommittedChanges{
		Total: 1,
		Files: []api.RepositoryUncommittedFile{
			{Path: ".hydra/config.toml", Status: "modified"},
		},
	}
}

func (s *SimulationServer) CommitRepository(w http.ResponseWriter, r *http.Request, projectId string) {
	branch, remote := "main", "origin"
	api.WriteJSON(w, http.StatusOK, api.RepositoryPushStatus{
		Branch:      &branch,
		Remote:      &remote,
		Ahead:       3,
		Behind:      1,
		HasRemote:   true,
		CanPush:     true,
		Uncommitted: api.RepositoryUncommittedChanges{Total: 0, Files: []api.RepositoryUncommittedFile{}},
	})
}

func (s *SimulationServer) PushRepository(w http.ResponseWriter, r *http.Request, projectId string) {
	branch, remote := "main", "origin"
	api.WriteJSON(w, http.StatusOK, api.RepositoryPushStatus{
		Branch:      &branch,
		Remote:      &remote,
		Ahead:       0,
		Behind:      1,
		HasRemote:   true,
		CanPush:     false,
		Uncommitted: simUncommitted(),
	})
}

func (s *SimulationServer) SyncRepository(w http.ResponseWriter, r *http.Request, projectId string) {
	branch, remote := "main", "origin"
	api.WriteJSON(w, http.StatusOK, api.RepositoryPushStatus{
		Branch:      &branch,
		Remote:      &remote,
		Ahead:       0,
		Behind:      0,
		HasRemote:   true,
		CanPush:     false,
		Uncommitted: simUncommitted(),
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

// HandleRepositoryBlob serves the simulated repo's raw file bytes: the binary
// image as image/png, and any text file as text/plain. This backs both the
// repository browser's image preview and the file viewer's "Raw" link (which
// opens the unrendered blob in a new tab). Symlinks resolve to their target and
// unknown paths 404, mirroring the real handler.
func (s *SimulationServer) HandleRepositoryBlob(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	reqPath := strings.TrimPrefix(path.Clean(q.Get("path")), "/")
	w.Header().Set("Cache-Control", "public, max-age=300")
	if reqPath == simRepoImage {
		png, err := base64.StdEncoding.DecodeString(simLogoPNGBase64)
		if err != nil {
			http.Error(w, "decode error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
		return
	}
	// The diff's in-tree images: the modified one renders a different picture on
	// each side of the diff (before vs after by ref); the added one only exists on
	// the head side. Backs the diff viewer's before/after image differ.
	if reqPath == simDiffImageModified || reqPath == simDiffImageAdded {
		b64 := simDiffImageAfterBase64
		if reqPath == simDiffImageModified && simIsBaseRef(q.Get("ref")) {
			b64 = simDiffImageBeforeBase64
		}
		png, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			http.Error(w, "decode error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
		return
	}
	if target, ok := simRepoSymlinks[reqPath]; ok {
		reqPath = target
	}
	content, ok := simRepoFiles[reqPath]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte(content))
}

// HandleAgentFileBlob serves the media behind a markdown image an agent embedded
// in a chat message. The simulation has no head filesystem to resolve against, so
// any image-looking path yields the same placeholder PNG and any video-looking
// one the embedded demo clip - enough to exercise the chat renderer's inline
// image/video paths (and the "unresolvable path" fallback, for anything else).
func (s *SimulationServer) HandleAgentFileBlob(w http.ResponseWriter, r *http.Request) {
	ext := strings.ToLower(path.Ext(r.URL.Query().Get("path")))
	if agentVideoExts[ext] {
		// Through ServeContent, so the player gets Range support and can seek -
		// the same thing the real endpoint relies on.
		w.Header().Set("Content-Type", "video/webm")
		http.ServeContent(w, r, "clip.webm", simNow(), bytes.NewReader(simVideoAfter))
		return
	}
	if !agentImageExts[ext] {
		http.NotFound(w, r)
		return
	}
	png, err := base64.StdEncoding.DecodeString(simDiffImageAfterBase64)
	if err != nil {
		http.Error(w, "decode error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	_, _ = w.Write(png)
}

// HandleUploadBlob serves the bytes behind an attachment chip. The simulation has
// no uploads directory, so an image-looking name yields the same placeholder PNG
// the agent-file endpoint uses and anything else a scrap of text - enough to
// exercise the chip thumbnails and both of the lightbox's viewers. Without it
// every attachment chip logged a 404 and rendered as a broken image.
func (s *SimulationServer) HandleUploadBlob(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if agentImageExts[strings.ToLower(path.Ext(name))] {
		png, err := base64.StdEncoding.DecodeString(simDiffImageAfterBase64)
		if err != nil {
			http.Error(w, "decode error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(png)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("panic: runtime error: invalid memory address\n\tinternal/heads.Get(0x0)\n"))
}

// HandleUpload accepts a file the user attached and answers with a path shaped
// like the real endpoint's, so the composer's optimistic chip settles instead of
// hanging in "uploading...". Nothing is stored - HandleUploadBlob synthesizes the
// bytes back from the name.
func (s *SimulationServer) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := "attachment"
	if f, header, err := r.FormFile("file"); err == nil {
		_ = f.Close()
		if header != nil && header.Filename != "" {
			name = path.Base(header.Filename)
		}
	}
	stored := fmt.Sprintf("%d-%s", simNow().UnixNano(), name)
	api.WriteJSON(w, http.StatusOK, map[string]string{
		"path":     "/home/you/acme/.hydra/local/projects/sim-project/uploads/" + stored,
		"filename": stored,
	})
}

// HandleAgentBlob serves the simulated repo's raw file bytes for an agent diff.
// The simulation has no real worktree or refs, so it ignores ref/worktree and
// resolves purely by path - mirroring HandleRepositoryBlob - which is enough to
// back the diff viewer's image differ in the frontend simulation.
func (s *SimulationServer) HandleAgentBlob(w http.ResponseWriter, r *http.Request) {
	s.HandleRepositoryBlob(w, r)
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
	logURL := simArtifactLogPath(projectId, name, "commit/a1b2c3d")
	switch name {
	case "screenshots":
		api.WriteJSON(w, http.StatusOK, api.RepositoryArtifactResponse{
			Name:   "screenshots",
			Status: api.RepositoryArtifactResponseStatusReady,
			LogUrl: &logURL,
			Files: []api.RepositoryArtifactFile{
				{Name: "home.png", Url: ptr(simSVG("home", "#15803d", 360, 220)), Tags: artTags("theme::light", "viewport::desktop"), Width: ptr(1440), Height: ptr(880)},
				{Name: "home-dark.png", Url: ptr(simSVG("home dark", "#166534", 360, 220)), Tags: artTags("theme::dark", "viewport::desktop"), Width: ptr(1440), Height: ptr(880)},
				{Name: "login-phone.png", Url: ptr(simSVG("login", "#1d4ed8", 150, 300)), Tags: artTags("theme::light", "viewport::phone"), Width: ptr(600), Height: ptr(1200)},
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

// HandleArtifactLog serves the persisted build log ({lines:[...]}) for a settled
// script, mirroring the real server's hand-served route (Server.HandleArtifactLog)
// so the "Show build log" toggle resolves to a real terminal in simulation mode.
// It's addressed by an opaque (script, key) URL the set hands out, so any request
// just returns the canned generation log.
func (s *SimulationServer) HandleArtifactLog(w http.ResponseWriter, r *http.Request) {
	// The key is opaque on the real server; here it lets the failure sets
	// (storybook / dashboard before) resolve to a believable failing log so the
	// red-bordered terminal treatment is documented.
	script, key, _ := artifactPathParts(r)
	lines := simArtifactLog()
	if strings.Contains(key, "error") {
		lines = simArtifactFailedLog(script)
	}
	api.WriteJSON(w, http.StatusOK, struct {
		Lines []api.ArtifactLogLine `json:"lines"`
	}{Lines: lines})
}

func (s *SimulationServer) GetConfig(w http.ResponseWriter, r *http.Request, projectId string, params api.GetConfigParams) {
	resp := api.ConfigResponse{
		Defaults: api.AgentConfig{
			PrePrompt: ptr("Default pre-prompt"),
		},
		ResourceCapacity: configuredResourceCapacity(),
		Agents: map[string]api.AgentConfig{
			"claude": {
				PrePrompt: ptr("Claude pre-prompt"),
				// Allow-listed servers + a per-tool grant + auto-allow-read so the
				// settings MCP picker renders with checked rows, the per-tool list, and
				// the read/write toggle populated.
				Policy: &api.PolicyConfig{
					McpAllowed:       ptr([]string{"github", "linear"}),
					McpToolsAllowed:  ptr([]string{"sentry__list_issues"}),
					McpBlocked:       ptr([]string{"playwright"}),
					McpToolsBlocked:  ptr([]string{"github__delete_repo"}),
					McpAutoAllowRead: ptr(true),
				},
			},
		},
		// Candidate MCP servers discovered on the host/project, driving the
		// settings MCP allow-list picker.
		McpServers: ptr([]api.McpServer{
			{Name: "github", Source: "user"},
			{Name: "linear", Source: "user"},
			{Name: "playwright", Source: "project"},
			{Name: "sentry", Source: "project"},
		}),
	}
	// Seed a multi-line pre-spawn script so the settings screenshot exercises
	// the ShellEditor's bash highlighting and line-number gutter. Only the
	// project scope carries it; the user scope (fetched as the *inherited*
	// config when editing the project) leaves it empty, matching a realistic
	// setup where a project overrides the global default - so the editor isn't
	// shadowed by a redundant "Inherited:" echo of its own value.
	if params.Scope == nil || *params.Scope != api.GetConfigParamsScopeUser {
		resp.Defaults.Sandbox = &api.SandboxConfig{
			PreSpawnScript: ptr("#!/bin/bash\nset -euo pipefail\ncp -r \"$HYDRA_PROJECT_ROOT/pipeline/out\" \"$HYDRA_WORKTREE/pipeline/out\"\n"),
			PreExitScript:  ptr("source \"$HYDRA_WORKTREE/.hydra/emu.env\" 2>/dev/null && scripts/emu-claim-slot.sh release\n"),
			// Hard egress mode with extra allow-listed hosts + a blocked host -
			// drives the settings network screenshot (mode dropdown + allowed/blocked
			// host editors populated).
			Network: &api.NetworkConfig{
				Mode:         ptr(api.Hard),
				AllowedHosts: ptr([]string{"api.internal.example.com", "*.corp.example.com"}),
				BlockedHosts: ptr([]string{"*.tracker.io"}),
			},
		}
		resp.Artifacts = &[]api.ArtifactScript{
			{Name: "screenshots", Script: "cd web\nnpm install\nnode scripts/take-screenshots.ts\n", TimeoutSec: ptr(900)},
		}
		resp.Previews = &[]api.PreviewScript{
			{Name: "demo", Script: "cd web\nnpm install\nnpm run build\ncd ..\ngo run ./ server --simulation --addr \"$HYDRA_PREVIEW_ADDR\"\n", ReadyTimeoutSec: ptr(900)},
		}
		resp.Services = &[]api.ServiceScript{
			{Name: "emu-pool", Script: "scripts/emu-pool.sh up 3 --foreground", Host: ptr(true), MaxRestarts: ptr(3)},
		}
	}
	// Review overrides per scope: the shared forge settings live in the project
	// config, while a personal preference (default action) lives in the local
	// override - so the Review section demonstrates the multi-scope story.
	switch {
	case params.Scope == nil || *params.Scope == api.GetConfigParamsScopeProject:
		resp.Review = &api.ReviewConfig{
			Provider:           ptr("gitlab"),
			PushBranchTemplate: ptr("feat/{issue}-{id}"),
		}
		// Resource limits: a lowered CPU weight plus a hard memory cap in the
		// shared project config, so the Resource limits section renders populated.
		resp.Resources = &api.ResourceLimits{
			CpuWeight: ptr(30),
			MemoryMax: ptr(4096),
		}
	case *params.Scope == api.GetConfigParamsScopeLocal:
		resp.Review = &api.ReviewConfig{DefaultAction: ptr("create_mr")}
	}
	api.WriteJSON(w, http.StatusOK, resp)
}

func (s *SimulationServer) SaveConfig(w http.ResponseWriter, r *http.Request, projectId string, params api.SaveConfigParams) {
	w.WriteHeader(http.StatusOK)
}

func (s *SimulationServer) GetServices(w http.ResponseWriter, r *http.Request, projectId string) {
	// mobile-app's emulator pool has crashed out (exhausted restarts) - drives the
	// failed-service badge and the top-bar warning indicator in the screenshots.
	// Every other project's pool is healthy.
	if projectId == "mobile-app" {
		api.WriteJSON(w, http.StatusOK, api.ServiceStatusResponse{
			Services: []api.ServiceStatus{
				{Name: "emu-pool", Script: "scripts/emu-pool.sh up 3 --foreground", Host: true, State: api.Failed, Restarts: 3, MaxRestarts: 3, Pid: ptr(0),
					Message: ptr("exit status 1 (last output: emulator: ERROR: x86_64 emulation requires hardware acceleration - /dev/kvm not found)")},
			},
		})
		return
	}
	api.WriteJSON(w, http.StatusOK, api.ServiceStatusResponse{
		Services: []api.ServiceStatus{
			{Name: "emu-pool", Script: "scripts/emu-pool.sh up 3 --foreground", Host: true, State: api.Up, Restarts: 0, MaxRestarts: 3, Pid: ptr(40123)},
		},
	})
}

func (s *SimulationServer) RestartServices(w http.ResponseWriter, r *http.Request, projectId string) {
	s.GetServices(w, r, projectId)
}

// simPreviewVersion mirrors the real endpoints' version labelling: the head's
// live worktree ("uncommitted") unless a specific ref is requested.
func simPreviewVersion(headRef *string, includeUncommitted *bool) string {
	if includeUncommitted != nil && *includeUncommitted {
		return "uncommitted"
	}
	if headRef != nil && len(*headRef) >= 8 {
		return (*headRef)[:8]
	}
	return "1a2b3c4d"
}

// simPreviewStatus renders the mock "demo" preview. A never-started instance is
// stopped; once started, each poll advances it: three polls of "starting" (with
// a growing build log), then "running" with a URL pointing back at this very
// sim server (so Open shows something real).
func (s *SimulationServer) simPreviewStatus(r *http.Request, agentID, version string) api.PreviewStatus {
	s.previewMu.Lock()
	defer s.previewMu.Unlock()
	polls, started := 0, false
	if s.previewPolls != nil {
		polls, started = s.previewPolls[agentID+"/"+version]
		if started {
			s.previewPolls[agentID+"/"+version] = polls + 1
		}
	}
	st := api.PreviewStatus{Name: "demo", State: api.PreviewStopped, Version: version}
	if !started {
		return st
	}
	buildLog := []api.ArtifactLogLine{
		{Text: "$ bun install --frozen-lockfile", Stream: api.Stdout},
		{Text: "$ bun run build", Stream: api.Stdout},
		{Text: "vite v5.4.2 building for production...", Stream: api.Stdout},
	}
	if polls < 3 {
		st.State = api.PreviewStarting
		st.Pid = ptr(40321)
		st.StartedAt = ptr(simNow().Add(-8 * time.Second))
		st.Progress = ptr("building frontend")
		st.Log = &buildLog
		return st
	}
	st.State = api.PreviewRunning
	st.Pid = ptr(40321)
	st.StartedAt = ptr(simNow().Add(-42 * time.Second))
	st.Connections = ptr(1)
	// Protocol-relative, mirroring the real previewURL: the link follows the
	// page's scheme (http on the LAN, https behind a TLS front).
	st.Url = ptr("//" + r.Host + "/")
	// The "Latest changes" (uncommitted) channel runs in its own checkout that
	// mirrors the live worktree; show it going stale so the restart affordance
	// is exercised in the sim.
	if version == "uncommitted" {
		st.Stale = ptr(true)
	}
	return st
}

func (s *SimulationServer) GetAgentPreviews(w http.ResponseWriter, r *http.Request, projectId string, id string, params api.GetAgentPreviewsParams) {
	version := simPreviewVersion(params.HeadRef, params.IncludeUncommitted)
	api.WriteJSON(w, http.StatusOK, api.PreviewsResponse{
		Previews: []api.PreviewStatus{s.simPreviewStatus(r, id, version)},
	})
}

func (s *SimulationServer) StartAgentPreview(w http.ResponseWriter, r *http.Request, projectId string, id string, name string, params api.StartAgentPreviewParams) {
	version := simPreviewVersion(params.HeadRef, params.IncludeUncommitted)
	s.previewMu.Lock()
	if s.previewPolls == nil {
		s.previewPolls = map[string]int{}
	}
	if _, ok := s.previewPolls[id+"/"+version]; !ok {
		s.previewPolls[id+"/"+version] = 0
	}
	s.previewMu.Unlock()
	api.WriteJSON(w, http.StatusOK, s.simPreviewStatus(r, id, version))
}

func (s *SimulationServer) StopAgentPreview(w http.ResponseWriter, r *http.Request, projectId string, id string, name string, params api.StopAgentPreviewParams) {
	version := simPreviewVersion(params.HeadRef, params.IncludeUncommitted)
	s.previewMu.Lock()
	if s.previewPolls != nil {
		delete(s.previewPolls, id+"/"+version)
	}
	s.previewMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// RestartServer is a no-op in simulation: it answers as the real server would
// and stays running, so the UI's restart flow (toast, health poll, reload) can
// be driven and screenshotted without a process actually going away.
func (s *SimulationServer) RestartServer(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusAccepted)
}

// UpdateServer simulates a rebuild. The point of simulation mode is to be able
// to drive and screenshot UI that is otherwise awkward to reach, and the update
// panel - phases, a streaming build log, a failure that leaves the server alive -
// is exactly that. Every third run fails, so the error path is reachable too.
func (s *SimulationServer) UpdateServer(w http.ResponseWriter, _ *http.Request) {
	s.updateMu.Lock()
	if s.updateRunning {
		s.updateMu.Unlock()
		api.WriteError(w, http.StatusConflict, "An update is already running")
		return
	}
	s.updateRunning = true
	s.updateRuns++
	fail := s.updateRuns%3 == 0
	s.updateHistory = nil
	s.updateMu.Unlock()

	w.WriteHeader(http.StatusAccepted)
	go s.runSimulatedUpdate(fail)
}

// simulatedUpdateLog is the build output the fake update replays, close enough
// in shape and volume to a real `mage build` for the panel to be laid out
// against.
var simulatedUpdateLog = []string{
	"$ mage build",
	"$ go mod download",
	"$ pushd web && aube install && popd",
	"aube 1.29.1 by jdx.dev · ✓ Already up to date (442 packages)",
	"$ pushd web && aube run build && popd",
	"> hydra@0.0.0 build-fonts",
	"fonts: already built (9 faces) - nothing to do",
	"> hydra@0.0.0 generate-openapi",
	"> hydra@0.0.0 generate-tanstack-router",
	"vite v7.1.5 building for production...",
	"transforming...",
	"✓ 3184 modules transformed.",
	"rendering chunks...",
	"computing gzip size...",
	"dist/index.html                    1.42 kB",
	"dist/assets/index-tkXwjxux.js    394.77 kB │ map: 1,284.10 kB",
	"✓ built in 18.42s",
	"$ go generate ./...",
	"$ go build ./...",
	"$ go build -o /home/you/.local/bin/hydra.new ./",
}

func (s *SimulationServer) runSimulatedUpdate(fail bool) {
	emit := func(ev selfupdate.Event) {
		s.updateMu.Lock()
		s.updateHistory = append(s.updateHistory, ev)
		for ch := range s.updateSubs {
			select {
			case ch <- ev:
			default:
			}
		}
		s.updateMu.Unlock()
	}

	emit(selfupdate.Event{Kind: selfupdate.KindPhase, Phase: selfupdate.PhaseBuilding})
	for i, line := range simulatedUpdateLog {
		time.Sleep(180 * time.Millisecond)
		emit(selfupdate.Event{Kind: selfupdate.KindLog, Line: line})
		if fail && i == 12 {
			emit(selfupdate.Event{Kind: selfupdate.KindLog, Line: "internal/heads/heads.go:412:9: undefined: resumeHeed"})
			emit(selfupdate.Event{Kind: selfupdate.KindDone, Error: "go build ./... failed: exit status 1"})
			s.finishSimulatedUpdate()
			return
		}
	}

	emit(selfupdate.Event{Kind: selfupdate.KindPhase, Phase: selfupdate.PhaseVerifying})
	time.Sleep(500 * time.Millisecond)
	emit(selfupdate.Event{Kind: selfupdate.KindLog, Line: "verified: hydra version 0.1.0"})

	emit(selfupdate.Event{Kind: selfupdate.KindPhase, Phase: selfupdate.PhaseSwapping})
	time.Sleep(300 * time.Millisecond)
	emit(selfupdate.Event{Kind: selfupdate.KindLog, Line: "installed /home/you/.local/bin/hydra (previous kept as hydra.prev)"})

	// A real update re-execs here and the socket dies without a done frame. The
	// simulation has nothing to re-exec into, so it says done and stays up.
	emit(selfupdate.Event{Kind: selfupdate.KindPhase, Phase: selfupdate.PhaseRestarting})
	time.Sleep(400 * time.Millisecond)
	emit(selfupdate.Event{Kind: selfupdate.KindDone})
	s.finishSimulatedUpdate()
}

func (s *SimulationServer) finishSimulatedUpdate() {
	s.updateMu.Lock()
	s.updateRunning = false
	s.updateMu.Unlock()
}

// HandleServerUpdateWS mirrors Server.HandleServerUpdateWS against the simulated
// job, replaying what has already happened so a late subscriber catches up.
func (s *SimulationServer) HandleServerUpdateWS(w http.ResponseWriter, r *http.Request) {
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ch := make(chan selfupdate.Event, 256)
	s.updateMu.Lock()
	for _, ev := range s.updateHistory {
		select {
		case ch <- ev:
		default:
		}
	}
	if s.updateSubs == nil {
		s.updateSubs = map[chan selfupdate.Event]struct{}{}
	}
	s.updateSubs[ch] = struct{}{}
	s.updateMu.Unlock()

	defer func() {
		s.updateMu.Lock()
		delete(s.updateSubs, ch)
		s.updateMu.Unlock()
	}()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	for {
		select {
		case <-done:
			return
		case <-r.Context().Done():
			return
		case ev := <-ch:
			_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := conn.WriteJSON(ev); err != nil {
				return
			}
			if ev.Kind == selfupdate.KindDone {
				return
			}
		}
	}
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

// simChatImageB64 is a tiny gradient PNG (base64) used by the simulated chat's
// image-Read tool_result, so the chat pane's inline-image output path (item 4)
// can be exercised without a real file.
const simChatImageB64 = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAKZ0lEQVR42hXPYQfCDAIA4Pud55zX67xOMklmZmaSSTKZSTJJJpmZJEmSJOf+1d3Th+cHPH/779+j//2HLx/evHjy4M6NKxfO9HS0nDjScGDPjpotG9ZUlKwoWLJgTs6MKRkpCTERIRPGjAgYMuBv//2HAF8+vHnx5MGdG1cunOnpaDlxpOHAnh01WzasqShZUbBkwZycGVMyUhJiIkImjBkRMGTwj1/gnwJ8+fDmxZMHd25cuXCmp6PlxJGGA3t21GzZsKaiZEXBkgVzcmZMyUhJiIkImTBmRMCQwT9/gT8E+PLhzYsnD+7cuHLhTE9Hy4kjDQf27KjZsmFNRcmKgiUL5uTMmJKRkhATETJhzIiAIYM/foE/Bfjy4c2LJw/u3Lhy4UxPR8uJIw0H9uyo2bJhTUXJioIlC+bkzJiSkZIQExEyYcyIgCGDP3+Bfwnw5cObF08e3Llx5cKZno6WE0caDuzZUbNlw5qKkhUFSxbMyZkxJSMlISYiZMKYEQFDBv/6Bf4S4MuHNy+ePLhz48qFMz0dLSeONBzYs6Nmy4Y1FSUrCpYsmJMzY0pGSkJMRMiEMSMChgziXyAR4MuHNy+ePLhz48qFMz0dLSeONBzYs6Nmy4Y1FSUrCpYsmJMzY0pGSkJMRMiEMSMChgySXyAV4MuHNy+ePLhz48qFMz0dLSeONBzYs6Nmy4Y1FSUrCpYsmJMzY0pGSkJMRMiEMSMChgzSXyAT4MuHNy+ePLhz48qFMz0dLSeONBzYs6Nmy4Y1FSUrCpYsmJMzY0pGSkJMRMiEMSMChgyyX2AqwJcPb148eXDnxpULZ3o6Wk4caTiwZ0fNlg1rKkpWFCxZMCdnxpSMlISYiJAJY0YEDBlMf4GZAF8+vHnx5MGdG1cunOnpaDlxpOHAnh01WzasqShZUbBkwZycGVMyUhJiIkImjBkRMGQw+wVyAb58ePPiyYM7N65cONPT0XLiSMOBPTtqtmxYU1GyomDJgjk5M6ZkpCTERIRMGDMiYMgg/wXmAnz58ObFkwd3bly5cKano+XEkYYDe3bUbNmwpqJkRcGSBXNyZkzJSEmIiQiZMGZEwJDB/BdYCPDlw5sXTx7cuXHlwpmejpYTRxoO7NlRs2XDmoqSFQVLFszJmTElIyUhJiJkwpgRAUMGi19gKcCXD29ePHlw58aVC2d6OlpOHGk4sGdHzZYNaypKVhQsWTAnZ8aUjJSEmIiQCWNGBAwZLH+BQoAvH968ePLgzo0rF870dLScONJwYM+Omi0b1lSUrChYsmBOzowpGSkJMREhE8aMCBgyKH6BlQBfPrx58eTBnRtXLpzp6Wg5caThwJ4dNVs2rKkoWVGwZMGcnBlTMlISYiJCJowZETBksPoFSgG+fHjz4smDOzeuXDjT09Fy4kjDgT07arZsWFNRsqJgyYI5OTOmZKQkxESETBgzImDIoPwFKgG+fHjz4smDOzeuXDjT09Fy4kjDgT07arZsWFNRsqJgyYI5OTOmZKQkxESETBgzImDIoPoF1gJ8+fDmxZMHd25cuXCmp6PlxJGGA3t21GzZsKaiZEXBkgVzcmZMyUhJiIkImTBmRMCQwfoX2Ajw5cObF08e3Llx5cKZno6WE0caDuzZUbNlw5qKkhUFSxbMyZkxJSMlISYiZMKYEQFDBptfYCvAlw9vXjx5cOfGlQtnejpaThxpOLBnR82WDWsqSlYULFkwJ2fGlIyUhJiIkAljRgQMGWx/gVqALx/evHjy4M6NKxfO9HS0nDjScGDPjpotG9ZUlKwoWLJgTs6MKRkpCTERIRPGjAgYMqh/gZ0AXz68efHkwZ0bVy6c6eloOXGk4cCeHTVbNqypKFlRsGTBnJwZUzJSEmIiQiaMGREwZLD7BfYCfPnw5sWTB3duXLlwpqej5cSRhgN7dtRs2bCmomRFwZIFc3JmTMlISYiJCJkwZkTAkMH+FzgI8OXDmxdPHty5ceXCmZ6OlhNHGg7s2VGzZcOaipIVBUsWzMmZMSUjJSEmImTCmBEBQwaHX6AR4MuHNy+ePLhz48qFMz0dLSeONBzYs6Nmy4Y1FSUrCpYsmJMzY0pGSkJMRMiEMSMChgyaX+AowJcPb148eXDnxpULZ3o6Wk4caTiwZ0fNlg1rKkpWFCxZMCdnxpSMlISYiJAJY0YEDBkcf4GTAF8+vHnx5MGdG1cunOnpaDlxpOHAnh01WzasqShZUbBkwZycGVMyUhJiIkImjBkRMGRw+gVaAb58ePPiyYM7N65cONPT0XLiSMOBPTtqtmxYU1GyomDJgjk5M6ZkpCTERIRMGDMiYMig/QU6Ab58ePPiyYM7N65cONPT0XLiSMOBPTtqtmxYU1GyomDJgjk5M6ZkpCTERIRMGDMiYMig+wV6Ab58ePPiyYM7N65cONPT0XLiSMOBPTtqtmxYU1GyomDJgjk5M6ZkpCTERIRMGDMiYMig/wXOAnz58ObFkwd3bly5cKano+XEkYYDe3bUbNmwpqJkRcGSBXNyZkzJSEmIiQiZMGZEwJDB+Re4CPDlw5sXTx7cuXHlwpmejpYTRxoO7NlRs2XDmoqSFQVLFszJmTElIyUhJiJkwpgRAUMGl1/gKsCXD29ePHlw58aVC2d6OlpOHGk4sGdHzZYNaypKVhQsWTAnZ8aUjJSEmIiQCWNGBAwZXH+BmwBfPrx58eTBnRtXLpzp6Wg5caThwJ4dNVs2rKkoWVGwZMGcnBlTMlISYiJCJowZETBkcPsF7gJ8+fDmxZMHd25cuXCmp6PlxJGGA3t21GzZsKaiZEXBkgVzcmZMyUhJiIkImTBmRMCQAf8H+AFiWl2h3ycAAAAASUVORK5CYII="

func sendSimChatEvent(conn *safeConn, seq int64, eventType string, payload map[string]any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	writeFrame(conn, api.ChatEventFrame{Type: api.ChatEventFrameTypeChatEvent, Event: api.ChatEvent{
		Seq: uint64(seq), Type: eventType, Timestamp: simNow().Add(time.Duration(seq) * time.Millisecond), Payload: raw,
	}})
}

// handleSimCodexChatWS replays deliberately provider-neutral Codex shapes. Its
// tool payloads carry the status (and, for the command, the `_raw` native item)
// that codexToolPayload always sends: that pair is what tells the chat a card
// came from Codex rather than Claude, so the Raw panel shows Codex's own item
// instead of an Anthropic block it never sent.
// It
// includes the regressions that are otherwise difficult to reproduce on demand:
// a rich multi-file edit, a spawn whose transport result is merely "completed",
// and a later closeAgent control that must remain an ordinary tool rather than
// creating an empty child conversation.
func handleSimCodexChatWS(conn *safeConn) {
	// Deliberately override the settled REST state first: only the later
	// normalized terminal turn event can return this live connection to finished.
	sendStatusUpdate(conn, "running")
	// Mid-response attach: the daemon reports the block already in flight in its
	// snapshot; the live stream below only carries this block's remaining
	// deltas. The seeded prefix must render immediately and the continuation
	// must land in the SAME bubble, settling to one message.
	writeFrame(conn, api.ChatStateSnapshotFrame{Type: api.StateSnapshot, State: api.ChatProjection{
		Version:   1,
		Subagents: map[string]api.ChatSubagentState{},
		Stream: &api.ChatStreamState{
			Kind: api.Text, MessageId: "sim-codex-seed", Text: "This reply began before you attached",
		},
	}})
	events := []struct {
		typ string
		p   map[string]any
	}{
		{"conversation_started", map[string]any{"model": ""}},
		{"user_message", map[string]any{"id": "sim-codex-user", "content": simAgentCodexPrompt}},
		{"assistant_delta", map[string]any{"message_id": "sim-codex-seed", "text": " and finished after."}},
		{"assistant_message", map[string]any{"message_id": "sim-codex-seed", "text": "This reply began before you attached and finished after."}},
		{"tool_started", map[string]any{"id": "sim-codex-bash", "name": "Bash", "status": "in_progress", "input": map[string]any{"command": "/usr/bin/bash -lc 'command -v bun || true'", "cwd": ".", "_raw": map[string]any{"id": "sim-codex-bash", "item_type": "command_execution", "command": "/usr/bin/bash -lc 'command -v bun || true'", "cwd": ".", "status": "in_progress"}}}},
		{"tool_completed", map[string]any{"id": "sim-codex-bash", "name": "Bash", "output": "", "status": "completed"}},
		{"tool_started", map[string]any{"id": "sim-codex-edit", "name": "Edit", "status": "in_progress", "input": map[string]any{"changes": []any{
			map[string]any{"path": "docs/chat-mode.md", "kind": map[string]any{"type": "update"}, "diff": "@@ -1 +1 @@\n-# Chat mode\n+# Chat mode internals\n"},
			map[string]any{"path": "internal/chat/store.go", "kind": map[string]any{"type": "update"}, "diff": "@@ -1 +1 @@\n-package chat\n+package chat\n"},
		}}}},
		{"tool_completed", map[string]any{"id": "sim-codex-edit", "name": "Edit", "output": "Files updated", "status": "completed"}},
		{"tool_started", map[string]any{"id": "sim-codex-single-edit", "name": "Edit", "status": "in_progress", "input": map[string]any{"changes": []any{
			map[string]any{"path": "TOOL_DEMO.md", "kind": map[string]any{"type": "update"}, "diff": "@@ -1 +1 @@\n-draft\n+complete\n"},
		}}}},
		{"tool_completed", map[string]any{"id": "sim-codex-single-edit", "name": "Edit", "output": "File updated", "status": "completed"}},
		{"tool_started", map[string]any{"id": "sim-codex-write", "name": "Write", "status": "in_progress", "input": map[string]any{"changes": []any{
			map[string]any{"path": "docs/sim-added.md", "kind": map[string]any{"type": "add"}, "diff": "# Added document\n First character and indentation preserved\n+literal plus preserved\n"},
		}}}},
		{"tool_completed", map[string]any{"id": "sim-codex-write", "name": "Write", "output": "File updated", "status": "completed"}},
		// Codex imageView has no image result block: its path must flow through
		// the agent-file endpoint into the shared tool-result image viewer.
		{"tool_started", map[string]any{"id": "sim-codex-image", "name": "View Image", "status": "in_progress", "input": map[string]any{"path": "/tmp/codex-screenshot@2x.png", "_raw": map[string]any{"id": "sim-codex-image", "type": "imageView", "path": "/tmp/codex-screenshot@2x.png"}}}},
		{"tool_completed", map[string]any{"id": "sim-codex-image", "name": "View Image", "output": "", "status": "completed"}},
		{"tool_started", map[string]any{"id": "sim-codex-spawn", "name": "Agent", "input": map[string]any{"prompt": "Inspect chat replay and report the key invariant.", "description": "Inspect chat replay", "_raw": map[string]any{"tool": "spawnAgent"}}}},
		{"subagent_started", map[string]any{"id": "sim-codex-child", "parent_item_id": "sim-codex-spawn", "agent_type": "codex", "description": "Inspect chat replay", "prompt": "Inspect chat replay and report the key invariant.", "status": "running"}},
		{"assistant_message", map[string]any{"message_id": "sim-codex-child-report", "agent_id": "sim-codex-child", "parent_item_id": "sim-codex-spawn", "sidechain": true, "text": "Replay uses the same sequenced normalized events as live delivery."}},
		{"notice", map[string]any{"text": "<task-notification><task-id>sim-codex-child</task-id><tool-use-id>sim-codex-spawn</tool-use-id><status>completed</status><summary>Agent &quot;Inspect chat replay&quot; finished</summary><output-file>/tmp/sim-codex-child.output</output-file></task-notification>"}},
		{"subagent_completed", map[string]any{"id": "sim-codex-child", "parent_item_id": "sim-codex-spawn", "agent_type": "codex", "status": "completed"}},
		{"tool_completed", map[string]any{"id": "sim-codex-spawn", "name": "Agent", "output": "completed", "status": "completed"}},
		{"tool_started", map[string]any{"id": "sim-codex-close", "name": "CloseAgent", "input": map[string]any{"agent_id": "sim-codex-child", "_raw": map[string]any{"tool": "closeAgent"}}}},
		{"tool_completed", map[string]any{"id": "sim-codex-close", "name": "CloseAgent", "output": "Agent closed", "status": "completed"}},
		// Compatibility regression: old Claude logs incorrectly followed a
		// background-command notice with this lifecycle event. The notice's
		// output-file must keep it out of the sub-agent projection on replay.
		{"notice", map[string]any{"text": "<task-notification><task-id>sim-background-command</task-id><status>completed</status><summary>Background command completed</summary><output-file>/tmp/sim-background-command.log</output-file></task-notification>"}},
		{"subagent_completed", map[string]any{"id": "sim-background-command", "status": "completed"}},
		// Opus can report a real measured reasoning span without exposing any
		// reasoning text. The UI must still render its duration-only thought.
		{"reasoning_completed", map[string]any{"message_id": "sim-hidden-reasoning", "text": ""}},
		{"reasoning_duration", map[string]any{"message_id": "sim-hidden-reasoning", "duration_ms": 4200}},
		{"assistant_message", map[string]any{"message_id": "sim-codex-final", "text": "Codex event replay completed with one sub-agent and no orphan cards."}},
		// A merge commit that dragged main in: it must render as ONE collapsed chip
		// ("Merged main - N commits") that expands to the merged-in commits, not a
		// flood of per-commit chips.
		{"commit_created", map[string]any{
			"head": "aa11bb22", "sha": "aa11bb22cc33dd44ee55ff6677889900aabbccdd", "short_sha": "aa11bb2",
			"subject": "Merge branch 'main' into hydra/codex-demo", "author_name": "Agent Codex",
			"author_email": "codex@hydra.ai", "timestamp": simNow().Add(-2 * time.Minute).Format(time.RFC3339),
			"is_merge": true, "merged_count": 3, "merged_commits": []map[string]any{
				{"sha": "1111111111111111111111111111111111111111", "short_sha": "1111111", "subject": "Bump dependencies to latest patch releases", "author_name": "Maintainer", "timestamp": simNow().Add(-50 * time.Minute).Format(time.RFC3339)},
				{"sha": "2222222222222222222222222222222222222222", "short_sha": "2222222", "subject": "Tidy up the egress proxy logging", "author_name": "Maintainer", "timestamp": simNow().Add(-55 * time.Minute).Format(time.RFC3339)},
				{"sha": "3333333333333333333333333333333333333333", "short_sha": "3333333", "subject": "Fix a flaky terminal resize test", "author_name": "Maintainer", "timestamp": simNow().Add(-60 * time.Minute).Format(time.RFC3339)},
			},
		}},
		{"turn_completed", map[string]any{"id": "sim-codex-turn", "status": "completed"}},
		{"user_message", map[string]any{"id": "sim-codex-interrupt-user", "content": []map[string]any{{"type": "text", "text": "Start an answer that I will interrupt."}}}},
		{"turn_started", map[string]any{"id": "sim-codex-interrupt-turn", "status": "running"}},
		{"assistant_delta", map[string]any{"message_id": "sim-codex-partial", "text": "This partial answer remains visible"}},
		{"assistant_message", map[string]any{"message_id": "sim-codex-partial", "text": "This partial answer remains visible", "partial": true}},
		// Legacy compatibility: older normalized logs retained the cancellation
		// status but labelled this event turn_completed.
		{"turn_completed", map[string]any{"id": "sim-codex-interrupt-turn", "status": "cancelled"}},
		{"turn_started", map[string]any{"id": "sim-codex-error-turn", "status": "running"}},
		{"turn_error", map[string]any{"error": map[string]any{
			"message":        `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The selected model is unavailable for this account."}}`,
			"codexErrorInfo": "other",
		}}},
		{"turn_failed", map[string]any{"id": "sim-codex-error-turn", "status": "failed", "error": map[string]any{
			"message":        `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The selected model is unavailable for this account."}}`,
			"codexErrorInfo": "other",
		}}},
	}
	for i, event := range events {
		sendSimChatEvent(conn, int64(i+1), event.typ, event.p)
	}
	sendReplayDone(conn)
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

// simQueuedMsg is one held message in the sim's stand-in chat queue.
type simQueuedMsg struct {
	ID      string          `json:"id"`
	Content json.RawMessage `json:"content"`
	Origin  string          `json:"origin,omitempty"`
}

// The sim's cross-connection chat message queue: a process-lifetime stand-in for
// the daemon's disk-persisted ChatQueue, so the queued-message flows (surviving a
// reconnect, dequeue/recall) can be exercised in --simulation. Keyed by session.
var (
	simChatQueueMu sync.Mutex
	simChatQueues  = map[string][]simQueuedMsg{}
)

func simQueueList(id string) []simQueuedMsg {
	simChatQueueMu.Lock()
	defer simChatQueueMu.Unlock()
	return append([]simQueuedMsg(nil), simChatQueues[id]...)
}

func simQueueAppend(id string, m simQueuedMsg) {
	simChatQueueMu.Lock()
	defer simChatQueueMu.Unlock()
	simChatQueues[id] = append(simChatQueues[id], m)
}

func simQueueRemove(id, msgID string) {
	simChatQueueMu.Lock()
	defer simChatQueueMu.Unlock()
	q := simChatQueues[id]
	for i, m := range q {
		if m.ID == msgID {
			simChatQueues[id] = append(q[:i:i], q[i+1:]...)
			return
		}
	}
}

func simQueuePopAll(id string) []simQueuedMsg {
	simChatQueueMu.Lock()
	defer simChatQueueMu.Unlock()
	q := simChatQueues[id]
	delete(simChatQueues, id)
	return q
}

// sendSimQueueFrame relays the session's current queue snapshot (the frame the
// daemon sends after replay_done and on reconnect).
func sendSimQueueFrame(conn *safeConn, id string) {
	// Built through the generated frame type, so the simulation cannot send a
	// shape the schema forbids - an empty queue is [], never null.
	msgs := make([]api.ChatQueuedMessage, 0, len(simQueueList(id)))
	for _, m := range simQueueList(id) {
		msgs = append(msgs, api.ChatQueuedMessage{Id: m.ID, Content: m.Content, Origin: m.Origin})
	}
	writeFrame(conn, api.ChatQueueFrame{Type: api.Queue, Messages: msgs})
}

// readSimChatClientMsg blocks for the next parseable text frame; ok=false on
// socket death.
func readSimChatClientMsg(conn *safeConn) (api.ChatClientMessage, bool) {
	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			return api.ChatClientMessage{}, false
		}
		if msgType != websocket.TextMessage {
			continue
		}
		var msg api.ChatClientMessage
		if json.Unmarshal(data, &msg) != nil || msg.Type == "" {
			continue
		}
		return msg, true
	}
}

// firstTextBlock extracts the first text block's text from a user_message
// content array ("" when there is none).
func firstTextBlock(content json.RawMessage) string {
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	for _, b := range blocks {
		if b.Type == "text" {
			return b.Text
		}
	}
	return ""
}

// simAskImplMarkdown is the big markdown-heavy block agent-ask types out slowly
// at the end of its implementation turn. It deliberately exercises a broad slice
// of the chat markdown renderer so the demo doubles as a manual test surface:
// h2/h3 headings, an ordered (1-4) list, an unordered list, bold/italic/
// strikethrough + inline code, a GFM table (which also shows off the shrink-to-
// content table width), a fenced code block, a blockquote and a link.
var simAskImplMarkdown = strings.Join([]string{
	"## Config override resolution",
	"",
	"The loader now merges three layers, **last wins**:",
	"",
	"1. `config.toml` - the committed base, checked in for everyone.",
	"2. `config.<env>.toml` - per-environment overrides (e.g. `config.prod.toml`).",
	"3. `HYDRA_*` environment variables - the final say, for secrets and one-offs.",
	"4. The merged result is validated *once*, so an override can fill a base gap.",
	"",
	"Each key resolves top-down, so a value present in *all three* ends up taking",
	"the environment variable. Keys only the base defines pass through untouched,",
	"and ~~partial tables replace wholesale~~ tables now deep-merge field by field.",
	"",
	"### What ships in the first cut",
	"",
	"- **Schema validation** - unknown keys are rejected at load time.",
	"- Friendly errors: `unknown key \"retry.attemps\" (did you mean \"attempts\"?)`.",
	"- A single `Load(root, env)` entry point; callers pass the active environment.",
	"",
	"Worked example - resolving `retry.max_attempts` across the layers:",
	"",
	"| Layer | Source | Value | Effective |",
	"| ----- | ------ | ----: | :-------: |",
	"| Base | config.toml | 3 | |",
	"| Env | config.prod.toml | 5 | " + "✓" + " |",
	"| Var | HYDRA_RETRY_MAX_ATTEMPTS | (unset) | |",
	"",
	"The merge itself is a small recursive pass:",
	"",
	"```go",
	"func merge(dst, src map[string]any) {",
	"    for k, v := range src {",
	"        if sub, ok := v.(map[string]any); ok {",
	"            if d, ok := dst[k].(map[string]any); ok {",
	"                merge(d, sub)",
	"                continue",
	"            }",
	"        }",
	"        dst[k] = v",
	"    }",
	"}",
	"```",
	"",
	"> Note: validation runs on the *merged* result, not each layer - an override",
	"> is allowed to fill in a key the base leaves out.",
	"",
	"Full details live in [the config docs](https://example.com/docs/config). Want",
	"me to add hot-reload next, or wire up secrets interpolation first?",
}, "\n")

// simAskPlanMarkdown is the block agent-ask types out BEFORE it starts working.
// It exists so the demo turn has real prose above its run of steps: reading it
// carries you down the pane, and the steps then land off the bottom of what you
// are reading - which is the case where a fold could shove the text you are
// mid-sentence in (see the scroll-stability checks on the step group).
var simAskPlanMarkdown = strings.Join([]string{
	// Paragraphs are ONE line each: the chat renderer honours a single newline as
	// a line break, so wrapping the source mid-sentence breaks the rendered text
	// in the same place.
	"Before I touch the loader, here is the shape of the change, so the diff doesn't arrive as a surprise.",
	"",
	"### Where the layering goes",
	"",
	"The change starts in [load.go](internal/config/load.go).",
	"",
	"`Load` is the only entry point that reads config today, and every caller passes a project root. That makes it the right seam: it grows an `env` argument, reads the base file exactly as it does now, and then hands the parsed map to a new `applyEnvOverlay` before anything validates it.",
	"",
	"The overlay file is *optional*. A missing `config.<env>.toml` is not an error - it means the environment adds nothing, and the base config stands on its own. Only a malformed one fails the load.",
	"",
	"### The merge rule, precisely",
	"",
	"- **Tables merge** field by field, recursively, so an override can set one key of `[network]` without restating the rest of it.",
	"- **Scalars and arrays replace** wholesale. An `allowed_hosts` in the overlay is the list, not an addition to the base list - the alternative (append) has no way to spell \"remove a host\".",
	"- **Validation runs once**, on the merged result, so an override is allowed to fill in a key the base leaves out.",
	"",
	"That last one is the reason validation moves after the merge rather than staying where it is. Everything else is additive.",
	"",
	"Let me read the loader and the callers before I start.",
}, "\n")

// streamSimAskImplementation streams the large, feature-rich turn agent-ask
// produces once its AskUserQuestion is answered: an opening paragraph, two
// interleaved tool steps with a thinking block between them, then the long
// markdown-heavy block (simAskImplMarkdown) typed in slowly. It exercises the
// live streaming path end to end - assistant deltas feeding the working
// indicator, and a thinking card flipping "Thinking..." -> "Thought for Xs".
func streamSimAskImplementation(conn *safeConn) {
	// A long run of steps on purpose: this is the demo turn for everything that
	// depends on a turn doing a LOT between two things it says - the folded step
	// group, its live count, the failed-step marker, the shell cwd tracking.
	simStreamText(conn, "msg_ask_impl_1", "Locked in. I'll wire the loader to merge the per-environment file over the base and validate the merged result.", 45*time.Millisecond)
	simStreamText(conn, "msg_ask_impl_1b", simAskPlanMarkdown, 30*time.Millisecond)
	simToolStep(conn, "toolu_ask_read", "Read",
		map[string]any{"file_path": "internal/config/load.go"},
		"func Load(root string) (*Config, error) {\n\treturn parseFile(filepath.Join(root, \"config.toml\"))\n}", 900*time.Millisecond, false)
	simStreamThinking(conn, "msg_ask_impl_3", "Load reads a single file today. I'll overlay config.<env>.toml on top via a recursive merge, then validate the merged map against the known keys.", 1600*time.Millisecond)
	simToolStep(conn, "toolu_ask_grep", "Grep",
		map[string]any{"pattern": "config\\.Load\\(", "path": "internal", "output_mode": "files_with_matches"},
		"internal/cli/runtime.go\ninternal/heads/seed.go\ninternal/http/server.go", 700*time.Millisecond, false)
	simToolStep(conn, "toolu_ask_edit", "Edit",
		map[string]any{"file_path": "internal/config/load.go", "old_string": "return parseFile(filepath.Join(root, \"config.toml\"))", "new_string": "base, err := parseFile(filepath.Join(root, \"config.toml\"))\nif err != nil {\n\treturn nil, err\n}\nreturn applyEnvOverlay(base, root, env)"},
		"Applied 1 edit to internal/config/load.go", 1100*time.Millisecond, false)
	simToolStep(conn, "toolu_ask_write", "Write",
		map[string]any{"file_path": "internal/config/overlay.go", "content": "package config\n\n// applyEnvOverlay merges config.<env>.toml over the base config. Keys present\n// in the overlay win; tables merge recursively, scalars and arrays replace.\nfunc applyEnvOverlay(base *Config, root, env string) (*Config, error) {\n\tif env == \"\" {\n\t\treturn base, nil\n\t}\n\tover, err := parseFile(filepath.Join(root, \"config.\"+env+\".toml\"))\n\tif errors.Is(err, fs.ErrNotExist) {\n\t\treturn base, nil\n\t}\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\treturn mergeConfig(base, over), nil\n}\n"},
		"File created successfully at: internal/config/overlay.go", 1000*time.Millisecond, false)
	simToolStep(conn, "toolu_ask_test_1", "Bash",
		map[string]any{"command": "cd internal/config && go test ./...", "description": "Run the config tests"},
		"\u001b[2m$ go test ./...\u001b[0m\n\u001b[31m--- FAIL: TestApplyEnvOverlay\u001b[0m (0.00s)\n    \u001b[2moverlay_test.go:52:\u001b[0m [network].allowed_hosts: expected the overlay's 1 host, got 3 (merged instead of replaced)\n\u001b[31mFAIL\u001b[0m\texit=1", 1300*time.Millisecond, true)
	simStreamThinking(conn, "msg_ask_impl_4d", "Arrays merged when they should replace - mergeConfig recurses into every value, including slices. Replace on a slice, recurse only on tables.", 1200*time.Millisecond)
	simToolStep(conn, "toolu_ask_edit_2", "Edit",
		map[string]any{"file_path": "internal/config/overlay.go", "old_string": "\t\tout[k] = mergeValue(base[k], v)", "new_string": "\t\tif bt, ok := base[k].(map[string]any); ok {\n\t\t\tif ot, ok := v.(map[string]any); ok {\n\t\t\t\tout[k] = mergeTable(bt, ot)\n\t\t\t\tcontinue\n\t\t\t}\n\t\t}\n\t\tout[k] = v"},
		"Applied 1 edit to internal/config/overlay.go", 900*time.Millisecond, false)
	simToolStep(conn, "toolu_ask_test_2", "Bash",
		map[string]any{"command": "go test ./... && go vet ./...", "description": "Re-run the config tests"},
		"\u001b[2m$ go test ./... && go vet ./...\u001b[0m\nok  \tgithub.com/trolleyman/hydra/internal/config\t0.031s", 1200*time.Millisecond, false)
	simToolStep(conn, "toolu_ask_read_2", "Read",
		map[string]any{"file_path": "docs/configuration.md", "offset": 120, "limit": 40},
		"## Layering\n\nConfig is read from the project root. Nothing is layered today: the loader\nreads config.toml and stops.", 700*time.Millisecond, false)
	simToolStep(conn, "toolu_ask_edit_3", "Edit",
		map[string]any{"file_path": "docs/configuration.md", "old_string": "Nothing is layered today: the loader\nreads config.toml and stops.", "new_string": "config.<env>.toml is layered over config.toml when an\nenvironment is named; keys in the overlay win, tables merge, arrays replace."},
		"Applied 1 edit to docs/configuration.md", 800*time.Millisecond, false)
	simStreamText(conn, "msg_ask_impl_5", "That's the merge wired in, the array-replace bug fixed, and the doc updated. Here is the full picture of how a key resolves across the layers:", 45*time.Millisecond)
	simStreamText(conn, "msg_ask_impl_6", simAskImplMarkdown, 70*time.Millisecond)

	sendSimNorm(conn, simTurnDone(simRaw(`{"input_tokens":1400,"output_tokens":3260,"cache_read_input_tokens":41800,"cache_creation_input_tokens":980}`), 0.0714))
}

// --- Simulated approval picker (agent-approvals) ------------------------------

// simApprovalOption is one choice on the picker's question card: the label the
// user clicks and the approval kind it parks.
type simApprovalOption struct {
	label       string
	description string
	kind        string
}

// The picker offers every kind the gate can park, so each card can be looked at
// (and allowed/denied) without a live sandbox to provoke it.
var simApprovalOptions = []simApprovalOption{
	{"Host command", "The escape hatch: run the command above on the host, outside the sandbox.", "host_command"},
	{"MCP tool", "One tool call on an allowed server, with its arguments.", "mcp_tool"},
	{"MCP server", "The first call to a whole MCP server.", "mcp"},
	{"Web fetch", "An outbound fetch - allowing trusts the host for the session.", "webfetch"},
	{"Egress host", "A connection the proxy is holding: the host is on no list.", "egress"},
	{"Unrecognized tool", "A tool Hydra's gate has no rule for.", "tool"},
}

// simApprovalRequest builds the parked request for a picked kind, mirroring what
// the gate (or `hydra host-run`) would have written.
func simApprovalRequest(kind string) (api.ApprovalRequest, bool) {
	req := api.ApprovalRequest{Reqid: "sim-approval-" + kind, Kind: kind, Ts: ptr(simNow().Format(time.RFC3339))}
	switch kind {
	case "host_command":
		req.Tool = "host-run"
		req.Target = simApprovalsHostRun
		req.Reason = ptr("the agent asked to run a command outside its sandbox, on the host")
		req.Description = ptr(simApprovalsHostRunWhy)
		req.Summary = "wants to run a command on the host: I need to see which ports the daemon and its previews are..."
	case "mcp_tool":
		req.Tool = "mcp__linear__create_issue"
		req.Target = "linear__create_issue"
		req.Rw = ptr("write")
		req.ArgsPreview = ptr(`{"title":"Retry uploads with backoff","teamId":"eng","priority":2,"labels":["infra","reliability"]}`)
		req.Reason = ptr("this tool writes, and the server is not on the allow-list")
		req.Summary = "wants to run MCP tool \"linear__create_issue\""
	case "mcp":
		req.Tool = "mcp__github__create_pull_request"
		req.Target = "github"
		req.Reason = ptr("the MCP server is not on this agent's allow-list")
		req.Summary = "wants to use MCP server \"github\""
	case "webfetch":
		req.Tool = "WebFetch"
		req.Target = "docs.anthropic.com"
		req.Url = ptr("https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview")
		req.Reason = ptr("the host is not on this agent's network allow-list")
		req.Summary = "wants to fetch from \"docs.anthropic.com\""
	case "egress":
		req.Tool = "Bash"
		req.Target = "telemetry.example.com"
		req.Reason = ptr("the connection is held at the egress proxy: the host is on neither list")
		req.Summary = "wants to connect to \"telemetry.example.com\""
	case "tool":
		req.Tool = "weather__forecast"
		req.Target = "weather__forecast"
		req.Reason = ptr("Hydra's gate has no rule for this tool")
		req.Summary = "wants to use the unrecognized tool \"weather__forecast\""
	default:
		return api.ApprovalRequest{}, false
	}
	return req, true
}

// simApprovalsQuestion is the picker's AskUserQuestion input (one single-select
// question whose options are the approval kinds).
func simApprovalsQuestion() string {
	options := make([]map[string]string, 0, len(simApprovalOptions))
	for _, o := range simApprovalOptions {
		options = append(options, map[string]string{"label": o.label, "description": o.description})
	}
	input, _ := json.Marshal(map[string]any{"questions": []map[string]any{{
		"question":    "Which approval card should I raise?",
		"header":      "Approval",
		"multiSelect": false,
		"options":     options,
	}}})
	return string(input)
}

// simApprovalsEvents is the canned history for agent-approvals: a `hydra
// host-run` ask left without a result (so the chat shows the host-run card - and
// grows its Allow/Deny row the moment the host_command option is picked), then
// the question card that drives the picker. The last two entries are the
// question + its interaction request, which the handler re-sends to re-ask.
func simApprovalsEvents(questionToolID, requestID string) []simNorm {
	return []simNorm{
		simConversationStarted("claude-opus-4-8", []string{"compact", "context", "cost", "usage"}).
			set("conversation_id", "sim-approvals"),
		simUser("sim-approvals-prompt", simAgentApprovalsPrompt),
		simSay("msg_approvals_1", "Listener check first. I can't see host ports from inside the sandbox, so this one has to go through the escape hatch:"),
		simTool("toolu_approvals_hostrun", "mcp__hydra__host_run", map[string]any{
			"command": simApprovalsHostRun,
			"why":     simApprovalsHostRunWhy,
		}),
		simSay("msg_approvals_2", "Pick a card below and I'll raise it. It behaves like the real thing: a matching tool card grows its own Allow / Deny row, and if you navigate elsewhere the global approval toast keeps the request within reach."),
		simTool(questionToolID, "AskUserQuestion", simRaw(simApprovalsQuestion())),
		{typ: "interaction_requested", payload: map[string]any{
			"provider": "claude", "request_id": requestID,
			"interaction": map[string]any{
				"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "display_name": "AskUserQuestion",
				"input": json.RawMessage(simApprovalsQuestion()), "tool_use_id": questionToolID,
				"requires_user_interaction": true,
			},
		}},
	}
}

// handleSimApprovalsWS speaks the chat framing for agent-approvals: replay the
// transcript, then park the chosen approval kind on every answer and re-ask, so
// the picker stays usable round after round.
func (s *SimulationServer) handleSimApprovalsWS(conn *safeConn) {
	// A fresh connection starts from a clean slate - a card parked by an earlier
	// visit would otherwise still be up with no question card answered for it.
	s.setSimApproval("")
	sendStatusUpdate(conn, "needs_input")
	round := 1
	for _, ev := range simApprovalsEvents("toolu_approvals_q1", "sim-approvals-req-1") {
		sendSimNorm(conn, ev)
	}
	sendReplayDone(conn)

	for {
		msg, ok := readSimChatClientMsg(conn)
		if !ok {
			return
		}
		switch msg.Type {
		case "control_response":
			var payload struct {
				Response struct {
					UpdatedInput struct {
						Answers map[string]string `json:"answers"`
					} `json:"updatedInput"`
				} `json:"response"`
			}
			_ = json.Unmarshal(msg.Response, &payload)
			label := ""
			for _, a := range payload.Response.UpdatedInput.Answers {
				label = a
			}
			picked := ""
			for _, o := range simApprovalOptions {
				if o.label == label {
					picked = o.kind
				}
			}
			s.setSimApproval(picked)
			result := fmt.Sprintf("Raised the %q approval. It is parked until you allow or deny it.", label)
			if picked == "" {
				result = fmt.Sprintf("No approval matches %q.", label)
			}
			sendSimNorm(conn, simToolOut(fmt.Sprintf("toolu_approvals_q%d", round), result))
			// Re-ask, so another kind can be picked without reloading the page.
			round++
			questionToolID := fmt.Sprintf("toolu_approvals_q%d", round)
			requestID := fmt.Sprintf("sim-approvals-req-%d", round)
			events := simApprovalsEvents(questionToolID, requestID)
			for _, ev := range events[len(events)-2:] {
				sendSimNorm(conn, ev)
			}
			sendStatusUpdate(conn, "needs_input")
		case "set_model":
			sendSimChatEvent(conn, int64(nextSimChatSeq()), "model_changed", map[string]any{"model": msg.Model})
		case "interrupt":
			sendSimNorm(conn, simTurnInterrupted())
		case "user_message":
			sendSimChatEvent(conn, int64(nextSimChatSeq()), "user_message", map[string]any{
				"id": fmt.Sprintf("sim-approvals-user-%d", round), "content": msg.Content,
			})
			streamSimReply(conn, fmt.Sprintf("msg_approvals_reply_%d", round), "Simulated reply: pick a card from the question above and I'll raise it.")
		}
	}
}

// --- Simulated AskUserQuestion agent (agent-ask) ------------------------------

// simAskQuestionInput is the AskUserQuestion input the simulated agent-ask
// head is blocked on: one single-select and one multi-select question, with
// option descriptions - exercising the whole question-card surface.
const simAskQuestionInput = `{"questions":[` +
	`{"question":"Which override layering should I implement?","header":"Layering","multiSelect":false,"options":[` +
	`{"label":"Env file per environment","description":"config.<env>.toml next to config.toml; simplest to reason about."},` +
	`{"label":"Single file, [env.<name>] tables","description":"One file holds every environment; easier to diff, heavier to parse."},` +
	`{"label":"Environment variables only","description":"12-factor style; no new files, but nothing is reviewable in-repo."}]},` +
	`{"question":"Which extras should ship in the first cut?","header":"Extras","multiSelect":true,"options":[` +
	`{"label":"Schema validation","description":"Reject unknown keys at load time."},` +
	`{"label":"Hot reload","description":"Watch the files and re-apply without a restart."},` +
	`{"label":"Secrets interpolation","description":"Expand ${VAR} from the process environment."}]}]}`

// simExpiredQuestionInput is an EARLIER question in agent-ask's history that
// never got an answer: the turn behind it ended first (switching model
// mid-question aborts the turn), which is what kills the CLI's control_request.
// Its request_id replays with the transcript forever, so this is the case that
// must render as an expired card rather than a live one.
const simExpiredQuestionInput = `{"questions":[` +
	`{"question":"Where should the override file live?","header":"Location","multiSelect":false,"options":[` +
	`{"label":"Next to config.toml","description":"Same directory, discovered by name."},` +
	`{"label":"Under .hydra/local/","description":"Alongside the other generated state."}]}]}`

// simAskEvents is the canned history for agent-ask: an expired question from an
// abandoned turn, then a native AskUserQuestion (the tool call + its paired
// interaction request) the head is parked waiting on - so the page renders one
// dead card and one live, answerable one.
var simAskEvents = []simNorm{
	simConversationStarted("claude-opus-4-8", []string{"compact", "context", "cost", "init", "review", "usage"}).
		set("conversation_id", "sim-ask"),
	simUser("sim-ask-prompt", simAgentAskPrompt),
	simSay("msg_ask_0", "One thing before I start:"),
	simTool("toolu_ask_0", "AskUserQuestion", simRaw(simExpiredQuestionInput)),
	simAskInteraction("sim-ask-req-0", "toolu_ask_0", simExpiredQuestionInput),
	// The turn ends with the question still unanswered - from here on nothing
	// will ever read a control_response quoting sim-ask-req-0.
	simTurnDone(nil, 0),
	simUser("sim-ask-nevermind", "Never mind that - just pick something sensible and carry on."),
	simThink("msg_ask_1", "The loader currently reads one config.toml. Layering strategy and scope of the first cut are product decisions - ask instead of guessing."),
	simSay("msg_ask_1", "Two decisions are yours before I wire this in - the layering model changes the file layout, and the extras change the loader's surface area. First, a sketch of the override file so we have something concrete to talk about:"),
	// A Write tool call: its content renders as a numbered, syntax-highlighted
	// code block (like a Read), not raw JSON.
	simTool("toolu_ask_write", "Write", simRaw(`{"file_path":"config.local.toml","content":"# Per-environment overrides, layered over config.toml.\n# Keys here win; anything omitted falls through to the base file.\n\n[network]\nmode = \"hard\"\nallowed_hosts = [\"api.internal.example.com\"]\n\n[claude.sandbox]\nwritable_paths = [\"./.cache/local\"]\n\n[tests.unit]\ncommand = \"go test ./... -short\"\n"}`)),
	simToolOut("toolu_ask_write", "File created successfully at: config.local.toml"),
	simTool("toolu_ask_1", "AskUserQuestion", simRaw(simAskQuestionInput)),
	simAskInteraction("sim-ask-req-1", "toolu_ask_1", simAskQuestionInput),
}

// simAskInteraction is the interaction request that pairs with an
// AskUserQuestion call - what parks the head until the card is answered.
func simAskInteraction(requestID, toolUseID, input string) simNorm {
	return simNorm{typ: "interaction_requested", payload: map[string]any{
		"provider": "claude", "request_id": requestID,
		"interaction": map[string]any{
			"subtype": "can_use_tool", "tool_name": "AskUserQuestion", "display_name": "AskUserQuestion",
			"input": json.RawMessage(input), "tool_use_id": toolUseID,
			"requires_user_interaction": true,
		},
	}}
}

// handleSimAskWS speaks the chat framing for agent-ask: replay the pending
// question, then answer the control_response with the tool_result +
// assistant acknowledgement the real CLI would produce.
func (s *SimulationServer) handleSimAskWS(conn *safeConn) {
	sendStatusUpdate(conn, "needs_input")
	for _, ev := range simAskEvents {
		sendSimNorm(conn, ev)
	}
	// Only the second question is still open - the first one's turn ended
	// without it (see simExpiredQuestionInput), which is exactly the
	// distinction the real daemon draws from the live stdout stream.
	writeFrame(conn, api.ChatPendingQuestionsFrame{
		Type:     api.PendingQuestions,
		Requests: []api.ChatPendingAsk{{RequestId: "sim-ask-req-1", ToolUseId: "toolu_ask_1"}},
	})
	sendReplayDone(conn)

	turn := 0
	for {
		msg, ok := readSimChatClientMsg(conn)
		if !ok {
			return
		}
		switch msg.Type {
		case "control_response":
			// An answer to anything but the open question is refused, as the
			// daemon refuses one for a request the CLI has already retired.
			if reqID := claudestream.ControlResponseRequestID(msg.Response); reqID != "sim-ask-req-1" {
				writeFrame(conn, api.ChatQuestionExpiredFrame{Type: api.QuestionExpired, RequestId: reqID})
				continue
			}
			// Extract the answers map (and any per-question notes) the question
			// card submitted.
			var payload struct {
				Response struct {
					UpdatedInput struct {
						Answers     map[string]string `json:"answers"`
						Annotations map[string]struct {
							Notes string `json:"notes"`
						} `json:"annotations"`
					} `json:"updatedInput"`
				} `json:"response"`
			}
			_ = json.Unmarshal(msg.Response, &payload)
			in := payload.Response.UpdatedInput
			// Mirror the real CLI's result text: an unpicked question is
			// "(no option selected)" rather than an empty value, a note trails
			// the answer it qualifies, and any note at all switches the closing
			// sentence to the one that tells the agent to read them carefully.
			questions := make([]string, 0, len(in.Answers)+len(in.Annotations))
			for q := range in.Answers {
				questions = append(questions, q)
			}
			for q := range in.Annotations {
				if _, ok := in.Answers[q]; !ok {
					questions = append(questions, q)
				}
			}
			sort.Strings(questions)
			var parts []string
			noted := false
			for _, q := range questions {
				a, notes := in.Answers[q], in.Annotations[q].Notes
				if a == "" && notes == "" {
					continue
				}
				part := fmt.Sprintf("%q=(no option selected)", q)
				if a != "" {
					part = fmt.Sprintf("%q=%q", q, a)
				}
				if notes != "" {
					part += " notes: " + notes
					noted = true
				}
				parts = append(parts, part)
			}
			sendStatusUpdate(conn, "running")
			resultText := fmt.Sprintf("Your questions have been answered: %s. You can now continue with these answers in mind.", strings.Join(parts, ", "))
			if noted {
				resultText = fmt.Sprintf("The user answered: %s. Read the answers carefully - they may request clarification, changes, or that you not proceed - and follow what they actually say.", strings.Join(parts, ", "))
			}
			sendSimNorm(conn, simToolOut("toolu_ask_1", resultText))
			// Answering the question kicks off the big streamed implementation turn
			// (interleaved tools + thinking, then a long markdown block typed in
			// slowly) so the demo shows a large chat streaming in live. The head's
			// RECORD has to say running for that stretch too, or the live working
			// line above the stream never appears (see askRunning).
			s.askRunning.Store(true)
			streamSimAskImplementation(conn)
			s.askRunning.Store(false)
			sendStatusUpdate(conn, "waiting")
		case "set_model":
			sendSimChatEvent(conn, int64(nextSimChatSeq()), "model_changed", map[string]any{"model": msg.Model})
		case "interrupt":
			sendSimNorm(conn, simTurnInterrupted())
			sendSimNorm(conn, simTurnFailed())
		case "user_message":
			turn++
			sendSimChatEvent(conn, int64(nextSimChatSeq()), "user_message", map[string]any{
				"id": fmt.Sprintf("sim-ask-user-%d", turn), "content": msg.Content,
			})
			streamSimReply(conn, fmt.Sprintf("msg_ask_reply_%d", turn), "Simulated reply: noted. The pending question card above stays answerable.")
		}
	}
}

// --- Simulated long history (agent-history) -----------------------------------

// simAgentHistoryPrompt seeds the long-history demo agent. agent-chat is the
// feature-rich transcript and agent-ask is the one that STREAMS; this one exists
// for the cases that want a lot of conversation and no motion at all - scrolling
// a long pane, step folding at scale, copy-as-markdown, per-agent scroll
// restoration. It replays a finished conversation on attach and then sits
// perfectly still.
const simAgentHistoryPrompt = "Port the storage layer from hand-written SQL to sqlc, one table at a time."

func simAgentHistory() api.AgentResponse {
	createdAt := simNow().Add(-6 * time.Hour).Unix()
	return api.AgentResponse{
		WorkspaceKind: api.WorkspaceKindWorktree,
		Id:            "agent-history",
		Title:         ptr("Port the storage layer to sqlc"),
		AgentType:     "claude",
		BaseBranch:    "main",
		BranchName:    ptr("hydra/sqlc-port"),
		SessionPid:    1009,
		SessionStatus: "running",
		CreatedAt:     &createdAt,
		Prompt:        simAgentHistoryPrompt,
		ChatMode:      ptr(true),
		WorktreePath:  ptr("/repo/.hydra/local/worktrees/sqlc-port"),
		Model:         ptr("claude-opus-4-8"),
		AgentStatus: &api.AgentStatusInfo{
			Status:    api.Finished,
			Timestamp: simNow().Format(time.RFC3339),
		},
	}
}

// simHistoryTables drives the canned conversation: one turn per table, each
// asked for by the user and answered with a run of tool calls. Deliberately
// varied in shape - the step counts, the failing run and the silent turn are
// what make it a fair test of how a long transcript reads.
var simHistoryTables = []struct {
	name    string
	queries int
	note    string
}{
	{"users", 9, "the upsert is the only one with a conflict clause"},
	{"sessions", 6, "two of these join agents, so the generated row structs nest"},
	{"agents", 14, "much the biggest, and the status filter is dynamic"},
	{"projects", 5, "trivial - four selects and an insert"},
	{"artifacts", 11, "the blob column wants []byte, not string"},
	{"tests", 8, "the JUnit rollup is one query with a GROUP BY"},
	{"reviews", 7, "nullable timestamps everywhere; sqlc gives sql.NullTime"},
	{"approvals", 4, "short, but the enum column needs a type override"},
}

// simHistoryEvents builds the canned transcript: for each table a user request,
// a thought, an opening paragraph, a run of tool calls (one of them failing,
// once), a closing paragraph and a turn footer. Everything is derived from the
// table above, so the whole conversation is deterministic - a screenshot of it
// is stable, and it costs a few dozen lines rather than a thousand.
func simHistoryEvents() []simNorm {
	var out []simNorm
	add := func(events ...simNorm) { out = append(out, events...) }
	add(simConversationStarted("claude-opus-4-8", nil).set("conversation_id", "sim-history"))
	add(simUser("sim-history-prompt", simAgentHistoryPrompt))

	for i, t := range simHistoryTables {
		if i > 0 {
			add(simUser(fmt.Sprintf("sim-history-user-%d", i), fmt.Sprintf("Good. Now do %s.", t.name)))
		}
		msg := fmt.Sprintf("msg_hist_%d", i)
		thinkID := msg + "_think"
		// The measured duration precedes its block, as the import order delivers
		// it - the card lands on "Thought for Xs" rather than timing it live.
		add(simThought(thinkID, int64(3000+1700*(i%5))))
		add(simThink(thinkID, fmt.Sprintf(
			"store/%s.go has %d queries; %s. I'll write the .sql file first, generate, then swap the callers over and run the package's tests.",
			t.name, t.queries, t.note)))
		add(simSay(msg+"_open", fmt.Sprintf(
			"Porting **%s** - %d queries. %s.",
			t.name, t.queries, strings.ToUpper(t.note[:1])+t.note[1:])))

		// The run of steps. Its length varies with the table so the folded counts
		// in the transcript are not all the same number.
		steps := []struct {
			name   string
			input  map[string]any
			result string
			failed bool
		}{
			{"Read", map[string]any{"file_path": fmt.Sprintf("internal/store/%s.go", t.name)}, fmt.Sprintf("// %d queries, hand-written\nfunc (s *Store) Get%s(ctx context.Context, id string) (*%s, error) {", t.queries, strings.ToUpper(t.name[:1])+t.name[1:], t.name), false},
			{"Grep", map[string]any{"pattern": fmt.Sprintf("store\\.%s", t.name), "path": "internal", "output_mode": "files_with_matches"}, "internal/http/server.go\ninternal/heads/heads.go", false},
			{"Write", map[string]any{"file_path": fmt.Sprintf("internal/db/query/%s.sql", t.name), "content": fmt.Sprintf("-- name: Get%s :one\nSELECT * FROM %s WHERE id = ? LIMIT 1;\n", strings.ToUpper(t.name[:1])+t.name[1:], t.name)}, fmt.Sprintf("File created successfully at: internal/db/query/%s.sql", t.name), false},
			{"Bash", map[string]any{"command": "sqlc generate", "description": "Regenerate the typed queries"}, fmt.Sprintf("generated %d queries into internal/db/gen", t.queries), false},
			{"Edit", map[string]any{"file_path": fmt.Sprintf("internal/store/%s.go", t.name), "old_string": "rows, err := s.db.QueryContext(ctx, q)", "new_string": fmt.Sprintf("rows, err := s.q.List%s(ctx)", strings.ToUpper(t.name[:1])+t.name[1:])}, fmt.Sprintf("Applied 1 edit to internal/store/%s.go", t.name), false},
			{"Bash", map[string]any{"command": "go test ./internal/store/... ./internal/db/...", "description": "Run the storage tests"}, "ok  \tgithub.com/trolleyman/hydra/internal/store\t0.184s\nok  \tgithub.com/trolleyman/hydra/internal/db\t0.061s", false},
		}
		// A couple of turns do more, so the folded runs differ in size; the
		// biggest table also hits a failure and recovers from it.
		if t.queries > 8 {
			steps = append(steps,
				struct {
					name   string
					input  map[string]any
					result string
					failed bool
				}{"Bash", map[string]any{"command": "go vet ./internal/db/...", "description": "Vet the generated package"}, fmt.Sprintf("internal/db/gen/%s.sql.go:41:2: composite literal uses unkeyed fields", t.name), true},
				struct {
					name   string
					input  map[string]any
					result string
					failed bool
				}{"Edit", map[string]any{"file_path": "sqlc.yaml", "old_string": "emit_empty_slices: false", "new_string": "emit_empty_slices: true\n    emit_result_struct_pointers: true"}, "Applied 1 edit to sqlc.yaml", false},
				struct {
					name   string
					input  map[string]any
					result string
					failed bool
				}{"Bash", map[string]any{"command": "sqlc generate && go vet ./internal/db/...", "description": "Regenerate and re-vet"}, "generated cleanly", false},
			)
		}
		for j, step := range steps {
			useID := fmt.Sprintf("toolu_hist_%d_%d", i, j)
			add(simTool(useID, step.name, step.input))
			if step.failed {
				add(simToolErr(useID, step.result))
			} else {
				add(simToolOut(useID, step.result))
			}
		}

		add(simSay(msg+"_close", fmt.Sprintf(
			"`%s` is on sqlc: %d queries generated, the callers now take the typed rows, and both packages' tests pass. %s",
			t.name, t.queries, map[bool]string{true: "The generator's unkeyed literals needed an `sqlc.yaml` tweak, which applies to every table from here on.", false: "Nothing else in the package touches raw SQL now."}[t.queries > 8])))
		add(simTurnDone(simRaw(fmt.Sprintf(`{"input_tokens":%d,"output_tokens":%d,"cache_read_input_tokens":%d}`, 900+40*i, 1400+120*i, 30000+2000*i)), 0.08+0.02*float64(i)))
	}
	return out
}

// handleSimHistoryWS replays the long finished conversation and then does
// nothing: no live stream, no working indicator, no timers. A message typed into
// it still gets a short canned reply, so the composer is not a dead end.
func handleSimHistoryWS(conn *safeConn) {
	sendStatusUpdate(conn, "finished")
	for _, ev := range simHistoryEvents() {
		sendSimNorm(conn, ev)
	}
	sendReplayDone(conn)
	turn := 0
	for {
		msg, ok := readSimChatClientMsg(conn)
		if !ok {
			return
		}
		switch msg.Type {
		case "user_message":
			turn++
			sendSimChatEvent(conn, int64(nextSimChatSeq()), "user_message", map[string]any{
				"id": fmt.Sprintf("sim-history-live-%d", turn), "content": msg.Content,
			})
			streamSimReply(conn, fmt.Sprintf("msg_hist_reply_%d", turn), "Simulated reply: the sqlc port is done for every table above.")
		case "set_model":
			sendSimChatEvent(conn, int64(nextSimChatSeq()), "model_changed", map[string]any{"model": msg.Model})
		}
	}
}

// --- Simulated mid-turn agent (agent-working) ---------------------------------

// simWorkingEvents is the settled part of agent-working's turn: the prompt, an
// opening paragraph and one finished tool step. Everything after this is
// streamed live by handleSimWorkingWS and never settles into a result.
var simWorkingEvents = []simNorm{
	simConversationStarted("claude-opus-4-8", []string{"compact", "context", "cost", "init", "review", "usage"}).
		set("conversation_id", "sim-working"),
	simUser("sim-working-prompt", simAgentWorkingPrompt),
	simSay("msg_working_1", "Starting from the allocator - the range and the retry behaviour on a busy port are the two things worth writing down precisely."),
	simTool("toolu_working_grep", "Grep", simRaw(`{"pattern":"26601|previewPortBase","path":"internal/preview"}`)),
	simToolOut("toolu_working_grep", "internal/preview/ports.go:18: const previewPortBase = 26601\ninternal/preview/ports.go:19: const previewPortCount = 99"),
}

// simWorkingThoughts is the trickle of thinking text the parked turn keeps
// producing, cycled forever a line at a time.
var simWorkingThoughts = []string{
	"ports.go hands out 26601-26699, so 99 slots shared across every project on the box. ",
	"The allocator walks the range and probes each candidate with a listen, which means a port held by a non-Hydra process is skipped rather than fought over. ",
	"Worth stating explicitly that the web UI itself sits on 26600, just below the range - people keep reading it as part of the pool. ",
	"Exhaustion is the interesting case: the spawn fails with a clear error instead of blocking, and nothing is reserved, so a retry can succeed the moment a head is killed. ",
	"A head that dies without cleanup leaves no reservation behind either - the probe is the only source of truth. ",
}

// handleSimWorkingWS speaks the chat framing for agent-working: replay the
// settled part of the turn, then stay in flight forever - a tool card left
// running, a thinking block that keeps streaming, and a token count that keeps
// climbing. It deliberately never emits a result, so the live working line
// stays up for as long as the page is open.
func handleSimWorkingWS(conn *safeConn) {
	sendStatusUpdate(conn, "running")
	for _, ev := range simWorkingEvents {
		sendSimNorm(conn, ev)
	}
	sendReplayDone(conn)

	// The client still sends (queued messages, model switches, interrupts); drain
	// them so the socket stays healthy, and stop streaming when it goes away.
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		for {
			msg, ok := readSimChatClientMsg(conn)
			if !ok {
				return
			}
			// An interrupt is the one thing that legitimately ends this turn.
			if msg.Type == "interrupt" {
				sendSimNorm(conn, simTurnInterrupted())
				sendSimNorm(conn, simTurnFailed())
				sendStatusUpdate(conn, "waiting")
				return
			}
		}
	}()

	// sleep returns false once the client is gone, so every pause below doubles
	// as a shutdown check.
	sleep := func(d time.Duration) bool {
		select {
		case <-closed:
			return false
		case <-time.After(d):
			return true
		}
	}
	// A tool call with no result: its card stays in the running state under the
	// live indicator, which is what a real head looks like mid-step.
	if !sleep(1200 * time.Millisecond) {
		return
	}
	sendSimNorm(conn, simTool("toolu_working_read", "Read", simRaw(`{"file_path":"internal/preview/ports.go"}`)))
	if !sleep(1500 * time.Millisecond) {
		return
	}
	sendSimNorm(conn, simToolOut("toolu_working_read", "func allocPort(taken map[int]bool) (int, error) {\n\tfor p := previewPortBase; p < previewPortBase+previewPortCount; p++ {\n\t\tif !taken[p] && probeFree(p) {\n\t\t\treturn p, nil\n\t\t}\n\t}\n\treturn 0, errNoFreePreviewPort\n}"))
	if !sleep(900 * time.Millisecond) {
		return
	}

	// An open thinking block, extended a line at a time forever: the streamed
	// thinking card stays live, "Thinking..." rides in the working line, and the
	// output-token count keeps ticking up. Slow on purpose - the point is the
	// resting state of a working head, not a stress test.
	sendSimNorm(conn, simUsageStart("msg_working_4", 24800))
	tokens := 1
	for i := 0; ; i++ {
		thought := simWorkingThoughts[i%len(simWorkingThoughts)]
		// Type it out word by word so the card visibly grows.
		for chunk := range strings.SplitSeq(thought, " ") {
			if !sleep(90 * time.Millisecond) {
				return
			}
			sendSimNorm(conn, simNorm{typ: "reasoning_delta", payload: map[string]any{"message_id": "msg_working_4", "text": chunk + " "}})
			tokens += 2
			sendSimNorm(conn, simUsageTick(tokens))
		}
		if !sleep(2500 * time.Millisecond) {
			return
		}
	}
}

// HandleTerminalWS handles WebSocket connections for simulated agent terminal access.
func (s *SimulationServer) HandleTerminalWS(w http.ResponseWriter, r *http.Request) {
	// Extract agent ID from path: /ws/projects/{project_id}/agents/{id}/terminal
	agentID := r.PathValue("agent_id")

	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	// The chat-mode demo agents speak the chat framing, not PTY bytes. Their
	// bash tabs (shell=true) still get the plain simulated terminal below.
	if (agentID == "agent-chat" || agentID == "project-directory-edit") && r.URL.Query().Get("shell") != "true" {
		handleSimChatWS(conn)
		return
	}
	if (agentID == "agent-chat-codex" || agentID == "project-directory-readonly") && r.URL.Query().Get("shell") != "true" {
		handleSimCodexChatWS(conn)
		return
	}
	if (agentID == "agent-working" || agentID == "project-directory-working") && r.URL.Query().Get("shell") != "true" {
		handleSimWorkingWS(conn)
		return
	}
	if agentID == "agent-history" && r.URL.Query().Get("shell") != "true" {
		handleSimHistoryWS(conn)
		return
	}
	if agentID == "agent-ask" && r.URL.Query().Get("shell") != "true" {
		s.handleSimAskWS(conn)
		return
	}
	if agentID == "agent-approvals" && r.URL.Query().Get("shell") != "true" {
		s.handleSimApprovalsWS(conn)
		return
	}

	// 1. Simulate sandbox startup. Emit the whole boot transcript in one burst
	// rather than pacing it with sleeps: the screenshot generator captures this
	// terminal, and a wall-clock-paced stream means a capture catches a
	// nondeterministic number of "Step N/3" lines depending on how long its
	// navigate+settle happened to take - which shows up as a spurious diff
	// between the before/after renders. Writing every line up front makes the
	// captured terminal a fixed, complete transcript.
	sendStatusUpdate(conn, "building")
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32m[Simulation] Starting agent "+agentID+"...\x1b[0m\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 1/3: Creating git worktree...\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 2/3: Preparing sandbox...\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("Step 3/3: Launching agent session...\r\n"))
	_ = conn.WriteMessage(websocket.BinaryMessage, []byte("\x1b[32mSimulated agent ready.\x1b[0m\r\n\r\n"))

	// A bash shell tab also prints an OSC 8 hyperlink, so the terminal's "Open
	// external link?" confirmation can be looked at without a live agent. It is
	// deliberately a link whose LABEL disagrees with where it points, which is
	// the hazard that dialog exists for. Only the shell tabs print it: an agent's
	// own terminal is captured by the screenshot generator, and a shell tab has
	// to be opened by hand, so no baseline transcript changes.
	if r.URL.Query().Get("shell") == "true" {
		_ = conn.WriteMessage(websocket.BinaryMessage, []byte(
			"See \x1b]8;;https://docs.anthropic.com.cdn-assets-eu.net/agent-sdk\x1b\\docs.anthropic.com/agent-sdk\x1b]8;;\x1b\\ for the tool reference.\r\n\r\n"))
	}

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

// simEventPollInterval is how often the events stream re-checks the one piece of
// simulation state that DOES change - the approval picker's parked card - so the
// client refetches the agent list and raises (or drops) the approval promptly.
const simEventPollInterval = 300 * time.Millisecond

// HandleEventsWS mirrors the real server's events stream. Simulation data is
// static apart from the approval picker, so it sends the one-time "refetch
// everything" nudge on connect and then only re-nudges when a card is parked or
// answered, holding the connection open until the peer closes.
func (s *SimulationServer) HandleEventsWS(w http.ResponseWriter, r *http.Request) {
	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	for _, t := range []api.ResourceChangedEventType{api.AgentsChanged, api.ProjectsChanged, api.ServicesChanged} {
		if err := conn.WriteJSON(api.ResourceChangedEvent{Type: t}); err != nil {
			return
		}
	}
	// Client frames are ignored, but the read has to run for close detection.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()
	_, gen := s.simApproval()
	// agent-ask's record flips running <-> needs_input around its answered turn,
	// and the chat's live working indicator reads that record - so the list has
	// to be refetched when it moves, exactly like the approval picker.
	asking := s.askRunning.Load()
	ticker := time.NewTicker(simEventPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			_, current := s.simApproval()
			live := s.askRunning.Load()
			if current == gen && live == asking {
				continue
			}
			gen, asking = current, live
			if err := conn.WriteJSON(api.ResourceChangedEvent{Type: api.AgentsChanged}); err != nil {
				return
			}
		}
	}
}

// simArtifactStreamInterval is the gap between the mock "components" tiles the
// artifacts WS trickles in, so opening the agent page shows them pop in one at a
// time (the ::hydra:artifact:: streaming) rather than all at once. Small enough
// that the whole set has arrived within a second or two - the screenshot
// generator waits for the last tile (see expandArtifact in take-screenshots.ts)
// so it stays deterministic despite the timing.
const simArtifactStreamInterval = 600 * time.Millisecond

// HandleArtifactsWS streams the mock artifact sets over a WebSocket, mirroring
// the real server's endpoint. It sends one snapshot (the simulated states,
// including the in-flight set's live log), then trickles the in-flight
// "components" set's tiles in one at a time - a live demo of the per-file
// ::hydra:artifact:: streaming - and finally keeps the connection open, ignoring
// client messages, until the peer closes it.
func (s *SimulationServer) HandleArtifactsWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("agent_id")
	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	snapshot := api.ArtifactsSnapshotFrame{Type: api.ArtifactsSnapshotFrameTypeSnapshot, Scripts: simArtifactSets(id)}
	data, _ := json.Marshal(snapshot)
	_ = conn.WriteMessage(websocket.TextMessage, data)

	// Read (and discard) client frames in the background, closing done on any error
	// so the trickle below stops the moment the peer disconnects.
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}()

	// Trickle each finished tile into the still-generating "components" set, one per
	// interval, exactly as the real server pushes a "file" message per compared
	// output. Each tile lands as a "file" frame the panel upserts into the card.
	for _, f := range simStreamedArtifactFiles(id) {
		select {
		case <-done:
			return
		case <-time.After(simArtifactStreamInterval):
		}
		fdata, _ := json.Marshal(api.ArtifactsFileFrame{Type: api.File, Script: "components", File: f})
		if err := conn.WriteMessage(websocket.TextMessage, fdata); err != nil {
			return
		}
	}

	// Then keep streaming build-log lines for the still-generating "components"
	// set, a couple per tick, mirroring a chatty capture script. This exercises
	// the panel's live-log path (and its re-render behaviour under a fast log).
	for i := 0; ; i++ {
		select {
		case <-done:
			return
		case <-time.After(150 * time.Millisecond):
		}
		side := api.ArtifactSideLeft
		if i%2 == 1 {
			side = api.ArtifactSideRight
		}
		line := api.ArtifactLogLine{Stream: api.Stdout, Text: fmt.Sprintf("[%s] capturing frame %d ... ok", side, i)}
		ldata, _ := json.Marshal(api.ArtifactsLogFrame{Type: api.ArtifactsLogFrameTypeLog, Script: "components", Side: side, Line: line})
		if err := conn.WriteMessage(websocket.TextMessage, ldata); err != nil {
			return
		}
	}
}

// simStreamedArtifactFiles is the ordered list of tiles the simulated in-flight
// "components" generation finishes and streams over the WS as "file" messages
// (see HandleArtifactsWS), one per ::hydra:artifact:: marker. A mix of freshly
// added components (right-only) and modified ones (a "Draft" grey badge going
// green "Live", so the pixel diff has something to reveal), so the streaming grid
// documents both change kinds arriving mid-run. Ordered so the trickle reads like
// a capture loop working through a page list.
func simStreamedArtifactFiles(id string) []api.ArtifactFile {
	if id != "agent-1" {
		return nil
	}
	return []api.ArtifactFile{
		{
			Name:        "button.png",
			ChangeType:  api.ArtifactFileChangeTypeModified,
			LeftUrl:     ptr(simSVGUI("Button", false, "#64748b", "Draft", 240, 120)),
			RightUrl:    ptr(simSVGUI("Button", false, "#16a34a", "Live", 240, 120)),
			ChangeRatio: ptr(0.04),
			Width:       ptr(960), Height: ptr(480),
		},
		{
			Name:       "card.png",
			ChangeType: api.ArtifactFileChangeTypeAdded,
			RightUrl:   ptr(simSVG("Card (after)", "#15803d", 320, 200)),
			Width:      ptr(1280), Height: ptr(800),
		},
		{
			Name:        "modal.png",
			ChangeType:  api.ArtifactFileChangeTypeModified,
			LeftUrl:     ptr(simSVGUI("Modal", false, "#64748b", "Draft", 300, 220)),
			RightUrl:    ptr(simSVGUI("Modal", false, "#16a34a", "Live", 300, 220)),
			ChangeRatio: ptr(0.07),
			Width:       ptr(1200), Height: ptr(880),
		},
		{
			Name:       "toast.png",
			ChangeType: api.ArtifactFileChangeTypeAdded,
			RightUrl:   ptr(simSVG("Toast (after)", "#15803d", 280, 100)),
			Width:      ptr(1120), Height: ptr(400),
		},
	}
}

// HandleTestsWS streams the mock test verdicts over a WebSocket, mirroring the
// real server's tests WS: it sends one snapshot of the simulated runners (which
// includes any in-flight runner's live log/progress) then idles until the client
// closes, so --simulation and the tests-panel screenshot exercise the WS path.
func (s *SimulationServer) HandleTestsWS(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("agent_id")
	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	msg := api.TestsSnapshotFrame{Type: api.TestsSnapshotFrameTypeSnapshot, Runners: simTestRunners(id)}
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
// extent (fileLastOld/fileLastNew - the largest line numbers across the file's
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

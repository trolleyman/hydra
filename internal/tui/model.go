package tui

import (
	"bufio"
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	dockercontainer "github.com/docker/docker/api/types/container"
	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// focusPanel identifies which panel currently has keyboard focus.
type focusPanel int

const (
	panelSidebar focusPanel = iota
	panelAgent
)

// Model is the Bubble Tea model for the Hydra TUI.
type Model struct {
	client      *dockerclient.Client
	projectRoot string
	heads       []heads.Head
	width       int
	height      int
	statusMsg   string
	err         error

	// Layout
	focused    focusPanel
	sidebarIdx int // currently selected head in the sidebar

	// Log streaming
	logViewport viewport.Model
	logLines    []string // accumulated (ANSI-stripped) log lines
	logForID    string   // container ID of the active log stream
	logCancel   context.CancelFunc
	logChan     <-chan string
	logDone     bool // true when the stream has ended (container stopped)

	// Spawn form
	spawning  bool
	spawnForm spawnForm
}

// spawnForm holds state for the new-agent dialog.
// Fields:
//
//	0 = ID input
//	1 = agent type selector (<-/->)
//	2 = dockerfile path input (optional)
//	3 = prompt input
const spawnFieldCount = 4

type spawnForm struct {
	focusIdx        int
	idInput         textinput.Model
	typeIdx         int // index into agentTypes
	dockerfileInput textinput.Model
	promptInput     textinput.Model
}

var agentTypes = []docker.AgentType{docker.AgentTypeClaude, docker.AgentTypeGemini}

func newSpawnForm() spawnForm {
	id := textinput.New()
	id.Placeholder = "random"
	id.CharLimit = 64
	id.Focus()

	dockerfile := textinput.New()
	dockerfile.Placeholder = "optional path to Dockerfile"
	dockerfile.CharLimit = 256

	prompt := textinput.New()
	prompt.Placeholder = "describe the task..."
	prompt.CharLimit = 1024

	return spawnForm{
		focusIdx:        0,
		idInput:         id,
		typeIdx:         0,
		dockerfileInput: dockerfile,
		promptInput:     prompt,
	}
}

func (f *spawnForm) setWidth(termWidth int) {
	const (
		formMaxWidth = 80
		formOverhead = 6
	)
	w := max(min(termWidth-formOverhead, formMaxWidth-formOverhead), 20)
	f.idInput.Width = w
	f.dockerfileInput.Width = w
	f.promptInput.Width = w
}

// Message types
type (
	refreshMsg    []heads.Head
	killDoneMsg   string
	spawnDoneMsg  string
	resumeDoneMsg string
	logLineMsg    struct{ id, line string }
	logDoneMsg    struct{ id string }
	errMsg        struct{ err error }
)

func (e errMsg) Error() string { return e.err.Error() }

// Maximum log lines retained in the viewport.
const maxLogLines = 2000

// Dimensions
const (
	sidebarMinW = 18
	sidebarMaxW = 26
	infoH       = 7 // lines reserved for the head info panel
)

// Styles
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("62"))

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("241"))

	errStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("9"))

	statusStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("10"))

	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("241"))

	infoKeyStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("241"))

	formStyle = lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("62")).
			Padding(1, 2)

	focusedLabel   = lipgloss.NewStyle().Foreground(lipgloss.Color("62")).Bold(true)
	unfocusedLabel = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))

	selectedFocused = lipgloss.NewStyle().
			Foreground(lipgloss.Color("229")).
			Background(lipgloss.Color("57"))

	selectedBlurred = lipgloss.NewStyle().
			Foreground(lipgloss.Color("62")).
			Bold(true)
)

// New creates a new TUI model.
func New(cli *dockerclient.Client, projectRoot string) Model {
	vp := viewport.New(0, 0)
	return Model{
		client:      cli,
		projectRoot: projectRoot,
		logViewport: vp,
		focused:     panelSidebar,
	}
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(m.doRefresh(), tickCmd())
}

func tickCmd() tea.Cmd {
	return tea.Tick(2*time.Second, func(t time.Time) tea.Msg { return t })
}

func (m Model) doRefresh() tea.Cmd {
	return func() tea.Msg {
		hs, err := heads.ListHeads(context.Background(), m.client, m.projectRoot)
		if err != nil {
			return errMsg{err}
		}
		return refreshMsg(hs)
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if m.spawning {
		return m.updateSpawnForm(msg)
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.updateViewportSize()
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)

	case time.Time:
		return m, tea.Batch(m.doRefresh(), tickCmd())

	case refreshMsg:
		if msg != nil {
			m.heads = []heads.Head(msg)
			if m.sidebarIdx >= len(m.heads) {
				m.sidebarIdx = max(0, len(m.heads)-1)
			}
		}
		m.err = nil
		m.statusMsg = fmt.Sprintf("Last updated %s", time.Now().Format("15:04:05"))
		var syncCmd tea.Cmd
		m, syncCmd = syncLogStream(m)
		return m, syncCmd

	case logLineMsg:
		if msg.id == m.logForID {
			m.logLines = append(m.logLines, msg.line)
			if len(m.logLines) > maxLogLines {
				m.logLines = m.logLines[len(m.logLines)-maxLogLines:]
			}
			m.logViewport.SetContent(strings.Join(m.logLines, "\n"))
			m.logViewport.GotoBottom()
			return m, waitForLog(msg.id, m.logChan)
		}
		return m, nil

	case logDoneMsg:
		if msg.id == m.logForID {
			m.logDone = true
			// Append a stopped hint if the head is not running
			if head := m.selectedHead(); head != nil && !isContainerRunning(head.ContainerStatus) {
				m.logLines = append(m.logLines, "")
				m.logLines = append(m.logLines, dimStyle.Render("─── container stopped — press [r] to resume ───"))
				m.logViewport.SetContent(strings.Join(m.logLines, "\n"))
				m.logViewport.GotoBottom()
			}
		}
		return m, nil

	case killDoneMsg:
		m.statusMsg = fmt.Sprintf("Killed agent %s", string(msg))
		return m, m.doRefresh()

	case spawnDoneMsg:
		m.statusMsg = fmt.Sprintf("Spawned agent %s", string(msg))
		return m, m.doRefresh()

	case resumeDoneMsg:
		m.statusMsg = fmt.Sprintf("Resumed agent %s", string(msg))
		return m, m.doRefresh()

	case errMsg:
		m.err = msg.err
		return m, nil
	}

	return m, nil
}

func (m Model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "ctrl+c", "q", "esc":
		return m, tea.Quit

	case "tab":
		if m.focused == panelSidebar {
			m.focused = panelAgent
		} else {
			m.focused = panelSidebar
		}
		return m, nil

	case "s":
		m.spawning = true
		m.spawnForm = newSpawnForm()
		m.spawnForm.setWidth(m.width)
		return m, textinput.Blink

	case "x":
		if head := m.selectedHead(); head != nil {
			h := *head
			return m, func() tea.Msg {
				if err := heads.KillHead(context.Background(), m.client, h); err != nil {
					return errMsg{err}
				}
				return killDoneMsg(h.ID)
			}
		}

	case "r":
		if m.focused == panelAgent {
			return m.resumeSelected()
		}
		m.statusMsg = "Refreshing..."
		return m, m.doRefresh()

	case "up", "k":
		if m.focused == panelSidebar {
			if m.sidebarIdx > 0 {
				m.sidebarIdx--
			}
			var cmd tea.Cmd
			m, cmd = syncLogStream(m)
			return m, cmd
		}
		// fall through to viewport

	case "down", "j":
		if m.focused == panelSidebar {
			if m.sidebarIdx < len(m.heads)-1 {
				m.sidebarIdx++
			}
			var cmd tea.Cmd
			m, cmd = syncLogStream(m)
			return m, cmd
		}
		// fall through to viewport
	}

	// Forward remaining keys to the viewport when the agent panel is focused.
	if m.focused == panelAgent {
		var cmd tea.Cmd
		m.logViewport, cmd = m.logViewport.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m Model) resumeSelected() (tea.Model, tea.Cmd) {
	head := m.selectedHead()
	if head == nil || head.ContainerID == "" || isContainerRunning(head.ContainerStatus) {
		return m, nil
	}

	m.statusMsg = fmt.Sprintf("Resuming %s...", head.ID)
	oldContainerID := head.ContainerID
	headCopy := *head
	client := m.client

	return m, func() tea.Msg {
		ctx := context.Background()

		// Remove the old stopped container so we can reuse its name.
		if err := client.ContainerRemove(ctx, oldContainerID, dockercontainer.RemoveOptions{Force: true}); err != nil {
			log.Printf("warn: remove container for resume: %v", err)
		}

		// Look up current user identity for container user creation.
		uid, gid, username, groupName := currentUserInfo()

		_, err := docker.SpawnAgent(ctx, client, docker.SpawnOptions{
			Id:             headCopy.ID,
			AgentType:      headCopy.AgentType,
			PrePrompt:      headCopy.PrePrompt,
			Prompt:         headCopy.Prompt,
			ProjectPath:    headCopy.ProjectPath,
			WorktreePath:   headCopy.WorktreePath,
			BranchName:     headCopy.BranchName,
			BaseBranch:     headCopy.BaseBranch,
			GitAuthorName:  os.Getenv("GIT_AUTHOR_NAME"),
			GitAuthorEmail: os.Getenv("GIT_AUTHOR_EMAIL"),
			UID:            uid,
			GID:            gid,
			Username:       username,
			GroupName:      groupName,
			Resume:         true,
		})
		if err != nil {
			return errMsg{err}
		}
		return resumeDoneMsg(headCopy.ID)
	}
}

// updateSpawnForm handles keystrokes while the spawn dialog is open.
func (m Model) updateSpawnForm(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.spawnForm.setWidth(msg.Width)
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			m.spawning = false
			return m, nil

		case "tab", "shift+tab":
			if msg.String() == "tab" {
				m.spawnForm.focusIdx = (m.spawnForm.focusIdx + 1) % spawnFieldCount
			} else {
				m.spawnForm.focusIdx = (m.spawnForm.focusIdx + spawnFieldCount - 1) % spawnFieldCount
			}
			m.spawnForm.idInput.Blur()
			m.spawnForm.dockerfileInput.Blur()
			m.spawnForm.promptInput.Blur()
			switch m.spawnForm.focusIdx {
			case 0:
				m.spawnForm.idInput.Focus()
			case 2:
				m.spawnForm.dockerfileInput.Focus()
			case 3:
				m.spawnForm.promptInput.Focus()
			}
			return m, textinput.Blink

		case "left", "right":
			if m.spawnForm.focusIdx == 1 {
				if msg.String() == "left" {
					m.spawnForm.typeIdx = (m.spawnForm.typeIdx + len(agentTypes) - 1) % len(agentTypes)
				} else {
					m.spawnForm.typeIdx = (m.spawnForm.typeIdx + 1) % len(agentTypes)
				}
				return m, nil
			}

		case "enter":
			promptText := strings.TrimSpace(m.spawnForm.promptInput.Value())
			if promptText == "" {
				m.err = fmt.Errorf("prompt is required")
				return m, nil
			}
			id := strings.TrimSpace(m.spawnForm.idInput.Value())
			if id == "" {
				var err error
				id, err = randomTUIID()
				if err != nil {
					m.err = err
					return m, nil
				}
			}
			dockerfilePath := strings.TrimSpace(m.spawnForm.dockerfileInput.Value())
			agentType := agentTypes[m.spawnForm.typeIdx]

			projectRoot := m.projectRoot
			m.spawning = false
			m.statusMsg = fmt.Sprintf("Spawning agent %s...", id)

			return m, func() tea.Msg {
				if err := spawnHead(projectRoot, id, agentType, dockerfilePath, promptText, m.client); err != nil {
					return errMsg{err}
				}
				return spawnDoneMsg(id)
			}
		}
	}

	var cmd tea.Cmd
	switch m.spawnForm.focusIdx {
	case 0:
		m.spawnForm.idInput, cmd = m.spawnForm.idInput.Update(msg)
	case 2:
		m.spawnForm.dockerfileInput, cmd = m.spawnForm.dockerfileInput.Update(msg)
	case 3:
		m.spawnForm.promptInput, cmd = m.spawnForm.promptInput.Update(msg)
	}
	return m, cmd
}

// ── View ─────────────────────────────────────────────────────────────────────

func (m Model) View() string {
	if m.spawning {
		return m.viewSpawnForm()
	}
	if m.width == 0 || m.height == 0 {
		return "Loading..."
	}

	header := titleStyle.Render("Hydra AI Agent Orchestrator")

	sidebarW := m.sidebarWidth()
	rightW := m.width - sidebarW - 1 // 1 for the "│" separator column
	bodyH := m.height - 2            // minus header and footer

	sidebar := m.viewSidebar(sidebarW, bodyH)
	right := m.viewRight(rightW, bodyH)

	// Build the vertical separator (one "│" per body line).
	sep := strings.Repeat("│\n", bodyH-1) + "│"

	body := lipgloss.JoinHorizontal(lipgloss.Top, sidebar, sep, right)
	footer := m.viewFooter()

	return lipgloss.JoinVertical(lipgloss.Left, header, body, footer)
}

func (m Model) viewSidebar(w, h int) string {
	lines := make([]string, 0, h)

	hdrText := " HEADS"
	hdr := titleStyle.Render(hdrText)
	lines = append(lines, padRight(hdr, w))
	lines = append(lines, dimStyle.Render(strings.Repeat("─", w)))

	for i, head := range m.heads {
		if len(lines) >= h {
			break
		}
		prefix := "  "
		label := prefix + head.ID
		maxLabelW := w
		if lipgloss.Width(label) > maxLabelW {
			label = label[:maxLabelW]
		}

		if i == m.sidebarIdx {
			fullLabel := "> " + head.ID
			if lipgloss.Width(fullLabel) > w {
				fullLabel = fullLabel[:w]
			}
			if m.focused == panelSidebar {
				lines = append(lines, selectedFocused.Render(padRight(fullLabel, w)))
			} else {
				lines = append(lines, selectedBlurred.Render(padRight(fullLabel, w)))
			}
		} else {
			lines = append(lines, padRight(label, w))
		}
	}

	// Pad remaining lines to fill height.
	for len(lines) < h {
		lines = append(lines, strings.Repeat(" ", w))
	}
	return strings.Join(lines[:h], "\n")
}

func (m Model) viewRight(w, h int) string {
	info := m.viewInfo(w)
	infoLines := strings.Split(info, "\n")
	for len(infoLines) < infoH {
		infoLines = append(infoLines, strings.Repeat(" ", w))
	}
	infoLines = infoLines[:infoH]

	sep := dimStyle.Render(strings.Repeat("─", w))
	logView := m.logViewport.View()

	parts := append(infoLines, sep)
	return strings.Join(parts, "\n") + "\n" + logView
}

func (m Model) viewInfo(w int) string {
	head := m.selectedHead()
	if head == nil {
		line := dimStyle.Render(" No agent selected")
		var lines []string
		lines = append(lines, padRight(line, w))
		for len(lines) < infoH {
			lines = append(lines, strings.Repeat(" ", w))
		}
		return strings.Join(lines, "\n")
	}

	status := head.ContainerStatus
	if status == "" {
		status = "no container"
	}

	prompt := head.Prompt
	maxPromptW := w - 10
	if maxPromptW < 3 {
		maxPromptW = 3
	}
	if len(prompt) > maxPromptW {
		prompt = prompt[:maxPromptW-3] + "..."
	}

	fields := []struct{ k, v string }{
		{" ID:    ", head.ID},
		{" Agent: ", string(head.AgentType)},
		{" Status:", status},
		{" Branch:", head.BranchName},
		{" Base:  ", head.BaseBranch},
		{" Prompt:", prompt},
	}

	var lines []string
	for _, f := range fields {
		key := infoKeyStyle.Render(f.k)
		line := key + " " + f.v
		lines = append(lines, padRight(line, w))
	}
	for len(lines) < infoH {
		lines = append(lines, strings.Repeat(" ", w))
	}
	return strings.Join(lines[:infoH], "\n")
}

func (m Model) viewFooter() string {
	var helpParts []string
	if m.focused == panelSidebar {
		helpParts = []string{
			"[↑/↓] navigate",
			"[Tab] focus view",
			"[s] spawn",
			"[x] kill",
			"[r] refresh",
			"[q] quit",
		}
	} else {
		resumeHint := "[r] refresh"
		if head := m.selectedHead(); head != nil && head.ContainerID != "" && !isContainerRunning(head.ContainerStatus) {
			resumeHint = "[r] resume"
		}
		helpParts = []string{
			"[↑/↓/PgUp/PgDn] scroll",
			"[Tab] focus sidebar",
			resumeHint,
			"[q] quit",
		}
	}
	help := helpStyle.Render(strings.Join(helpParts, "  "))

	var statusPart string
	if m.err != nil {
		statusPart = errStyle.Render("  Error: " + m.err.Error())
	} else if m.statusMsg != "" {
		statusPart = statusStyle.Render("  " + m.statusMsg)
	}

	return help + statusPart
}

func (m Model) viewSpawnForm() string {
	f := m.spawnForm

	label := func(text string, focused bool) string {
		if focused {
			return focusedLabel.Render(text)
		}
		return unfocusedLabel.Render(text)
	}

	var typeOptions []string
	for i, t := range agentTypes {
		s := string(t)
		if i == f.typeIdx {
			s = focusedLabel.Render("[ " + s + " ]")
		} else {
			s = unfocusedLabel.Render("  " + s + "  ")
		}
		typeOptions = append(typeOptions, s)
	}
	typeRow := strings.Join(typeOptions, " ")

	maxFormW := 80
	if m.width > 0 && m.width < maxFormW {
		maxFormW = m.width
	}

	var errLine string
	if m.err != nil {
		errLine = "\n" + errStyle.Render("Error: "+m.err.Error())
	}

	form := formStyle.MaxWidth(maxFormW).Render(strings.Join([]string{
		titleStyle.Render("Spawn New Agent"),
		"",
		label("ID (leave blank for random):", f.focusIdx == 0),
		f.idInput.View(),
		"",
		label("Agent type [←/→]:", f.focusIdx == 1),
		typeRow,
		"",
		label("Dockerfile (optional, type inferred from ENTRYPOINT):", f.focusIdx == 2),
		f.dockerfileInput.View(),
		"",
		label("Prompt:", f.focusIdx == 3),
		f.promptInput.View(),
		"",
		helpStyle.Render("[Tab] next field  [←/→] change type  [Enter] spawn  [Esc] cancel") + errLine,
	}, "\n"))

	return form
}

// ── Log streaming ─────────────────────────────────────────────────────────────

// waitForLog returns a Cmd that blocks until the next line arrives on ch.
func waitForLog(id string, ch <-chan string) tea.Cmd {
	return func() tea.Msg {
		line, ok := <-ch
		if !ok {
			return logDoneMsg{id: id}
		}
		return logLineMsg{id: id, line: stripANSI(line)}
	}
}

// startLogStream cancels any existing log stream and starts a new one for containerID.
func startLogStream(m Model, containerID string) (Model, tea.Cmd) {
	if m.logCancel != nil {
		m.logCancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.logCancel = cancel
	m.logForID = containerID
	m.logLines = nil
	m.logDone = false
	m.logViewport.SetContent(dimStyle.Render("Loading logs…"))

	ch := streamDockerLogs(ctx, containerID)
	m.logChan = ch
	return m, waitForLog(containerID, ch)
}

// syncLogStream checks whether the log stream matches the currently selected head
// and restarts it if necessary.
func syncLogStream(m Model) (Model, tea.Cmd) {
	head := m.selectedHead()
	var containerID string
	if head != nil {
		containerID = head.ContainerID
	}
	if containerID == "" {
		if m.logCancel != nil {
			m.logCancel()
			m.logCancel = nil
		}
		m.logForID = ""
		m.logLines = nil
		m.logDone = false
		m.logViewport.SetContent(dimStyle.Render("No container"))
		return m, nil
	}
	if containerID == m.logForID {
		return m, nil // already streaming
	}
	return startLogStream(m, containerID)
}

// streamDockerLogs runs `docker logs --follow` in a goroutine and feeds lines into the returned channel.
func streamDockerLogs(ctx context.Context, containerID string) <-chan string {
	ch := make(chan string, 200)
	go func() {
		defer close(ch)

		pr, pw := io.Pipe()
		cmd := exec.CommandContext(ctx, "docker", "logs", "--follow", "--tail", "500", containerID)
		cmd.Stdout = pw
		cmd.Stderr = pw

		if err := cmd.Start(); err != nil {
			log.Printf("docker logs start: %v", err)
			_ = pw.Close()
			return
		}

		// Close the write-end of the pipe when the process exits.
		go func() {
			_ = cmd.Wait()
			_ = pw.Close()
		}()

		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 1<<16), 1<<16)
		for scanner.Scan() {
			select {
			case ch <- scanner.Text():
			case <-ctx.Done():
				_ = pr.Close()
				return
			}
		}
	}()
	return ch
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ansiRE matches ANSI/VT escape sequences for stripping from log output.
var ansiRE = regexp.MustCompile(`\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`)

func stripANSI(s string) string {
	s = strings.ReplaceAll(s, "\r", "")
	return ansiRE.ReplaceAllString(s, "")
}

// padRight pads s with spaces until its visual width equals w.
func padRight(s string, w int) string {
	sw := lipgloss.Width(s)
	if sw >= w {
		return s
	}
	return s + strings.Repeat(" ", w-sw)
}

func (m Model) sidebarWidth() int {
	if m.width == 0 {
		return sidebarMinW
	}
	w := m.width / 5
	if w < sidebarMinW {
		w = sidebarMinW
	}
	if w > sidebarMaxW {
		w = sidebarMaxW
	}
	return w
}

func (m *Model) updateViewportSize() {
	rightW := m.width - m.sidebarWidth() - 1
	bodyH := m.height - 2         // minus header and footer
	logH := max(bodyH-infoH-1, 1) // minus info panel and separator
	m.logViewport.Width = max(rightW, 1)
	m.logViewport.Height = logH
}

func (m Model) selectedHead() *heads.Head {
	if len(m.heads) == 0 || m.sidebarIdx >= len(m.heads) {
		return nil
	}
	return &m.heads[m.sidebarIdx]
}

func isContainerRunning(status string) bool {
	s := strings.ToLower(status)
	return strings.HasPrefix(s, "up") || s == "running"
}

func spawnHead(projectRoot, id string, agentType docker.AgentType, dockerfilePath, prompt string, cli *dockerclient.Client) error {
	baseBranch, err := git.GetCurrentBranch(projectRoot)
	if err != nil {
		return fmt.Errorf("get current branch: %w", err)
	}

	branchName := "hydra/" + id
	worktreePath := filepath.Join(projectRoot, ".hydra", "worktrees", id)

	if err := git.CreateWorktree(projectRoot, worktreePath, branchName, baseBranch); err != nil {
		return fmt.Errorf("create worktree: %w", err)
	}

	gitAuthorName := os.Getenv("GIT_AUTHOR_NAME")
	gitAuthorEmail := os.Getenv("GIT_AUTHOR_EMAIL")
	uid, gid, username, groupName := currentUserInfo()

	_, err = docker.SpawnAgent(context.Background(), cli, docker.SpawnOptions{
		Id:             id,
		AgentType:      agentType,
		DockerfilePath: dockerfilePath,
		Prompt:         prompt,
		ProjectPath:    projectRoot,
		WorktreePath:   worktreePath,
		BranchName:     branchName,
		BaseBranch:     baseBranch,
		GitAuthorName:  gitAuthorName,
		GitAuthorEmail: gitAuthorEmail,
		UID:            uid,
		GID:            gid,
		Username:       username,
		GroupName:      groupName,
	})
	if err != nil {
		_ = git.RemoveWorktree(projectRoot, worktreePath)
		_ = git.DeleteBranch(projectRoot, branchName)
		return fmt.Errorf("spawn agent: %w", err)
	}
	return nil
}

// currentUserInfo returns the current OS user's UID, GID, username, and primary group name.
func currentUserInfo() (uid, gid int, username, groupName string) {
	u, err := user.Current()
	if err != nil {
		return os.Getuid(), os.Getgid(), "user", "user"
	}
	uid, _ = strconv.Atoi(u.Uid)
	gid, _ = strconv.Atoi(u.Gid)
	username = u.Username
	groupName = u.Username
	if grp, err := user.LookupGroupId(u.Gid); err == nil {
		groupName = grp.Name
	}
	return
}

func randomTUIID() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}

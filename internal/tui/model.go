package tui

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/table"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/heads"
)

// Model is the Bubble Tea model for the Hydra agent list.
type Model struct {
	table       table.Model
	client      *dockerclient.Client
	projectRoot string
	heads       []heads.Head
	width       int
	height      int
	statusMsg   string
	err         error

	// spawn form state
	spawning    bool
	spawnForm   spawnForm
}

type spawnForm struct {
	focusIdx  int // 0=id, 1=agentType, 2=prompt
	idInput   textinput.Model
	typeIdx   int // index into agentTypes
	prompt    textinput.Model
}

var agentTypes = []docker.AgentType{docker.AgentTypeClaude, docker.AgentTypeGemini}

func newSpawnForm() spawnForm {
	id := textinput.New()
	id.Placeholder = "random"
	id.CharLimit = 64
	id.Focus()

	prompt := textinput.New()
	prompt.Placeholder = "describe the task..."
	prompt.CharLimit = 256

	return spawnForm{
		focusIdx: 0,
		idInput:  id,
		typeIdx:  0,
		prompt:   prompt,
	}
}

type (
	refreshMsg  []heads.Head
	killDoneMsg string
	spawnDoneMsg string
	errMsg      struct{ err error }
)

func (e errMsg) Error() string { return e.err.Error() }

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

	borderStyle = lipgloss.NewStyle().
			BorderStyle(lipgloss.NormalBorder()).
			BorderForeground(lipgloss.Color("240"))

	formStyle = lipgloss.NewStyle().
			BorderStyle(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("62")).
			Padding(1, 2)

	focusedLabel   = lipgloss.NewStyle().Foreground(lipgloss.Color("62")).Bold(true)
	unfocusedLabel = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
)

// New creates a new TUI model connected to the given Docker client and project root.
func New(cli *dockerclient.Client, projectRoot string) Model {
	cols := []table.Column{
		{Title: "ID", Width: 12},
		{Title: "AGENT", Width: 8},
		{Title: "BRANCH", Width: 28},
		{Title: "WKTREE", Width: 6},
		{Title: "STATUS", Width: 12},
		{Title: "PROMPT", Width: 36},
	}

	t := table.New(
		table.WithColumns(cols),
		table.WithFocused(true),
		table.WithHeight(10),
	)

	s := table.DefaultStyles()
	s.Header = s.Header.
		BorderStyle(lipgloss.NormalBorder()).
		BorderForeground(lipgloss.Color("240")).
		BorderBottom(true).
		Bold(true)
	s.Selected = s.Selected.
		Foreground(lipgloss.Color("229")).
		Background(lipgloss.Color("57")).
		Bold(false)
	t.SetStyles(s)

	return Model{
		table:       t,
		client:      cli,
		projectRoot: projectRoot,
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
	var cmd tea.Cmd

	// Spawn form intercepts all input when active
	if m.spawning {
		return m.updateSpawnForm(msg)
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		tableHeight := msg.Height - 6
		if tableHeight < 3 {
			tableHeight = 3
		}
		m.table.SetHeight(tableHeight)

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit

		case "n":
			m.spawning = true
			m.spawnForm = newSpawnForm()
			return m, textinput.Blink

		case "enter":
			if row := m.table.SelectedRow(); row != nil {
				if h := m.headByID(row[0]); h != nil && h.ContainerID != "" {
					return m, tea.ExecProcess(
						exec.Command("docker", "attach", h.ContainerID),
						func(err error) tea.Msg {
							if err != nil {
								log.Printf("attach exited: %v", err)
							}
							return refreshMsg(nil)
						},
					)
				}
			}

		case "l":
			if row := m.table.SelectedRow(); row != nil {
				if h := m.headByID(row[0]); h != nil && h.ContainerID != "" {
					return m, tea.ExecProcess(
						exec.Command("docker", "logs", "-f", h.ContainerID),
						func(err error) tea.Msg { return refreshMsg(nil) },
					)
				}
			}

		case "x":
			if row := m.table.SelectedRow(); row != nil {
				if h := m.headByID(row[0]); h != nil {
					head := *h
					return m, func() tea.Msg {
						if err := heads.KillHead(context.Background(), m.client, head); err != nil {
							return errMsg{err}
						}
						return killDoneMsg(head.ID)
					}
				}
			}

		case "r":
			m.statusMsg = "Refreshing..."
			return m, m.doRefresh()
		}

	case time.Time:
		return m, tea.Batch(m.doRefresh(), tickCmd())

	case refreshMsg:
		if msg != nil {
			m.heads = []heads.Head(msg)
		}
		m.err = nil
		m.updateTable()
		m.statusMsg = fmt.Sprintf("Last updated %s", time.Now().Format("15:04:05"))
		return m, nil

	case killDoneMsg:
		m.statusMsg = fmt.Sprintf("Killed agent %s", string(msg))
		return m, m.doRefresh()

	case spawnDoneMsg:
		m.statusMsg = fmt.Sprintf("Spawned agent %s", string(msg))
		return m, m.doRefresh()

	case errMsg:
		m.err = msg.err
		return m, nil
	}

	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m Model) updateSpawnForm(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			m.spawning = false
			return m, nil

		case "tab", "shift+tab":
			if msg.String() == "tab" {
				m.spawnForm.focusIdx = (m.spawnForm.focusIdx + 1) % 3
			} else {
				m.spawnForm.focusIdx = (m.spawnForm.focusIdx + 2) % 3
			}
			if m.spawnForm.focusIdx == 0 {
				m.spawnForm.idInput.Focus()
				m.spawnForm.prompt.Blur()
			} else if m.spawnForm.focusIdx == 1 {
				m.spawnForm.idInput.Blur()
				m.spawnForm.prompt.Blur()
			} else {
				m.spawnForm.idInput.Blur()
				m.spawnForm.prompt.Focus()
			}
			return m, textinput.Blink

		case "left", "right":
			if m.spawnForm.focusIdx == 1 {
				if msg.String() == "left" {
					m.spawnForm.typeIdx = (m.spawnForm.typeIdx + len(agentTypes) - 1) % len(agentTypes)
				} else {
					m.spawnForm.typeIdx = (m.spawnForm.typeIdx + 1) % len(agentTypes)
				}
			}
			return m, nil

		case "enter":
			promptText := strings.TrimSpace(m.spawnForm.prompt.Value())
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
			agentType := agentTypes[m.spawnForm.typeIdx]
			projectRoot := m.projectRoot
			m.spawning = false
			m.statusMsg = fmt.Sprintf("Spawning agent %s...", id)

			return m, func() tea.Msg {
				if err := spawnHead(projectRoot, id, agentType, promptText, m.client); err != nil {
					return errMsg{err}
				}
				return spawnDoneMsg(id)
			}
		}
	}

	// Forward input to focused field
	var cmd tea.Cmd
	if m.spawnForm.focusIdx == 0 {
		m.spawnForm.idInput, cmd = m.spawnForm.idInput.Update(msg)
	} else if m.spawnForm.focusIdx == 2 {
		m.spawnForm.prompt, cmd = m.spawnForm.prompt.Update(msg)
	}
	return m, cmd
}

func (m Model) View() string {
	if m.spawning {
		return m.viewSpawnForm()
	}

	title := titleStyle.Render("Hydra AI Agent Orchestrator")

	var body string
	if len(m.heads) == 0 {
		empty := lipgloss.NewStyle().
			Foreground(lipgloss.Color("241")).
			Padding(1, 2).
			Render("No agents running. Press [n] to spawn one.")
		body = borderStyle.Render(empty)
	} else {
		body = borderStyle.Render(m.table.View())
	}

	var status string
	if m.err != nil {
		status = errStyle.Render("Error: " + m.err.Error())
	} else if m.statusMsg != "" {
		status = statusStyle.Render(m.statusMsg)
	}

	help := helpStyle.Render("[↑/↓] navigate  [enter] attach  [l] logs  [x] kill  [n] spawn  [r] refresh  [q] quit")

	parts := []string{title, body}
	if status != "" {
		parts = append(parts, status)
	}
	parts = append(parts, help)
	return strings.Join(parts, "\n")
}

func (m Model) viewSpawnForm() string {
	f := m.spawnForm

	labelID := unfocusedLabel.Render("ID (leave blank for random):")
	if f.focusIdx == 0 {
		labelID = focusedLabel.Render("ID (leave blank for random):")
	}

	labelType := unfocusedLabel.Render("Agent type [←/->]:")
	if f.focusIdx == 1 {
		labelType = focusedLabel.Render("Agent type [←/->]:")
	}

	labelPrompt := unfocusedLabel.Render("Prompt:")
	if f.focusIdx == 2 {
		labelPrompt = focusedLabel.Render("Prompt:")
	}

	// Render agent type selector
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

	form := formStyle.Render(strings.Join([]string{
		titleStyle.Render("Spawn New Agent"),
		"",
		labelID,
		f.idInput.View(),
		"",
		labelType,
		typeRow,
		"",
		labelPrompt,
		f.prompt.View(),
		"",
		helpStyle.Render("[Tab] next field  [←/->] change type  [Enter] spawn  [Esc] cancel"),
	}, "\n"))

	return form
}

func (m *Model) updateTable() {
	rows := make([]table.Row, len(m.heads))
	for i, h := range m.heads {
		worktree := "yes"
		if !h.HasWorktree {
			worktree = "no"
		}

		status := h.ContainerStatus
		if status == "" {
			status = "-"
		}

		prompt := h.Prompt
		if len(prompt) > 33 {
			prompt = prompt[:33] + "…"
		}

		rows[i] = table.Row{
			h.ID,
			string(h.AgentType),
			h.BranchName,
			worktree,
			status,
			prompt,
		}
	}
	m.table.SetRows(rows)
}

func (m *Model) headByID(id string) *heads.Head {
	for i := range m.heads {
		if m.heads[i].ID == id || strings.HasPrefix(m.heads[i].ContainerID, id) {
			return &m.heads[i]
		}
	}
	return nil
}

// spawnHead creates a worktree, builds the image, and starts the container.
func spawnHead(projectRoot, id string, agentType docker.AgentType, prompt string, cli *dockerclient.Client) error {
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

	_, err = docker.SpawnAgent(context.Background(), cli, docker.SpawnOptions{
		Id:             id,
		AgentType:      agentType,
		Prompt:         prompt,
		ProjectPath:    projectRoot,
		WorktreePath:   worktreePath,
		BranchName:     branchName,
		BaseBranch:     baseBranch,
		GitAuthorName:  gitAuthorName,
		GitAuthorEmail: gitAuthorEmail,
	})
	if err != nil {
		_ = git.RemoveWorktree(projectRoot, worktreePath)
		_ = git.DeleteBranch(projectRoot, branchName)
		return fmt.Errorf("spawn agent: %w", err)
	}
	return nil
}

func randomTUIID() (string, error) {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}

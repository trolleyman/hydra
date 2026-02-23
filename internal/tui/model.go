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
	spawning  bool
	spawnForm spawnForm
}

// spawnForm holds state for the new-agent dialog.
// Fields:
//
//	0 = ID input
//	1 = agent type selector (←/→)
//	2 = dockerfile path input (optional)
//	3 = prompt input
const spawnFieldCount = 4

type spawnForm struct {
	focusIdx       int
	idInput        textinput.Model
	typeIdx        int // index into agentTypes
	dockerfileInput textinput.Model
	promptInput    textinput.Model
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
	prompt.CharLimit = 256

	return spawnForm{
		focusIdx:       0,
		idInput:        id,
		typeIdx:        0,
		dockerfileInput: dockerfile,
		promptInput:    prompt,
	}
}

type (
	refreshMsg   []heads.Head
	killDoneMsg  string
	spawnDoneMsg string
	errMsg       struct{ err error }
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
			}
			return m, nil

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

			// If a dockerfile was given, try to infer the agent type from it.
			if dockerfilePath != "" {
				if content, err := os.ReadFile(dockerfilePath); err == nil {
					if inferred, ok := docker.InferAgentType(string(content)); ok {
						agentType = inferred
					}
				}
			}

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

	// Forward input to the focused text field.
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

	label := func(text string, focused bool) string {
		if focused {
			return focusedLabel.Render(text)
		}
		return unfocusedLabel.Render(text)
	}

	// Agent type selector row
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
		helpStyle.Render("[Tab] next field  [←/→] change type  [Enter] spawn  [Esc] cancel"),
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

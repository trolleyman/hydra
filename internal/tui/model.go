package tui

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/table"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	dockerclient "github.com/docker/docker/client"
	"github.com/trolleyman/hydra/internal/docker"
	"github.com/trolleyman/hydra/internal/git"
)

// Model is the Bubble Tea model for the Hydra agent list.
type Model struct {
	table     table.Model
	client    *dockerclient.Client
	agents    []docker.Agent
	width     int
	height    int
	statusMsg string
	err       error
}

type (
	refreshMsg  []docker.Agent
	killDoneMsg string
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
)

// New creates a new TUI model connected to the given Docker client.
func New(cli *dockerclient.Client) Model {
	cols := []table.Column{
		{Title: "ID", Width: 12},
		{Title: "Image", Width: 18},
		{Title: "Branch", Width: 32},
		{Title: "Status", Width: 12},
		{Title: "Prompt", Width: 40},
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
		table:  t,
		client: cli,
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
		agents, err := docker.ListAgents(context.Background(), m.client)
		if err != nil {
			return errMsg{err}
		}
		return refreshMsg(agents)
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	var cmd tea.Cmd

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		// Resize table height to fill available space (leave room for title + help)
		tableHeight := msg.Height - 6
		if tableHeight < 3 {
			tableHeight = 3
		}
		m.table.SetHeight(tableHeight)

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit

		case "enter":
			if row := m.table.SelectedRow(); row != nil {
				if agent := m.agentByShortID(row[0]); agent != nil {
					return m, tea.ExecProcess(
						exec.Command("docker", "attach", agent.ContainerID),
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
				if agent := m.agentByShortID(row[0]); agent != nil {
					return m, tea.ExecProcess(
						exec.Command("docker", "logs", "-f", agent.ContainerID),
						func(err error) tea.Msg { return refreshMsg(nil) },
					)
				}
			}

		case "x":
			if row := m.table.SelectedRow(); row != nil {
				if agent := m.agentByShortID(row[0]); agent != nil {
					id := agent.ContainerID
					worktreePath := agent.Meta.HostWorktreePath
					return m, func() tea.Msg {
						ctx := context.Background()
						if err := docker.KillAgent(ctx, m.client, id); err != nil {
							return errMsg{err}
						}
						projectRoot := git.InferProjectRoot(worktreePath)
						if err := git.RemoveWorktree(projectRoot, worktreePath); err != nil {
							log.Printf("warn: remove worktree %s: %v", worktreePath, err)
						}
						return killDoneMsg(id[:12])
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
			m.agents = []docker.Agent(msg)
		}
		m.err = nil
		m.updateTable()
		m.statusMsg = fmt.Sprintf("Last updated %s", time.Now().Format("15:04:05"))
		return m, nil

	case killDoneMsg:
		m.statusMsg = fmt.Sprintf("Killed agent %s", string(msg))
		return m, m.doRefresh()

	case errMsg:
		m.err = msg.err
		return m, nil
	}

	m.table, cmd = m.table.Update(msg)
	return m, cmd
}

func (m Model) View() string {
	title := titleStyle.Render("Hydra AI Agent Orchestrator")

	var body string
	if len(m.agents) == 0 {
		empty := lipgloss.NewStyle().
			Foreground(lipgloss.Color("241")).
			Padding(1, 2).
			Render("No agents running. Use `hydra spawn <prompt>` to start one.")
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

	help := helpStyle.Render("[↑/↓] navigate  [enter] attach  [l] logs  [x] kill  [r] refresh  [q] quit")

	parts := []string{title, body}
	if status != "" {
		parts = append(parts, status)
	}
	parts = append(parts, help)
	return strings.Join(parts, "\n")
}

func (m *Model) updateTable() {
	rows := make([]table.Row, len(m.agents))
	for i, a := range m.agents {
		shortID := a.ContainerID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		prompt := a.Meta.Prompt
		if len(prompt) > 37 {
			prompt = prompt[:37] + "…"
		}
		rows[i] = table.Row{
			shortID,
			a.ImageName,
			a.Meta.BranchName,
			a.Status,
			prompt,
		}
	}
	m.table.SetRows(rows)
}

func (m *Model) agentByShortID(shortID string) *docker.Agent {
	for i := range m.agents {
		if strings.HasPrefix(m.agents[i].ContainerID, shortID) {
			return &m.agents[i]
		}
	}
	return nil
}

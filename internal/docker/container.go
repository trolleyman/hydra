package docker

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"braces.dev/errtrace"
	"github.com/charmbracelet/x/term"
	"github.com/docker/docker/api/types/build"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/network"
	dockerclient "github.com/docker/docker/client"
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/common"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/paths"
)

// Agent represents a running or stopped Hydra-managed container.
type Agent struct {
	ContainerID   string
	ContainerName string
	Created       int64  // Unix timestamp
	State         string // machine-readable: "running", "exited", "stopped", etc.
	Status        string // human-readable: "Up 2 hours", "Exited (0) 2 minutes ago", etc.
	ImageName     string
	Meta          *AgentMetadata
}

// NewClient creates a Docker client from the environment (DOCKER_HOST, etc.).
func NewClient() (*dockerclient.Client, error) {
	cli, err := dockerclient.NewClientWithOpts(
		dockerclient.FromEnv,
		dockerclient.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("create docker client: %w", err))
	}
	return cli, nil
}

// ListAgents returns all containers carrying the Hydra label.
func ListAgents(ctx context.Context, cli *dockerclient.Client) ([]Agent, error) {
	args := filters.NewArgs(filters.Arg("label", LabelKey))
	containers, err := cli.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: args,
	})
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("list containers: %w", err))
	}

	var agents []Agent
	for _, c := range containers {
		labelVal, ok := c.Labels[LabelKey]
		if !ok {
			continue
		}
		meta, err := DecodeLabel(labelVal)
		if err != nil {
			log.Printf("warn: decode label for %s: %v", c.ID[:12], err)
			continue
		}
		name := ""
		if len(c.Names) > 0 {
			name = c.Names[0]
		}
		agents = append(agents, Agent{
			ContainerID:   c.ID,
			ContainerName: name,
			Created:       c.Created,
			State:         string(c.State),
			Status:        c.Status,
			ImageName:     c.Image,
			Meta:          meta,
		})
	}
	return agents, nil
}

// SpawnOptions holds all configuration for launching a new agent container.
type SpawnOptions struct {
	Id                 string
	AgentType          AgentType
	DockerfilePath     string // optional; empty = use embedded default for AgentType
	DockerfileContents string // optional; if set, used as extension of default image
	PrePrompt          string
	Prompt             string
	ProjectPath        string
	WorktreePath       string
	BranchName         string
	BaseBranch         string
	GitAuthorName      string
	GitAuthorEmail     string
	UID                int
	GID                int
	Username           string
	GroupName          string
	Resume             bool // if true, run agent with --resume instead of a fresh prompt
	Ephemeral          bool // if true, set AutoRemove: true on the container
	OnStatus           func(api.AgentStatus)
	BuildLog           io.Writer // optional; if set, build output is written here
}

func CombinePrompt(prePrompt, prompt string) string {
	if prePrompt == "" {
		return prompt
	}
	return prePrompt + "\n" + prompt
}

func translateHostPathToContainer(path string) string {
	// On non-Windows hosts, no translation is needed.
	if runtime.GOOS != "windows" {
		return path
	}
	// On Windows convert drive-letter paths like "C:\foo" or "C:/foo"
	// into the Linux-style "/mnt/c/foo" that Docker for Windows exposes.
	if len(path) >= 2 && path[1] == ':' {
		drive := strings.ToLower(string(path[0]))
		p := path[2:]
		// normalize separators to forward slash
		p = strings.ReplaceAll(p, "\\", "/")
		// strip any leading slashes
		for len(p) > 0 && p[0] == '/' {
			p = p[1:]
		}
		return "/mnt/" + drive + "/" + p
	}
	// Fallback: just normalize separators
	return strings.ReplaceAll(path, "\\", "/")
}

// SpawnAgent builds the Docker image if necessary, then creates and starts the container.
// Returns the container ID.
func SpawnAgent(ctx context.Context, cli *dockerclient.Client, opts SpawnOptions) (string, error) {
	log.Printf("Spawning agent with options: %+v", opts)
	if opts.OnStatus != nil {
		opts.OnStatus(api.Building)
	}
	imageTag, err := ensureImage(ctx, cli, opts.AgentType, opts.DockerfilePath, opts.DockerfileContents, opts.ProjectPath, opts.BuildLog)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("ensure image: %w", err))
	}

	if opts.OnStatus != nil {
		opts.OnStatus(api.Starting)
	}
	meta := &AgentMetadata{
		Id:               opts.Id,
		AgentType:        opts.AgentType,
		PrePrompt:        opts.PrePrompt,
		Prompt:           opts.Prompt,
		ProjectPath:      opts.ProjectPath,
		HostWorktreePath: opts.WorktreePath,
		BranchName:       opts.BranchName,
		BaseBranch:       opts.BaseBranch,
	}
	labelVal, err := EncodeLabel(meta)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("encode label: %w", err))
	}

	// The entrypoint script creates a user in the container matching the host user's UID/GID/name,
	// then exec's into the agent as that user. This ensures file permissions round-trip correctly.
	containerHome := "/home/" + opts.Username
	env := []string{
		fmt.Sprintf("AGENT_UID=%d", opts.UID),
		fmt.Sprintf("AGENT_GID=%d", opts.GID),
		"AGENT_USER=" + opts.Username,
		"AGENT_GROUP=" + opts.GroupName,
		"AGENT_HOME=" + containerHome,
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
	}
	if opts.GitAuthorName != "" {
		env = append(env,
			"GIT_AUTHOR_NAME="+opts.GitAuthorName,
			"GIT_COMMITTER_NAME="+opts.GitAuthorName,
		)
	}
	if opts.GitAuthorEmail != "" {
		env = append(env,
			"GIT_AUTHOR_EMAIL="+opts.GitAuthorEmail,
			"GIT_COMMITTER_EMAIL="+opts.GitAuthorEmail,
		)
	}

	// Mount the main .git directory and the worktree at the same absolute paths as on the host.
	// This is required because git worktree .git files contain absolute paths back to the main .git dir.
	containerWorktreePath := translateHostPathToContainer(opts.WorktreePath)
	gitDir := opts.ProjectPath + "/.git"
	containerGitDir := translateHostPathToContainer(gitDir)
	binds := []string{
		containerGitDir + ":" + gitDir,
		containerWorktreePath + ":" + opts.WorktreePath,
	}
	agentBinds, err := getAgentBinds(opts.AgentType, opts.ProjectPath, opts.Id, containerHome)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	binds = append(binds, agentBinds...)

	var netCfg *network.NetworkingConfig
	var platform *ocispec.Platform

	containerName := "hydra-agent-" + opts.Id
	log.Printf("Creating container %s...", containerName)
	var cmd []string
	switch opts.AgentType {
	case AgentTypeClaude:
		if opts.Resume {
			cmd = []string{"claude", "--resume"}
		} else {
			cmd = []string{"claude", "--dangerously-skip-permissions"}
			if opts.Prompt != "" {
				cmd = append(cmd, "--", CombinePrompt(opts.PrePrompt, opts.Prompt))
			}
		}
	case AgentTypeGemini:
		if opts.Resume {
			cmd = []string{"gemini", "--resume"}
		} else {
			cmd = []string{"gemini", "--approval-mode=yolo"}
			if opts.Prompt != "" {
				cmd = append(cmd, "-i", CombinePrompt(opts.PrePrompt, opts.Prompt))
			}
		}
	case AgentTypeBash:
		cmd = []string{"/bin/bash"}
	default:
		return "", errtrace.Wrap(fmt.Errorf("unknown agent type: %q", opts.AgentType))
	}

	resp, err := cli.ContainerCreate(ctx,
		&container.Config{
			Image:      imageTag,
			Cmd:        cmd,
			Labels:     map[string]string{LabelKey: labelVal},
			Tty:        true,
			OpenStdin:  true,
			Env:        env,
			WorkingDir: containerWorktreePath,
		},
		&container.HostConfig{
			Binds:      binds,
			AutoRemove: opts.Ephemeral,
		},
		netCfg,
		platform,
		containerName,
	)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create container: %w", err))
	}

	log.Printf("Starting container %s (%s)...", containerName, resp.ID)
	if err := cli.ContainerStart(ctx, resp.ID, container.StartOptions{}); err != nil {
		_ = cli.ContainerRemove(ctx, resp.ID, container.RemoveOptions{Force: true})
		return "", errtrace.Wrap(fmt.Errorf("start container: %w", err))
	}

	log.Printf("Started container %s (%s)", containerName, resp.ID)
	return resp.ID, nil
}

// KillAgent stops and removes a container.
func KillAgent(ctx context.Context, cli *dockerclient.Client, containerID string) error {
	timeout := 10
	log.Printf("Stopping container %s...", containerID[:12])
	if err := cli.ContainerStop(ctx, containerID, container.StopOptions{Timeout: &timeout}); err != nil {
		if !dockerclient.IsErrNotFound(err) {
			log.Printf("warn: stop container %s: %v", containerID[:12], err)
		}
	}
	log.Printf("Removing container %s...", containerID[:12])
	if err := cli.ContainerRemove(ctx, containerID, container.RemoveOptions{Force: true}); err != nil {
		if !dockerclient.IsErrNotFound(err) {
			return errtrace.Wrap(fmt.Errorf("remove container: %w", err))
		}
		log.Printf("info: container %s already removed", containerID[:12])
	}
	return nil
}

// AttachAgent attaches to a running container's TTY, forwarding stdin/stdout.
// Press Ctrl+C to detach without stopping the container.
func AttachAgent(ctx context.Context, cli *dockerclient.Client, containerID string) error {
	fmt.Fprintln(os.Stderr, "Attached to agent. Press Ctrl+C to detach (container keeps running).")

	oldState, err := term.MakeRaw(os.Stdin.Fd())
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("set raw mode: %w", err))
	}
	defer term.Restore(os.Stdin.Fd(), oldState)

	resp, err := cli.ContainerAttach(ctx, containerID, container.AttachOptions{
		Stream: true,
		Stdin:  true,
		Stdout: true,
		Stderr: true,
	})
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("attach to container: %w", err))
	}
	defer resp.Close()

	// Send the initial terminal size so the container TUI knows how to render.
	syncTerminalSize(ctx, cli, containerID)

	// Inject a Ctrl+L byte (\x0c) into the container's stdin to force a TUI redraw.
	_, _ = resp.Conn.Write([]byte{'\x0c'})

	// detach closes the Docker attach connection once, unblocking all I/O goroutines.
	var detachOnce sync.Once
	detach := func() {
		detachOnce.Do(func() { resp.Close() })
	}

	// Handle external SIGINT (e.g. kill -2). In raw mode, keyboard Ctrl+C sends \x03
	// as a byte instead of SIGINT, which is intercepted in the stdin goroutine below.
	sigIntCh := make(chan os.Signal, 1)
	signal.Notify(sigIntCh, os.Interrupt)
	defer signal.Stop(sigIntCh)

	// Listen for window resize events from the host OS and forward them to the container.
	sigResizeCh := make(chan os.Signal, 1)
	notifyWindowResize(sigResizeCh)
	defer signal.Stop(sigResizeCh)

	// done is closed when AttachAgent returns, stopping the signal-handling goroutine.
	done := make(chan struct{})
	defer close(done)

	go func() {
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				detach()
				return
			case <-sigIntCh:
				detach()
				return
			case <-sigResizeCh:
				syncTerminalSize(ctx, cli, containerID)
			}
		}
	}()

	errCh := make(chan error, 2)

	// stdin → container. Ctrl+C (\x03) detaches without killing the container; all
	// other bytes are forwarded verbatim.
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := os.Stdin.Read(buf)
			if n > 0 {
				for i := 0; i < n; i++ {
					if buf[i] == 0x03 { // Ctrl+C in raw mode
						if i > 0 {
							_, _ = resp.Conn.Write(buf[:i])
						}
						detach()
						errCh <- nil
						return
					}
				}
				if _, werr := resp.Conn.Write(buf[:n]); werr != nil {
					errCh <- werr
					return
				}
			}
			if err != nil {
				if err == io.EOF {
					resp.CloseWrite()
				}
				errCh <- err
				return
			}
		}
	}()

	// container → stdout.
	go func() {
		_, err := io.Copy(os.Stdout, resp.Reader)
		errCh <- err
	}()

	err = <-errCh
	detach()

	if err != nil && err != io.EOF {
		return errtrace.Wrap(fmt.Errorf("stream copy: %w", err))
	}
	return nil
}

func syncTerminalSize(ctx context.Context, cli *dockerclient.Client, containerID string) {
	width, height, err := term.GetSize(os.Stdout.Fd())
	if err != nil {
		return
	}
	_ = cli.ContainerResize(ctx, containerID, container.ResizeOptions{
		Height: uint(height),
		Width:  uint(width),
	})
}

// ViewLogs runs `docker logs -f <id>`, streaming output to the terminal.
func ViewLogs(containerID string) error {
	cmd := exec.Command("docker", "logs", "-f", containerID)
	common.PrintExecCmd(cmd)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return errtrace.Wrap(cmd.Run())
}

// defaultDockerfileContent returns the embedded Dockerfile content for the given agent type.
func defaultDockerfileContent(agentType AgentType) (string, error) {
	switch agentType {
	case AgentTypeClaude:
		return config.DefaultDockerfileClaude, nil
	case AgentTypeGemini:
		return config.DefaultDockerfileGemini, nil
	case AgentTypeBash:
		return config.DefaultDockerfileBash, nil
	case "base":
		return config.DefaultDockerfileBase, nil
	default:
		return "", errtrace.Wrap(fmt.Errorf("unknown agent type: %q", agentType))
	}
}

// getAgentBinds returns host:container bind mounts for agent-specific config files.
// containerHome is the home directory of the agent user inside the container (e.g. /home/callum).
func getAgentBinds(agentType AgentType, projectRoot, id, containerHome string) ([]string, error) {
	hydraDir := paths.GetHydraDirFromProjectRoot(projectRoot)
	cacheDir := filepath.Join(hydraDir, "cache")
	if err := paths.CreateGitignoreAllInDir(cacheDir); err != nil {
		return nil, errtrace.Wrap(err)
	}

	// Create and share status JSON
	statusJsonHost := paths.GetStatusJsonFromProjectRoot(projectRoot, id)
	if err := paths.CreateGitignoreAllInDir(filepath.Dir(statusJsonHost)); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if err := os.WriteFile(statusJsonHost, []byte("{}"), 0644); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusJsonHost, err))
	}
	statusJsonContainer := filepath.Join(containerHome, ".hydra", "status.json")
	binds := []string{statusJsonHost + ":" + statusJsonContainer}

	// Create and share status log JSONL (truncated fresh on each spawn).
	statusLogHost := paths.GetStatusLogFromProjectRoot(projectRoot, id)
	if err := os.WriteFile(statusLogHost, []byte(""), 0644); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("write %s: %w", statusLogHost, err))
	}
	statusLogContainer := filepath.Join(containerHome, ".hydra", "status_log.jsonl")
	binds = append(binds, statusLogHost+":"+statusLogContainer)

	// Mount the hydra binary itself (read-only) so hook commands can call it directly.
	// On non-Linux hosts (e.g. macOS) the current executable is a darwin binary which
	// can't run inside the Linux container, so we cross-compile and cache a linux build.
	hydraBin, err := resolveContainerHydraBin(cacheDir)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("resolve hydra binary for container: %w", err))
	}
	hydraBinContainer := filepath.Join(containerHome, ".hydra", "hydra")
	binds = append(binds, hydraBin+":"+hydraBinContainer+":ro")

	switch agentType {
	case AgentTypeClaude:
		claudeSettingsDir := filepath.Join(cacheDir, ".claude")
		if err := os.MkdirAll(claudeSettingsDir, 0755); err != nil {
			return nil, errtrace.Wrap(err)
		}

		// Always write settings.json with hooks configuration.
		claudeSettingsJson := filepath.Join(claudeSettingsDir, "settings.json")
		var existing []byte
		if data, err := os.ReadFile(claudeSettingsJson); err == nil {
			existing = data
		}
		settingsData, err := buildClaudeSettings(existing)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err = os.WriteFile(claudeSettingsJson, settingsData, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}

		claudeJson := filepath.Join(cacheDir, ".claude.json")
		if _, err := os.Stat(claudeJson); os.IsNotExist(err) {
			if err = os.WriteFile(claudeJson, []byte("{}"), 0644); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}

		for _, pair := range []struct{ host, container string }{
			{claudeSettingsDir, containerHome + "/.claude"},
			{claudeJson, containerHome + "/.claude.json"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container)
			}
		}
	case AgentTypeGemini:
		geminiSettingsDir := filepath.Join(cacheDir, ".gemini")
		if err := os.MkdirAll(geminiSettingsDir, 0755); err != nil {
			return nil, errtrace.Wrap(err)
		}

		// Always write settings.json with hooks configuration.
		geminiSettingsJson := filepath.Join(geminiSettingsDir, "settings.json")
		var existing []byte
		if data, err := os.ReadFile(geminiSettingsJson); err == nil {
			existing = data
		}
		settingsData, err := buildGeminiSettings(existing)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if err = os.WriteFile(geminiSettingsJson, settingsData, 0644); err != nil {
			return nil, errtrace.Wrap(err)
		}

		for _, pair := range []struct{ host, container string }{
			{geminiSettingsDir, containerHome + "/.gemini"},
		} {
			if _, err := os.Stat(pair.host); err == nil {
				binds = append(binds, pair.host+":"+pair.container)
			}
		}
	}
	return binds, nil
}

// hookHandler is a single hook handler entry in a hooks settings.json.
type hookHandler struct {
	Type    string `json:"type"`
	Command string `json:"command"`
}

// matcherGroup is a matcher group (with optional matcher) in a hooks settings.json.
type matcherGroup struct {
	Hooks []hookHandler `json:"hooks"`
}

// buildHooksMap constructs a hooks map from a list of event names, all sharing the same command.
func buildHooksMap(cmd string, events []string) map[string]interface{} {
	group := []matcherGroup{{Hooks: []hookHandler{{Type: "command", Command: cmd}}}}
	m := make(map[string]interface{}, len(events))
	for _, event := range events {
		m[event] = group
	}
	return m
}

// buildClaudeSettings generates the settings.json content with hook configuration for Claude Code.
func buildClaudeSettings(existing []byte) ([]byte, error) {
	hooks := buildHooksMap("$HOME/.hydra/hydra trigger-hook claude", []string{
		"SessionStart",
		"UserPromptSubmit",
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"Notification",
		"Stop",
		"PreCompact",
		"SubagentStart",
		"SubagentStop",
		"SessionEnd",
	})

	settings := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &settings); err != nil {
			log.Printf("warn: failed to unmarshal existing claude settings: %v", err)
		}
	}

	settings["skipDangerousModePermissionPrompt"] = true
	settings["hooks"] = hooks

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal claude settings: %w", err))
	}
	return data, nil
}

// buildGeminiSettings generates the settings.json content with hook configuration for Gemini CLI.
func buildGeminiSettings(existing []byte) ([]byte, error) {
	hooks := buildHooksMap("$HOME/.hydra/hydra trigger-hook gemini", []string{
		"SessionStart",
		"BeforeAgent",
		"AfterAgent",
		"BeforeTool",
		"AfterTool",
		"Notification",
		"PreCompress",
		"SessionEnd",
	})

	settings := make(map[string]interface{})
	if len(existing) > 0 {
		if err := json.Unmarshal(existing, &settings); err != nil {
			log.Printf("warn: failed to unmarshal existing gemini settings: %v", err)
		}
	}

	settings["hooks"] = hooks

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("marshal gemini settings: %w", err))
	}
	return data, nil
}

// ensureImage ensures the Docker image for the given agent and optional custom
// Dockerfile exists, building it if necessary. Returns the image tag.
//
// Default images (customDockerfile == ""):
//   - Fallback to project-level custom Dockerfile if it exists: .hydra/config/<type>/Dockerfile
//   - Otherwise copies the embedded Dockerfile to ~/.hydra/default_dockerfiles/<type>/Dockerfile
//   - Tag: hydra-agent-<type>
//
// Custom images (customDockerfile != ""):
//   - Uses the provided Dockerfile; build context is its parent directory
//   - Tag: hydra-agent-<type>-<sha256(absPath)[:8]>
func ensureImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, customDockerfile string, dockerfileContents string, projectRoot string, buildLog io.Writer) (string, error) {
	var buildContext string
	if customDockerfile == "" && dockerfileContents == "" && projectRoot != "" {
		cfg, err := config.Load(projectRoot)
		if err == nil {
			resolved := cfg.GetResolvedConfig(string(agentType))
			if resolved.Dockerfile != nil {
				customDockerfile = *resolved.Dockerfile
			}
			if resolved.DockerfileContents != nil {
				dockerfileContents = *resolved.DockerfileContents
			}
			if resolved.Context != nil {
				buildContext = *resolved.Context
			}
		}
	}

	if dockerfileContents != "" {
		return errtrace.Wrap2(ensureExtendedImage(ctx, cli, agentType, dockerfileContents, buildContext, buildLog))
	}

	if customDockerfile == "" {
		return errtrace.Wrap2(ensureDefaultImage(ctx, cli, agentType, buildLog))
	}
	return errtrace.Wrap2(ensureCustomImage(ctx, cli, agentType, customDockerfile, buildContext, buildLog))
}

func ensureExtendedImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, contents string, buildContext string, buildLog io.Writer) (string, error) {
	// Build default image so FROM works
	baseTag, err := ensureDefaultImage(ctx, cli, agentType, buildLog)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("build default agent image: %w", err))
	}

	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(contents+buildContext)))[:8]
	tag := "hydra-agent-" + string(agentType) + "-extended:" + hash

	// Create a temporary Dockerfile that extends the base
	fullDockerfile := "FROM " + baseTag + "\n" + contents

	tempDir, err := os.MkdirTemp("", "hydra-build-")
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create temp build dir: %w", err))
	}
	defer os.RemoveAll(tempDir)

	dockerfilePath := filepath.Join(tempDir, "Dockerfile")
	if err := os.WriteFile(dockerfilePath, []byte(fullDockerfile), 0644); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("write temp dockerfile: %w", err))
	}

	if buildContext == "" {
		buildContext = tempDir
	}

	err = buildDockerImage(ctx, cli, tag, dockerfilePath, buildContext, buildLog)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return tag, nil
}

func GetDefaultImageTag(agentType AgentType) string {
	return "hydra-agent-" + string(agentType) + ":latest"
}

func ensureBaseImage(ctx context.Context, cli *dockerclient.Client, buildLog io.Writer) error {
	tag := "hydra-base:latest"

	// Copy the embedded Dockerfile to a stable per-user directory.
	ctxDir, err := prepareDefaultDockerfileDir("base")
	if err != nil {
		return errtrace.Wrap(err)
	}

	err = buildDockerImage(ctx, cli, tag, filepath.Join(ctxDir, "Dockerfile"), ctxDir, buildLog)
	if err != nil {
		return errtrace.Wrap(err)
	}
	return nil
}

func ensureDefaultImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, buildLog io.Writer) (string, error) {
	tag := GetDefaultImageTag(agentType)

	// Build base image first
	if err := ensureBaseImage(ctx, cli, buildLog); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("build base image: %w", err))
	}

	// Copy the embedded Dockerfile to a stable per-user directory.
	ctxDir, err := prepareDefaultDockerfileDir(agentType)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	err = buildDockerImage(ctx, cli, tag, filepath.Join(ctxDir, "Dockerfile"), ctxDir, buildLog)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return tag, nil
}

func ensureCustomImage(ctx context.Context, cli *dockerclient.Client, agentType AgentType, dockerfilePath string, buildContext string, buildLog io.Writer) (string, error) {
	abs, err := filepath.Abs(dockerfilePath)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("resolve dockerfile path: %w", err))
	}

	// Build default image so FROM works
	_, err = ensureDefaultImage(ctx, cli, agentType, buildLog)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("build default agent image: %w", err))
	}

	// Build custom image
	hash := fmt.Sprintf("%x", sha256.Sum256([]byte(abs+buildContext)))[:8]
	tag := "hydra-agent-" + string(agentType) + "-custom:" + hash

	if buildContext == "" {
		buildContext = filepath.Dir(abs)
	}

	err = buildDockerImage(ctx, cli, tag, abs, buildContext, buildLog)
	if err != nil {
		return "", errtrace.Wrap(err)
	}
	return tag, nil
}

// prepareDefaultDockerfileDir ensures ~/.hydra/default_dockerfiles/<type>/Dockerfile
// and entrypoint.sh exist with the current embedded content, then returns the directory.
func prepareDefaultDockerfileDir(agentType AgentType) (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get home dir: %w", err))
	}
	dir := filepath.Join(home, ".hydra", "default_dockerfiles", string(agentType))
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create dockerfile dir: %w", err))
	}

	dockerfileContent, err := defaultDockerfileContent(agentType)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	for _, f := range []struct {
		name    string
		content string
		perm    os.FileMode
	}{
		{"Dockerfile", dockerfileContent, 0644},
		{"entrypoint.sh", config.DefaultEntrypointScript, 0755},
	} {
		path := filepath.Join(dir, f.name)
		existing, readErr := os.ReadFile(path)
		if readErr != nil || string(existing) != f.content {
			if err := os.WriteFile(path, []byte(f.content), f.perm); err != nil {
				return "", errtrace.Wrap(fmt.Errorf("write %s: %w", f.name, err))
			}
		}
	}
	return dir, nil
}

func buildDockerImage(ctx context.Context, cli *dockerclient.Client, tag, dockerfilePath, buildContext string, buildLog io.Writer) error {
	log.Printf("Building Docker image: %s (from %s in %s)", tag, dockerfilePath, buildContext)

	// Docker expects the Dockerfile path to be relative to the build context root.
	relDockerfile, err := filepath.Rel(buildContext, dockerfilePath)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("resolve relative dockerfile path: %w", err))
	}
	// Ensure the path uses forward slashes, as required by the Docker daemon.
	relDockerfile = filepath.ToSlash(relDockerfile)

	pr, pw := io.Pipe()
	errChan := make(chan error, 1)

	go func() {
		tw := tar.NewWriter(pw)
		var walkErr error

		defer func() {
			tw.Close()
			pw.CloseWithError(walkErr)
			errChan <- walkErr
		}()

		walkErr = filepath.Walk(buildContext, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return errtrace.Wrap(err)
			}

			header, err := tar.FileInfoHeader(info, info.Name())
			if err != nil {
				return errtrace.Wrap(err)
			}

			rel, err := filepath.Rel(buildContext, path)
			if err != nil {
				return errtrace.Wrap(err)
			}

			// Docker expects forward slashes in tar headers regardless of the host OS
			header.Name = filepath.ToSlash(rel)

			if err := tw.WriteHeader(header); err != nil {
				return errtrace.Wrap(err)
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			f, err := os.Open(path)
			if err != nil {
				return errtrace.Wrap(err)
			}
			defer f.Close()
			_, err = io.Copy(tw, f)
			return errtrace.Wrap(err)
		})
	}()

	resp, err := cli.ImageBuild(ctx, pr, build.ImageBuildOptions{
		Tags:       []string{tag},
		Dockerfile: relDockerfile, // Use the relative, slash-converted path here
	})
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("build image: %w", err))
	}
	defer resp.Body.Close()

	decoder := json.NewDecoder(resp.Body)
	for {
		var line struct {
			Stream string `json:"stream"`
			Error  string `json:"error"`
		}
		if err := decoder.Decode(&line); err != nil {
			if err == io.EOF {
				break
			}
			return errtrace.Wrap(fmt.Errorf("decode build output: %w", err))
		}
		if line.Error != "" {
			return errtrace.Wrap(fmt.Errorf("build error: %s", line.Error))
		}
		if line.Stream != "" {
			log.Printf("[Building %s] %s", tag, line.Stream)
			if buildLog != nil {
				fmt.Fprint(buildLog, line.Stream)
			}
		}
	}

	if err := <-errChan; err != nil {
		return errtrace.Wrap(fmt.Errorf("create build context archive: %w", err))
	}

	log.Printf("Built Docker image: %s (from %s in %s)", tag, dockerfilePath, buildContext)
	return nil
}

// resolveContainerHydraBin returns the path to a hydra binary that can run
// inside a Linux container. On Linux hosts the current executable is returned
// directly. On non-Linux hosts the binary embedded at build time (via
// `mage build`) is extracted to cacheDir/hydra and that path is returned.
func resolveContainerHydraBin(cacheDir string) (string, error) {
	if runtime.GOOS == "linux" {
		return errtrace.Wrap2(os.Executable())
	}

	if len(embeddedLinuxBinary) == 0 {
		return "", errtrace.Wrap(fmt.Errorf(
			"no Linux binary embedded in hydra; on non-Linux systems you must build with `mage build` or `mage dev` rather than `go run ./`",
		))
	}

	dest := filepath.Join(cacheDir, "hydra")

	// Re-extract only when the embedded binary may have changed (i.e. when the
	// current executable is newer than the previously extracted file).
	currentBin, err := os.Executable()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("resolve current executable: %w", err))
	}
	currentInfo, err := os.Stat(currentBin)
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("stat current executable: %w", err))
	}
	if destInfo, err := os.Stat(dest); err != nil || destInfo.ModTime().Before(currentInfo.ModTime()) {
		if err := os.MkdirAll(cacheDir, 0755); err != nil {
			return "", errtrace.Wrap(fmt.Errorf("create cache dir: %w", err))
		}
		if err := os.WriteFile(dest, embeddedLinuxBinary, 0755); err != nil {
			return "", errtrace.Wrap(fmt.Errorf("write linux hydra binary: %w", err))
		}
	}

	return dest, nil
}

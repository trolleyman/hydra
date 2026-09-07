package agenthost

import (
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/agentenv"
	"github.com/trolleyman/hydra/internal/agenthostapi"
	"github.com/trolleyman/hydra/internal/chat"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/codexstream"
	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/gate"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/gitq"
	"github.com/trolleyman/hydra/internal/policyapi"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

const providerSessionID = "provider"

type providerRuntime interface {
	Send(json.RawMessage) error
	Interrupt() error
	Respond(json.RawMessage) error
	SetModel(string) error
	Close()
}

type providerLauncher func(context.Context, agenthostapi.InitializeCommand, *chat.Manager, *writer, *approvalBroker, ioLogger) (providerRuntime, error)

type ioLogger interface {
	Write([]byte) (int, error)
}

type liveProvider struct {
	reg      *session.Registry
	egress   *egress.Session
	gateStop func()
	gitStop  func()
	closeOne sync.Once
}

func (p *liveProvider) Send(content json.RawMessage) error {
	return errtrace.Wrap(p.reg.SendChatUser(providerSessionID, content))
}
func (p *liveProvider) Interrupt() error {
	return errtrace.Wrap(p.reg.InterruptChat(providerSessionID))
}
func (p *liveProvider) Respond(response json.RawMessage) error {
	return errtrace.Wrap(p.reg.RespondChat(providerSessionID, response))
}
func (p *liveProvider) SetModel(model string) error {
	return errtrace.Wrap(p.reg.SetChatModel(providerSessionID, model))
}
func (p *liveProvider) Close() {
	p.closeOne.Do(func() {
		_ = p.reg.Kill(providerSessionID)
		p.reg.StopAll()
		p.egress.Close()
		if p.gateStop != nil {
			p.gateStop()
		}
		if p.gitStop != nil {
			p.gitStop()
		}
	})
}

func startProvider(ctx context.Context, init agenthostapi.InitializeCommand, manager *chat.Manager, output *writer, approvals *approvalBroker, logs ioLogger) (providerRuntime, error) {
	agentType, err := policyProvider(init.Policy.Provider)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	launch, egressSession, err := providerSandbox(init, agentType, approvals.requestNetwork)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	reg := session.NewRegistry()
	provider := &liveProvider{reg: reg, egress: egressSession}
	provider.gateStop = approvals.watchGate(filepath.Join(init.ConversationDir, "private", "tmp", "approvals"), filepath.Join(init.ConversationDir, "private", "seed", "gate-policy.json"))
	provider.gitStop = watchGitOperations(filepath.Join(init.ConversationDir, "private", "tmp", "gitops"), init.Workspace, init.Policy.Git, approvals)
	reg.SetOnChatLine(func(_ string, source string, line []byte) {
		manager.ObserveProviderLine(providerSessionID, source, line)
		if agentType == sandbox.AgentTypeClaude {
			persistClaudeSessionID(init.ConversationDir, line)
		}
	})
	reg.SetOnChatAPIError(func(_ string, message string) {
		_ = writeError(output, "", "provider_api", message, false)
	})
	reg.SetOnExit(func(info session.Info) {
		if ctx.Err() == nil && !info.StopRequested {
			_ = writeError(output, "", "provider_exit", "provider process exited", false)
		}
	})

	if _, err := reg.Start(session.StartOptions{ID: providerSessionID, Sandbox: launch}); err != nil {
		provider.Close()
		return nil, errtrace.Wrap(err)
	}
	if agentType == sandbox.AgentTypeCodex {
		if err := attachCodex(reg, init, manager, output, logs); err != nil {
			provider.Close()
			return nil, errtrace.Wrap(err)
		}
	}
	return provider, nil
}

func attachCodex(reg *session.Registry, init agenthostapi.InitializeCommand, manager *chat.Manager, output *writer, logs ioLogger) error {
	attachment, err := reg.Attach(providerSessionID, 0, 0)
	if err != nil {
		return errtrace.Wrap(err)
	}
	controller := codexstream.New(codexstream.Options{
		CWD: init.Workspace, Model: init.Policy.Model, Effort: init.Policy.Effort,
		ConversationID: init.ResumeSessionId,
		Send:           func(line []byte) error { return errtrace.Wrap(reg.Write(providerSessionID, line)) },
		OnConversation: func(id string) { persistProviderSessionID(init.ConversationDir, policyapi.ProviderCodex, id) },
		OnModel:        func(model string) { reg.ObserveChatModel(providerSessionID, model) },
		OnStep:         func() { reg.ChatStep(providerSessionID) },
		OnTurnEnd:      func(string) { reg.ChatTurnEnded(providerSessionID) },
		OnHistoryLine:  func(line []byte) { manager.ObserveProviderLine(providerSessionID, "codex_history", line) },
		OnError: func(err error) {
			_, _ = fmt.Fprintf(logs, "agent-host: Codex controller: %v\n", err)
			_ = writeError(output, "", "provider_protocol", err.Error(), false)
		},
	})
	if err := reg.SetChatDriver(providerSessionID, controller); err != nil {
		attachment.Close()
		return errtrace.Wrap(err)
	}
	go func() {
		defer attachment.Close()
		lines := &claudestream.LineBuffer{}
		for {
			select {
			case <-attachment.Done:
				return
			case chunk, ok := <-attachment.Output:
				if !ok {
					return
				}
				for _, line := range lines.Feed(chunk) {
					controller.OnLine(line)
				}
			}
		}
	}()
	if err := controller.Start(); err != nil {
		attachment.Close()
		return errtrace.Wrap(err)
	}
	return nil
}

func providerSandbox(init agenthostapi.InitializeCommand, agentType sandbox.AgentType, approve egress.ApproveFunc) (sandbox.Options, *egress.Session, error) {
	if err := validateEffectivePolicy(init.Policy); err != nil {
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	privateDir := filepath.Join(init.ConversationDir, "private")
	tmpDir := filepath.Join(privateDir, "tmp")
	seedDir := filepath.Join(privateDir, "seed")
	for _, dir := range []string{tmpDir, seedDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return sandbox.Options{}, nil, errtrace.Wrap(err)
		}
	}
	approvalDir := filepath.Join(tmpDir, "approvals")
	if err := os.MkdirAll(approvalDir, 0o700); err != nil {
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	gitopsDir := filepath.Join(tmpDir, "gitops")
	if err := os.MkdirAll(gitopsDir, 0o700); err != nil {
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	if stale, err := gate.ListRequests(approvalDir); err == nil {
		for _, request := range stale {
			gate.RemoveRequest(approvalDir, request.ReqID)
		}
	}
	if stale, err := gitq.ListRequests(gitopsDir); err == nil {
		for _, request := range stale {
			_ = gitq.WriteResult(gitopsDir, request.ReqID, gitq.Result{Message: "The provider session ended before this Git request could run."})
		}
	}

	argv, err := sandbox.AgentArgv(agentType, init.ResumeSessionId != "", init.Policy.Prompt, "", init.Policy.Model, init.Policy.Effort, true, init.ResumeSessionId, strictMCPConfigSandboxPath(agentType, init.Policy.UserHome), claudeSettingSources(agentType))
	if err != nil {
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	if executable := strings.TrimSpace(init.ProviderExecutable); executable != "" {
		argv[0] = executable
	}

	defaults := sandbox.Defaults()
	binds, immutable, err := providerSeeds(init, agentType, seedDir)
	if err != nil {
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	providerWritable, stateBinds, err := providerState(init.Policy.UserHome, privateDir, agentType)
	if err != nil {
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	binds = append(stateBinds, binds...)
	gatePolicyPath := filepath.Join(seedDir, "gate-policy.json")
	if err := providerGatePolicy(init.Policy, agentType).Save(gatePolicyPath); err != nil {
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	binds = append(binds, sandbox.Bind{Source: gatePolicyPath, Target: "/tmp/hydra-vscode-policy.json", ReadOnly: true})
	immutable = append(immutable, gatePolicyPath)
	netPolicy := networkPolicy(init.Policy.Network)
	egressSession := egress.StartCommandEgress("vscode-"+filepath.Base(init.ConversationDir), agentType, &netPolicy, 0, approve)
	identity, _ := user.Current()
	username := ""
	if identity != nil {
		username = identity.Username
	}
	env := agentenv.FromHost(agentType, nil, init.Policy.UserHome, username, "", "")
	env = append(env,
		gate.EnvPolicyPath+"=/tmp/hydra-vscode-policy.json",
		gate.EnvApprovalDir+"=/tmp/approvals",
		gate.EnvWorktree+"="+init.Workspace,
		"HYDRA_GITOPS_DIR=/tmp/gitops",
		"HYDRA_VSCODE_GIT_OPERATIONS="+strings.Join(enabledGitOperations(init.Policy.Git), ","),
	)
	env = sandbox.RuntimeEnv(append(env, egressSession.Env...), tmpDir)
	agentHostExecutable, err := os.Executable()
	if err != nil {
		egressSession.Close()
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}

	gitDir, _ := git.GetCommonDir(init.Workspace)
	gitIsolation := sandbox.GitIsolationReadonly
	if init.Policy.Git.Isolation != nil && *init.Policy.Git.Isolation == policyapi.GitOff {
		gitIsolation = sandbox.GitIsolationOff
	}
	workingDirReadOnly := !pathCovered(init.Workspace, init.Policy.Filesystem.Writable)
	cowMounts, err := providerCowMounts(init, privateDir)
	if err != nil {
		egressSession.Close()
		return sandbox.Options{}, nil, errtrace.Wrap(err)
	}
	return sandbox.Options{
		AgentType: agentType, WorktreePath: init.Workspace, WorkingDirReadOnly: workingDirReadOnly,
		GitCommonDir: gitDir, GitIsolation: gitIsolation, Home: init.Policy.UserHome,
		TmpDir:        tmpDir,
		WritablePaths: append(append(defaults.WritablePaths, providerWritable...), init.Policy.Filesystem.Writable...),
		ReadablePaths: append(defaults.ReadablePaths, init.Policy.Filesystem.Readable...),
		MaskedPaths:   append(defaults.MaskedPaths, init.Policy.Filesystem.Masked...),
		Network:       netPolicy, Binds: binds, ImmutablePaths: immutable, CowMounts: cowMounts, Env: env, Argv: argv,
		HydraBinPath: agentHostExecutable,
		StdioPipes:   true, EgressWrap: egressSession.Wrap, HardenGUI: true, Seccomp: true,
	}, egressSession, nil
}

func providerState(home, privateDir string, agentType sandbox.AgentType) ([]string, []sandbox.Bind, error) {
	targets := sandbox.ProviderWritablePaths(agentType)
	writable := make([]string, 0, len(targets))
	binds := make([]sandbox.Bind, 0, len(targets))
	for _, authored := range targets {
		target := sandbox.ExpandPath(authored, home)
		if _, err := os.Lstat(target); err == nil {
			writable = append(writable, target)
			continue
		} else if !os.IsNotExist(err) {
			return nil, nil, errtrace.Wrap(err)
		}
		name := strings.TrimPrefix(authored, "~/")
		source := filepath.Join(privateDir, "provider-state", name)
		if strings.HasSuffix(name, ".json") {
			if err := os.MkdirAll(filepath.Dir(source), 0o700); err != nil {
				return nil, nil, errtrace.Wrap(err)
			}
			if err := os.WriteFile(source, []byte("{}\n"), 0o600); err != nil {
				return nil, nil, errtrace.Wrap(err)
			}
		} else if err := os.MkdirAll(source, 0o700); err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		binds = append(binds, sandbox.Bind{Source: source, Target: target})
	}
	return writable, binds, nil
}

func providerCowMounts(init agenthostapi.InitializeCommand, privateDir string) ([]sandbox.CowMount, error) {
	mounts := make([]sandbox.CowMount, 0, len(init.Policy.Filesystem.CopyOnWrite))
	for _, target := range init.Policy.Filesystem.CopyOnWrite {
		if !pathCovered(target, []string{init.Workspace}) {
			return nil, errtrace.Wrap(fmt.Errorf("copy_on_write path must be inside the workspace: %q", target))
		}
		info, err := os.Stat(target)
		if err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("copy_on_write path %q: %w", target, err))
		}
		if !info.IsDir() {
			return nil, errtrace.Wrap(fmt.Errorf("copy_on_write path is not a directory: %q", target))
		}
		hash := fnv.New64a()
		_, _ = hash.Write([]byte(target))
		root := filepath.Join(privateDir, "cow", fmt.Sprintf("%x", hash.Sum64()))
		upper, work := filepath.Join(root, "upper"), filepath.Join(root, "work")
		for _, dir := range []string{upper, work} {
			if err := os.MkdirAll(dir, 0o700); err != nil {
				return nil, errtrace.Wrap(err)
			}
		}
		mounts = append(mounts, sandbox.CowMount{Lower: target, Upper: upper, Work: work, Dest: target})
	}
	return mounts, nil
}

func providerSeeds(init agenthostapi.InitializeCommand, agentType sandbox.AgentType, seedDir string) ([]sandbox.Bind, []string, error) {
	keep := allowedMCPServers(init.Policy.Tools.Mcp)
	controlBin := ""
	if len(enabledGitOperations(init.Policy.Git)) > 0 {
		controlBin = sandbox.HydraBinPath
	}
	writeSeed := func(name string, data []byte, mode os.FileMode) (string, error) {
		file := filepath.Join(seedDir, name)
		if err := os.WriteFile(file, data, mode); err != nil {
			return "", errtrace.Wrap(err)
		}
		return file, nil
	}
	switch agentType {
	case sandbox.AgentTypeClaude:
		userConfig := readFile(filepath.Join(init.Policy.UserHome, ".claude.json"))
		workspaceConfig := readFile(filepath.Join(init.Workspace, ".mcp.json"))
		config, err := sandbox.BuildStrictMCPConfig(userConfig, workspaceConfig, keep, controlBin, "claude")
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		mcpFile, err := writeSeed("claude-mcp.json", config, 0o600)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		settings, err := sandbox.BuildStandaloneClaudeSettings(sandbox.HydraBinPath, keep)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		settingsFile, err := writeSeed("claude-settings.json", settings, 0o600)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		return []sandbox.Bind{
			{Source: mcpFile, Target: "/tmp/hydra-vscode-mcp.json", ReadOnly: true},
			{Source: settingsFile, Target: filepath.Join(init.Policy.UserHome, ".claude", "settings.json"), ReadOnly: true},
		}, []string{mcpFile, settingsFile}, nil
	case sandbox.AgentTypeCodex:
		codexDir := filepath.Join(init.Policy.UserHome, ".codex")
		var config []byte
		var err error
		if controlBin == "" {
			config, err = sandbox.BuildStandaloneCodexConfig(readFile(filepath.Join(codexDir, "config.toml")), keep)
		} else {
			config, err = sandbox.BuildCodexConfig(readFile(filepath.Join(codexDir, "config.toml")), controlBin, keep)
		}
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		configFile, err := writeSeed("codex-config.toml", config, 0o600)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		binds := []sandbox.Bind{{Source: configFile, Target: filepath.Join(codexDir, "config.toml"), ReadOnly: true}}
		immutable := []string{configFile}
		hooks, err := sandbox.BuildStandaloneCodexHooks(sandbox.HydraBinPath)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		hooksFile, err := writeSeed("codex-hooks.json", hooks, 0o600)
		if err != nil {
			return nil, nil, errtrace.Wrap(err)
		}
		binds = append(binds, sandbox.Bind{Source: hooksFile, Target: filepath.Join(codexDir, "hooks.json"), ReadOnly: true})
		immutable = append(immutable, hooksFile)
		if init.Policy.Prompt != "" {
			content := combineInstructions(init.Policy.Prompt, readFile(filepath.Join(codexDir, "AGENTS.md")))
			agentsFile, err := writeSeed("codex-AGENTS.md", content, 0o600)
			if err != nil {
				return nil, nil, errtrace.Wrap(err)
			}
			binds = append(binds, sandbox.Bind{Source: agentsFile, Target: filepath.Join(codexDir, "AGENTS.md"), ReadOnly: true})
			immutable = append(immutable, agentsFile)
		}
		return binds, immutable, nil
	default:
		return nil, nil, errtrace.Wrap(fmt.Errorf("unsupported provider %q", agentType))
	}
}

func strictMCPConfigSandboxPath(agentType sandbox.AgentType, _ string) string {
	if agentType == sandbox.AgentTypeClaude {
		return "/tmp/hydra-vscode-mcp.json"
	}
	return ""
}

func claudeSettingSources(agentType sandbox.AgentType) string {
	if agentType == sandbox.AgentTypeClaude {
		return "user"
	}
	return ""
}

func allowedMCPServers(servers map[string]policyapi.MCPServerPolicy) []string {
	keep := make([]string, 0, len(servers))
	for name, server := range servers {
		if server.Decision == policyapi.PolicyDeny {
			continue
		}
		if server.Decision == policyapi.PolicyAllow {
			keep = append(keep, name)
			continue
		}
		for _, tool := range server.Tools {
			if tool.Decision == policyapi.PolicyAllow {
				keep = append(keep, name)
				break
			}
		}
	}
	sort.Strings(keep)
	return keep
}

func providerGatePolicy(policy policyapi.EffectivePolicy, agentType sandbox.AgentType) gate.Policy {
	result := gate.Policy{
		GateEnabled: true, ToolDecisions: map[string]gate.Decision{},
		MCPToolRW: map[string]string{}, Home: policy.UserHome, WorktreePath: policy.Workspace,
		HostMediatedGit:      true,
		WebFetchFilter:       policy.Network.Mode == policyapi.NetworkHard || policy.Network.Mode == policyapi.NetworkAdvisory,
		WebFetchAllowHosts:   append(sandbox.DefaultAllowedHosts(agentType), policy.Network.AllowedHosts...),
		WebFetchBlockedHosts: append([]string(nil), policy.Network.BlockedHosts...),
	}
	if policy.Git.Isolation != nil {
		result.HostMediatedGit = *policy.Git.Isolation == policyapi.GitReadOnly
	}
	if core := policy.Tools.Core; core != nil {
		for name, decision := range map[string]*policyapi.PolicyDecision{"read": core.Read, "search": core.Search, "edit": core.Edit, "bash": core.Bash, "fetch": core.Fetch} {
			if decision != nil {
				result.ToolDecisions[name] = gate.Decision(*decision)
			}
		}
	}
	for serverName, server := range policy.Tools.Mcp {
		switch server.Decision {
		case policyapi.PolicyAllow:
			result.MCPAllowed = append(result.MCPAllowed, serverName)
		case policyapi.PolicyDeny:
			result.MCPBlocked = append(result.MCPBlocked, serverName)
		}
		for toolName, tool := range server.Tools {
			full := serverName + "__" + toolName
			switch tool.Decision {
			case policyapi.PolicyAllow:
				result.MCPToolsAllowed = append(result.MCPToolsAllowed, full)
			case policyapi.PolicyDeny:
				result.MCPToolsBlocked = append(result.MCPToolsBlocked, full)
			}
		}
	}
	return result
}

func networkPolicy(policy policyapi.EffectiveNetworkPolicy) sandbox.NetworkPolicy {
	mode := sandbox.NetworkMode(policy.Mode)
	return sandbox.NetworkPolicy{
		Mode: mode, Enabled: mode != sandbox.NetOff,
		FilterHosts:  mode == sandbox.NetHard || mode == sandbox.NetAdvisory,
		AllowedHosts: append([]string(nil), policy.AllowedHosts...),
		BlockedHosts: append([]string(nil), policy.BlockedHosts...),
	}
}

func policyProvider(provider policyapi.ProviderKind) (sandbox.AgentType, error) {
	switch provider {
	case policyapi.ProviderClaude:
		return sandbox.AgentTypeClaude, nil
	case policyapi.ProviderCodex:
		return sandbox.AgentTypeCodex, nil
	default:
		return "", errtrace.Wrap(fmt.Errorf("unsupported provider %q", provider))
	}
}

func validateEffectivePolicy(policy policyapi.EffectivePolicy) error {
	if _, err := policyProvider(policy.Provider); err != nil {
		return errtrace.Wrap(err)
	}
	if !sandbox.ValidNetworkMode(string(policy.Network.Mode)) {
		return errtrace.Wrap(fmt.Errorf("invalid network mode %q", policy.Network.Mode))
	}
	if policy.Git.Isolation != nil && !sandbox.ValidGitIsolation(string(*policy.Git.Isolation)) {
		return errtrace.Wrap(fmt.Errorf("invalid git isolation %q", *policy.Git.Isolation))
	}
	for operation, decision := range policy.Git.Operations {
		if !validGitOperations[operation] {
			return errtrace.Wrap(fmt.Errorf("unknown Git operation %q", operation))
		}
		if !validDecision(decision) {
			return errtrace.Wrap(fmt.Errorf("invalid Git decision for %s: %q", operation, decision))
		}
	}
	home, err := canonicalDirectory(policy.UserHome)
	if err != nil {
		return errtrace.Wrap(fmt.Errorf("user_home: %w", err))
	}
	actualHome, err := os.UserHomeDir()
	if err != nil {
		return errtrace.Wrap(err)
	}
	actualHome, err = canonicalDirectory(actualHome)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if home != actualHome {
		return errtrace.Wrap(fmt.Errorf("user_home %q does not match host home %q", home, actualHome))
	}
	for kind, paths := range map[string][]string{
		"readable": policy.Filesystem.Readable, "writable": policy.Filesystem.Writable,
		"copy_on_write": policy.Filesystem.CopyOnWrite, "masked": policy.Filesystem.Masked,
	} {
		for _, item := range paths {
			if !filepath.IsAbs(item) || strings.Contains(item, "${") || strings.HasPrefix(item, "~") {
				return errtrace.Wrap(fmt.Errorf("%s path is not a resolved absolute path: %q", kind, item))
			}
			if canonical := canonicalWithMissingLeaf(item); canonical != filepath.Clean(item) {
				return errtrace.Wrap(fmt.Errorf("%s path is not canonical: %q resolves through %q", kind, item, canonical))
			}
		}
	}
	if core := policy.Tools.Core; core != nil {
		for name, decision := range map[string]*policyapi.PolicyDecision{"read": core.Read, "search": core.Search, "edit": core.Edit, "bash": core.Bash, "fetch": core.Fetch} {
			if decision != nil && !validDecision(*decision) {
				return errtrace.Wrap(fmt.Errorf("invalid core tool decision for %s: %q", name, *decision))
			}
		}
	}
	for serverName, server := range policy.Tools.Mcp {
		if !validDecision(server.Decision) {
			return errtrace.Wrap(fmt.Errorf("invalid MCP decision for %s: %q", serverName, server.Decision))
		}
		for toolName, tool := range server.Tools {
			if !validDecision(tool.Decision) {
				return errtrace.Wrap(fmt.Errorf("invalid MCP tool decision for %s/%s: %q", serverName, toolName, tool.Decision))
			}
		}
	}
	return nil
}

func validDecision(decision policyapi.PolicyDecision) bool {
	return decision == policyapi.PolicyAllow || decision == policyapi.PolicyAsk || decision == policyapi.PolicyDeny
}

func canonicalWithMissingLeaf(path string) string {
	clean := filepath.Clean(path)
	probe := clean
	var suffix []string
	for {
		if resolved, err := filepath.EvalSymlinks(probe); err == nil {
			for i := len(suffix) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, suffix[i])
			}
			return filepath.Clean(resolved)
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return clean
		}
		suffix = append(suffix, filepath.Base(probe))
		probe = parent
	}
}

func pathCovered(target string, roots []string) bool {
	for _, root := range roots {
		rel, err := filepath.Rel(root, target)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

func combineInstructions(prompt string, host []byte) []byte {
	var out strings.Builder
	out.WriteString(strings.TrimSpace(prompt))
	if len(host) > 0 {
		out.WriteString("\n\n")
		out.WriteString(bytesTrimSpace(host))
	}
	out.WriteByte('\n')
	return []byte(out.String())
}

func bytesTrimSpace(value []byte) string { return strings.TrimSpace(string(value)) }

func readFile(path string) []byte {
	data, _ := os.ReadFile(path)
	return data
}

func persistClaudeSessionID(dir string, line []byte) {
	var value struct {
		Type      string `json:"type"`
		Subtype   string `json:"subtype"`
		SessionID string `json:"session_id"`
	}
	if json.Unmarshal(line, &value) == nil && value.Type == "system" && value.Subtype == "init" && value.SessionID != "" {
		persistProviderSessionID(dir, policyapi.ProviderClaude, value.SessionID)
	}
}

func persistProviderSessionID(dir string, provider policyapi.ProviderKind, id string) {
	value := struct {
		Sessions map[policyapi.ProviderKind]string `json:"sessions"`
	}{Sessions: map[policyapi.ProviderKind]string{}}
	if data, err := os.ReadFile(filepath.Join(dir, "provider.json")); err == nil {
		_ = json.Unmarshal(data, &value)
	}
	if value.Sessions == nil {
		value.Sessions = map[policyapi.ProviderKind]string{}
	}
	value.Sessions[provider] = id
	data, _ := json.MarshalIndent(value, "", "  ")
	tmp := filepath.Join(dir, "provider.json.tmp")
	if os.WriteFile(tmp, append(data, '\n'), 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(dir, "provider.json"))
	}
}

func readProviderSessionID(dir string, provider policyapi.ProviderKind) string {
	data, err := os.ReadFile(filepath.Join(dir, "provider.json"))
	if err != nil {
		return ""
	}
	var value struct {
		Sessions map[policyapi.ProviderKind]string `json:"sessions"`
	}
	if json.Unmarshal(data, &value) != nil {
		return ""
	}
	return value.Sessions[provider]
}

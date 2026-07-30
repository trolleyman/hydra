package heads

// The review slot: a second agent attached to a head, whose job is to read that
// head's diff and talk to you about it. Design and rationale in
// docs/review-agent.md; this comment covers only what a reader of the code needs.
//
// It is modelled on the bash shell tabs (StartShellSession), not on a spawned
// head: it is a session.Registry entry and nothing else, so it needs no db.Agent
// row, no branch, no sidebar card and no merge path. ListHeads builds from
// store.ListAgents, so a registry-only session is invisible to it by
// construction, and SlotPrefix teardown on kill/merge already catches it.
//
// Three properties are load-bearing, and they are one decision seen from three
// angles:
//
//   - Its OWN checkout, never the head's worktree. Provider conversation state
//     is keyed by working directory, so sharing the head's tree could let the
//     head resume the reviewer's conversation - and a read-write reviewer racing
//     the head's in-flight edits could corrupt the very work under review.
//   - That checkout is PERSISTENT, not a checkout.Pool slot: a recycled path
//     means a new transcript on every re-acquire.
//   - It cannot write to git, enforced twice: git_isolation=readonly makes the
//     common dir read-only at the OS level, and the host-mediated git MCP tools
//     are blocked so the hatch that mode deliberately leaves open is shut.

import (
	"fmt"
	"log"
	"os"
	"os/user"
	"path/filepath"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
	"github.com/trolleyman/hydra/internal/paths"
	"github.com/trolleyman/hydra/internal/sandbox"
	"github.com/trolleyman/hydra/internal/session"
)

// ReviewSlot names a head's default review session. Extra reviewers would be
// "review-<lens>" (e.g. "review-security") - distinguished by LENS rather than by
// ordinal, because an ordinal hides the only thing that makes a second reviewer
// worth having and is unstable under kill-and-recreate.
const ReviewSlot = "review"

// ReviewSessionID is the registry session ID for a head's review slot,
// "<head>@review". See SlotSep for why the separator matters.
func ReviewSessionID(headID string) string { return SlotSessionID(headID, ReviewSlot) }

// reviewAgentType follows the provider of the head being reviewed whenever that
// provider supports Hydra's structured chat mode. Review predates chat support
// outside Claude, so non-chat providers retain the existing Claude fallback.
func reviewAgentType(head Head) sandbox.AgentType {
	if head.AgentType == sandbox.AgentTypeCodex {
		return sandbox.AgentTypeCodex
	}
	return sandbox.AgentTypeClaude
}

// reviewBlockedTools names the host-mediated git MCP tools denied to a review
// session, as "<server>__<tool>" (the gate's MCP naming, checked in gate.Decide
// before any allow list). GitIsolationReadonly blocks direct .git writes at the
// OS level, but that mode exists precisely so an agent can still commit *through*
// these tools - so without this the reviewer would keep the one escape hatch the
// isolation deliberately leaves open. Mirrors the git tool set in
// internal/mcpserver/server.go.
var reviewBlockedTools = []string{
	"hydra__git_commit",
	"hydra__git_add",
	"hydra__git_reset",
	"hydra__git_revert",
	"hydra__git_rebase",
	"hydra__git_rebase_continue",
	"hydra__git_rebase_abort",
	"hydra__git_cherry_pick",
	"hydra__git_merge",
	"hydra__git_merge_continue",
	"hydra__git_merge_abort",
	"hydra__git_stash",
}

// reviewSystemPrompt tells the reviewer what it is and what it cannot do. The
// "cannot" half is not politeness: an agent that does not know its tree is
// throwaway will happily "fix" a finding, and the edit silently evaporates.
const reviewSystemPrompt = `You are a code reviewer attached to a Hydra head. You are NOT the agent that wrote this code, and you are not talking to it - you are talking to the human reviewing it.

Your checkout is a disposable, detached copy of the head's branch. You have no branch, nothing you write to disk is kept, and you cannot commit, stage, merge or push: the repository is mounted read-only and the git write tools are blocked. Do not try to fix what you find - describe it, and say where.

The head keeps working while you are idle, and your checkout is moved forward to its branch tip between your turns, silently and without telling you. So anything you read in an earlier turn may be from an older commit: check the current HEAD and re-read a file before relying on what you remember of it.

Review the diff between the base branch and this checkout's HEAD. Correctness first, then anything that would fail in production, then clarity. Say plainly when something is fine; do not manufacture findings. Prefer a few specific, located observations over an exhaustive list - the person reading you can only act on so many.`

// ReviewCheckoutRef is the ref a head's reviewer should be looking at: its branch
// tip. Committed work only - the checkout is a commit, so uncommitted changes in
// the head's worktree are invisible to the reviewer.
func ReviewCheckoutRef(head Head) string {
	if head.Branch != nil && *head.Branch != "" {
		return *head.Branch
	}
	return head.BaseBranch
}

// EnsureReviewCheckout creates, or fast-forwards, the head's persistent review
// checkout to ref and returns its path. Creation is a detached `git worktree add`
// - no branch, because the reviewer can never commit - and a later call checks
// the existing tree out at the new ref, which is how the reviewer follows the
// head as it commits.
//
// Callers must only sync BETWEEN the reviewer's turns. Moving the tree under a
// running agent means it reads a file that no longer matches what it just looked
// at.
func EnsureReviewCheckout(projectRoot, headID, ref string) (string, error) {
	dir := paths.GetReviewCheckoutDirFromProjectRoot(projectRoot, headID)
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		if err := git.CheckoutDetached(dir, ref); err != nil {
			return "", errtrace.Wrap(fmt.Errorf("sync review checkout to %s: %w", ref, err))
		}
		return dir, nil
	}

	// No usable tree: clear debris from a crashed run, then create it fresh.
	// PruneWorktrees drops the stale registration a bare rmdir leaves behind in
	// .git/worktrees, which would otherwise make `worktree add` refuse the path.
	_ = os.RemoveAll(dir)
	_ = git.PruneWorktrees(projectRoot)
	if err := os.MkdirAll(filepath.Dir(dir), 0755); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create review checkouts dir: %w", err))
	}
	if err := git.AddDetachedWorktree(projectRoot, dir, ref); err != nil {
		return "", errtrace.Wrap(fmt.Errorf("create review checkout at %s: %w", ref, err))
	}
	return dir, nil
}

// RemoveReviewCheckout deletes a head's review checkout. Best-effort: it runs on
// kill/merge, where a leftover directory is untidy but harmless - the next
// EnsureReviewCheckout reclaims it either way.
func RemoveReviewCheckout(projectRoot, headID string) {
	dir := paths.GetReviewCheckoutDirFromProjectRoot(projectRoot, headID)
	if _, err := os.Stat(dir); err != nil {
		return
	}
	if err := git.RemoveWorktree(projectRoot, dir); err != nil {
		_ = os.RemoveAll(dir)
		_ = git.PruneWorktrees(projectRoot)
	}
}

// RemoveReviewSessionDir deletes the reviewer's Claude transcript directory on
// purge. removeClaudeSessionDir does not cover it: that recomputes the slug from
// the HEAD's worktree path, and the reviewer's conversation is keyed by its own
// checkout path instead. Codex keeps its session history in a shared store that
// cannot safely be removed by checkout path, so its purge is a no-op here.
//
// Purge-only, mirroring the head's own transcript: a kill archives the head and
// keeps its conversation recoverable, so the reviewer's should survive too.
func RemoveReviewSessionDir(projectRoot, headID string, agentType sandbox.AgentType) {
	if agentType != sandbox.AgentTypeClaude {
		return
	}
	u, err := user.Current()
	if err != nil || u.HomeDir == "" {
		return
	}
	slug := paths.ClaudeProjectsSlug(paths.GetReviewCheckoutDirFromProjectRoot(projectRoot, headID))
	if slug == "" {
		return
	}
	if err := os.RemoveAll(filepath.Join(u.HomeDir, ".claude", "projects", slug)); err != nil {
		log.Printf("warn: heads: purge remove review session dir for %s: %v", headID, err)
	}
}

// KillReviewSession ends a head's reviewer: the model session, its egress proxy
// and the supervisor bwrap it runs under - the same teardown KillHeadNoLock does
// for a head, keyed by the slot id, because the reviewer gets a supervisor of its
// own (see StartReviewSession) rather than sharing the head's.
//
// What it deliberately does NOT touch is the checkout and the transcript. Killing
// a process is reversible and deleting a conversation is not, so this mirrors the
// head's own kill: the reviewer stops costing anything, and re-opening the Review
// tab starts it again on the same conversation (--continue is keyed by the
// checkout path, which is why the path has to be stable). The transcript goes on
// purge, with the head's - see RemoveReviewSessionDir.
func KillReviewSession(reg *session.Registry, headID string) {
	id := ReviewSessionID(headID)
	_ = reg.Kill(id)
	reg.Remove(id)
	stopEgressProxy(id)
	removeNamespaceHost(id)
}

// StartReviewSession starts, or reattaches to, a head's review agent and returns
// its session ID. It mirrors StartShellSession, differing in the four ways that
// make it a reviewer rather than a shell: provider argv in chat mode, a real
// gate policy with the git tools blocked, read-only git isolation, and its own
// persistent checkout instead of the head's worktree.
//
// Deliberately NOT spawned as a sibling in the head's namespace supervisor the
// way a sandboxed bash tab is: that exists so a shell shares the agent's writable
// COW overlay for the SAME worktree, and the reviewer works in a different tree
// entirely. startAgentSession gives it its own supervisor, and - because
// sb.StdioPipes is set - a session.KindChat stream, which is the only path that
// produces one.
func StartReviewSession(reg *session.Registry, projectRoot string, head Head, rows, cols uint16) (string, error) {
	id := ReviewSessionID(head.ID)
	agentType := reviewAgentType(head)
	if reg.IsLive(id) {
		return id, nil
	}

	// Same race as the shell tabs: two sockets for one review pane can both reach
	// here before either registers, and the loser's Start would fail ErrExists.
	// Holding the per-id gate and re-checking makes the loser reattach instead.
	startGate := acquireShellStart(id)
	startGate.mu.Lock()
	defer func() {
		startGate.mu.Unlock()
		releaseShellStart(id)
	}()
	if reg.IsLive(id) {
		return id, nil
	}

	ref := ReviewCheckoutRef(head)
	if ref == "" {
		return "", errtrace.Wrap(fmt.Errorf("head %q has no branch to review", head.ID))
	}
	worktreePath, err := EnsureReviewCheckout(projectRoot, head.ID, ref)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	currentUser, err := user.Current()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("get current user: %w", err))
	}
	home := currentUser.HomeDir
	env := agentEnv(home, currentUser.Username, readGitConfigVal(projectRoot, "user.name"), readGitConfigVal(projectRoot, "user.email"))
	env = append(env, sandbox.MiseTrustEnv(projectRoot, worktreePath)...)
	env = append(env, headContextEnv(head.ID, agentType, projectRoot, worktreePath, derefStr(head.Branch), head.BaseBranch)...)

	cfg, _ := config.Load(projectRoot)
	writable, masked, restore, _, net, _ := cfg.ResolveSandboxOptions(string(agentType))

	// Read-only git, with no host-mediated way around it. resolveGitIsolation is
	// deliberately bypassed: it falls back to "off" when an agent type lacks the
	// git tools, so a head is never left unable to commit - exactly the wrong
	// default here, where being unable to commit is the entire point.
	policy := resolveGatePolicy(cfg, string(agentType))
	policy.MCPToolsBlocked = append(append([]string(nil), policy.MCPToolsBlocked...), reviewBlockedTools...)

	seed, err := seedHead(projectRoot, id, agentType, worktreePath, home, reviewSystemPrompt, policy, sandbox.GitIsolationReadonly)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	argv, err := sandbox.AgentArgv(agentType, false, reviewSystemPrompt, "", "", true, "", seed.MCPConfigPath)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	// Its own egress boundary, keyed by the review session id, with approval
	// prompts routed to the head's card (head.ID) so they surface where the user
	// is actually looking.
	egressEnv, egressWrap := startEgressKeyed(projectRoot, id, head.ID, agentType, &net)

	sb := sandbox.Options{
		AgentType:     agentType,
		WorktreePath:  worktreePath,
		GitCommonDir:  commonDirForSandbox(projectRoot, sandbox.GitIsolationReadonly),
		GitIsolation:  sandbox.GitIsolationReadonly,
		Home:          home,
		TmpDir:        ensureHeadTmpDir(projectRoot, head.ID),
		WritablePaths: append(writable, seed.WritablePaths...),
		MaskedPaths:   sandbox.ResolveMaskedPaths(projectRoot, worktreePath, masked),
		RestoreRO:     restore,
		Network:       net,
		Binds:         seed.Binds,
		Env:           append(append(env, seed.Env...), egressEnv...),
		Argv:          argv,
		EgressWrap:    egressWrap,
		HardenGUI:     true,
		Seccomp:       true,
		StdioPipes:    true,
	}

	if _, err := startAgentSession(reg, projectRoot, id, agentType, worktreePath, rows, cols, sb); err != nil {
		return "", errtrace.Wrap(err)
	}
	if agentType == sandbox.AgentTypeCodex {
		conversationID := readCodexSlotConversationID(projectRoot, id)
		if err := startCodexChatController(reg, nil, projectRoot, id, worktreePath, "", conversationID, ""); err != nil {
			StopSessionAndWait(reg, id, 5*time.Second)
			return "", errtrace.Wrap(err)
		}
	}
	return id, nil
}

package http

import (
	"context"
	"fmt"
	"log"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/agentq"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/claudestream"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
	"github.com/trolleyman/hydra/internal/paths"
)

const (
	agentReqPollInterval = 250 * time.Millisecond
	agentReqKeep         = 12
	agentMessageMaxBytes = 4 * 1024
	agentChainMax        = 6
	agentPairMax         = 6
	agentPairWindow      = 10 * time.Minute
	agentQueueMax        = 4
)

type collaborationChain struct {
	participants map[string]bool
	messages     map[string]string // message id -> sender
	count        int
	updated      time.Time
}

type collaborationPair struct {
	times []time.Time
}

type collaborationState struct {
	mu     sync.Mutex
	chains map[string]*collaborationChain
	pairs  map[string]*collaborationPair
}

var collaborations collaborationState

// RunAgentRequestWatcher answers the project-scoped discovery and messaging
// requests written by sandboxed heads.
func (s *Server) RunAgentRequestWatcher(ctx context.Context, roots func() []string) {
	t := time.NewTicker(agentReqPollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, root := range roots() {
				s.drainAgentRequests(ctx, root)
			}
		}
	}
}

func (s *Server) drainAgentRequests(ctx context.Context, projectRoot string) {
	entries, err := os.ReadDir(paths.GetAgentReqRootDir(projectRoot))
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		sourceID := e.Name()
		dir := paths.GetAgentReqDir(projectRoot, sourceID)
		reqs, err := agentq.ListRequests(dir)
		if err != nil {
			continue
		}
		for _, req := range reqs {
			res := s.handleAgentRequest(ctx, projectRoot, sourceID, req)
			if err := agentq.WriteResult(dir, req.ReqID, res); err != nil {
				log.Printf("warn: agent request: write result for %s: %v", sourceID, err)
			}
		}
		agentq.Sweep(dir, agentReqKeep)
	}
}

func (s *Server) handleAgentRequest(ctx context.Context, projectRoot, sourceID string, req agentq.Request) agentq.Result {
	source, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, sourceID)
	if err != nil || !liveCollaborationHead(source) {
		return agentq.Result{Message: "The calling agent is not a live head in this project."}
	}
	switch req.Op {
	case agentq.OpList:
		return s.listCollaborationAgents(ctx, projectRoot, sourceID)
	case agentq.OpGet:
		return s.getCollaborationAgent(ctx, projectRoot, sourceID, strings.TrimSpace(req.Target))
	case agentq.OpMessage:
		return s.sendCollaborationMessage(ctx, projectRoot, *source, req)
	default:
		return agentq.Result{Message: "Unknown agent collaboration operation."}
	}
}

func liveCollaborationHead(h *heads.Head) bool {
	return h != nil && !h.Archived && h.SessionPID != 0 && h.SessionStatus == "running"
}

func (s *Server) liveCollaborationHeads(ctx context.Context, projectRoot string) ([]heads.Head, error) {
	all, err := heads.ListHeads(ctx, s.Sessions, s.DB, projectRoot)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	out := all[:0]
	for _, h := range all {
		if liveCollaborationHead(&h) {
			out = append(out, h)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (s *Server) listCollaborationAgents(ctx context.Context, projectRoot, sourceID string) agentq.Result {
	hs, err := s.liveCollaborationHeads(ctx, projectRoot)
	if err != nil {
		return agentq.Result{Message: "Could not list agents: " + err.Error()}
	}
	if len(hs) == 0 {
		return agentq.Result{OK: true, Message: "No live agents in this project."}
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Live agents in this project (%d):\n", len(hs))
	for _, h := range hs {
		title := strings.TrimSpace(h.Title)
		if title == "" {
			title = h.ID
		}
		status, activity := collaborationStatus(h)
		branch := "none"
		if h.Branch != nil {
			branch = *h.Branch
		}
		self := ""
		if h.ID == sourceID {
			self = ", caller=yes"
		}
		fmt.Fprintf(&b, "- id=%s, title=%q, type=%s, status=%s, activity=%q, branch=%s, base=%s, created=%s%s\n",
			h.ID, title, h.AgentType, status, activity, branch, h.BaseBranch, formatCreated(h.CreatedAt), self)
	}
	return agentq.Result{OK: true, Message: strings.TrimRight(b.String(), "\n")}
}

func (s *Server) getCollaborationAgent(ctx context.Context, projectRoot, sourceID, target string) agentq.Result {
	if target == "" {
		return agentq.Result{Message: "get_agent needs an id from list_agents."}
	}
	h, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, target)
	if err != nil || !liveCollaborationHead(h) {
		return agentq.Result{Message: "Agent " + target + " is not live in this project."}
	}
	title := strings.TrimSpace(h.Title)
	if title == "" {
		title = h.ID
	}
	status, activity := collaborationStatus(*h)
	branch := "none"
	if h.Branch != nil {
		branch = *h.Branch
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Agent %s (%q)\n", h.ID, title)
	fmt.Fprintf(&b, "- caller: %t\n- type: %s\n- session: %s\n- status: %s\n- activity: %s\n- branch: %s\n- base: %s\n- created: %s\n",
		h.ID == sourceID, h.AgentType, h.SessionStatus, status, emptyAsNone(activity), branch, h.BaseBranch, formatCreated(h.CreatedAt))
	if h.AgentStatus != nil && h.AgentStatus.LastMessage != nil {
		fmt.Fprintf(&b, "- latest message: %s\n", truncateCollaborationText(*h.AgentStatus.LastMessage, 500))
	}
	tests := s.testSummaryFor(projectRoot, *h)
	testStatus := api.TestStatusNone
	if tests != nil {
		testStatus = tests.Status
	}
	fmt.Fprintf(&b, "- tests: %s\n- review comments: %d open, %d unread\n- merge when green: %t\n- publish when green: %t",
		testStatus, openCommentCount(projectRoot, h.ID), unreadCommentCount(projectRoot, h.ID), h.MergeWhenGreen, h.AutoPush)
	return agentq.Result{OK: true, Message: b.String()}
}

func collaborationStatus(h heads.Head) (string, string) {
	if h.AgentStatus == nil {
		return h.SessionStatus, ""
	}
	activity := ""
	if h.AgentStatus.Activity != nil {
		activity = *h.AgentStatus.Activity
	}
	return string(h.AgentStatus.Status), activity
}

func formatCreated(ts int64) string {
	if ts == 0 {
		return "unknown"
	}
	return time.Unix(ts, 0).UTC().Format(time.RFC3339)
}

func emptyAsNone(s string) string {
	if strings.TrimSpace(s) == "" {
		return "none"
	}
	return s
}

func truncateCollaborationText(s string, max int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return string(r[:max-3]) + "..."
}

func (s *Server) sendCollaborationMessage(ctx context.Context, projectRoot string, source heads.Head, req agentq.Request) agentq.Result {
	cfg, err := config.Load(projectRoot)
	if err != nil || !cfg.ResolvePolicy(string(source.AgentType)).IsAgentMessagingEnabled() {
		return agentq.Result{Message: "Agent messaging is disabled by policy for the calling agent."}
	}
	targetID := strings.TrimSpace(req.Target)
	body := strings.TrimSpace(req.Body)
	if targetID == source.ID {
		return agentq.Result{Message: "An agent cannot message itself."}
	}
	if body == "" || len(body) > agentMessageMaxBytes || !utf8.ValidString(body) {
		return agentq.Result{Message: fmt.Sprintf("Message body must be valid UTF-8 and between 1 and %d bytes.", agentMessageMaxBytes)}
	}
	target, err := heads.GetHeadByID(ctx, s.Sessions, s.DB, projectRoot, targetID)
	if err != nil || !liveCollaborationHead(target) || !target.ChatMode || s.ChatQueues == nil {
		return agentq.Result{Message: "Target agent is not a live chat head in this project."}
	}
	queuedAgentMessages := 0
	for _, m := range s.ChatQueues.List(projectRoot, target.ID) {
		if m.Origin == api.MessageOriginAgent {
			queuedAgentMessages++
		}
	}
	if queuedAgentMessages >= agentQueueMax {
		return agentq.Result{Message: "Target already has too many queued agent messages; wait for it to catch up."}
	}

	correlationID, messageID, chainCount, limitErr := reserveCollaborationMessage(projectRoot, source.ID, target.ID, req.CorrelationID, req.InReplyTo)
	if limitErr != "" {
		return agentq.Result{Message: limitErr}
	}
	sourceTitle := strings.TrimSpace(source.Title)
	if sourceTitle == "" {
		sourceTitle = source.ID
	}
	prefix := fmt.Sprintf("[Message from Hydra agent %s (%s); correlation_id=%s; message_id=%s; chain=%d/%d]\n\n",
		source.ID, sourceTitle, correlationID, messageID, chainCount, agentChainMax)
	queued := target.AgentStatus != nil && (target.AgentStatus.Status == api.Running || target.AgentStatus.Status == api.Starting || target.AgentStatus.Status == api.Building)
	if !s.ChatQueues.Submit(projectRoot, target.ID, heads.QueuedMessage{
		ID: messageID, Content: claudestream.TextUserContent(prefix + body), Origin: api.MessageOriginAgent, SourceAgentID: source.ID,
	}, queued) {
		return agentq.Result{Message: "The target stopped before Hydra could deliver the message."}
	}
	state := "delivered"
	if queued {
		state = "queued"
	}
	return agentq.Result{OK: true, Message: fmt.Sprintf("%s to %s; correlation_id=%s; message_id=%s; chain=%d/%d. No reply is implied.", state, target.ID, correlationID, messageID, chainCount, agentChainMax)}
}

func reserveCollaborationMessage(projectRoot, source, target, correlationID, inReplyTo string) (string, string, int, string) {
	if (correlationID != "" && !validCollaborationID(correlationID)) || (inReplyTo != "" && !validCollaborationID(inReplyTo)) {
		return "", "", 0, "correlation_id and in_reply_to may contain only letters, digits, dot, underscore, and hyphen (maximum 128 characters)."
	}
	now := time.Now()
	pairIDs := []string{source, target}
	sort.Strings(pairIDs)
	pairKey := projectRoot + "\x00" + strings.Join(pairIDs, "\x00")
	collaborations.mu.Lock()
	defer collaborations.mu.Unlock()
	if collaborations.chains == nil {
		collaborations.chains = map[string]*collaborationChain{}
		collaborations.pairs = map[string]*collaborationPair{}
	}
	pair := collaborations.pairs[pairKey]
	if pair == nil {
		pair = &collaborationPair{}
		collaborations.pairs[pairKey] = pair
	}
	cutoff := now.Add(-agentPairWindow)
	kept := pair.times[:0]
	for _, at := range pair.times {
		if at.After(cutoff) {
			kept = append(kept, at)
		}
	}
	pair.times = kept
	if len(pair.times) >= agentPairMax {
		return "", "", 0, "Agent message rate limit reached for this pair; wait for a human to coordinate the next step."
	}

	chainKey := projectRoot + "\x00" + correlationID
	chain := collaborations.chains[chainKey]
	if correlationID == "" {
		correlationID = fmt.Sprintf("agent-chain-%d", agentInputSeq.Add(1))
		chainKey = projectRoot + "\x00" + correlationID
		chain = &collaborationChain{participants: map[string]bool{source: true, target: true}, messages: map[string]string{}}
		collaborations.chains[chainKey] = chain
	} else if chain == nil || !chain.participants[source] || !chain.participants[target] {
		return "", "", 0, "Unknown correlation_id for this agent pair; omit it to start a new bounded chain."
	}
	if inReplyTo != "" {
		if previousSender, ok := chain.messages[inReplyTo]; !ok || previousSender != target {
			return "", "", 0, "in_reply_to must name a message from the target in this correlation chain."
		}
	}
	if chain.count >= agentChainMax {
		return "", "", 0, "This agent conversation reached its message limit. Ask the user to coordinate any further work."
	}
	messageID := fmt.Sprintf("agent-message-%d", agentInputSeq.Add(1))
	chain.count++
	chain.messages[messageID] = source
	chain.updated = now
	pair.times = append(pair.times, now)
	return correlationID, messageID, chain.count, ""
}

func validCollaborationID(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

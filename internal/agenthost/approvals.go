package agenthost

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/agenthostapi"
	"github.com/trolleyman/hydra/internal/egress"
	"github.com/trolleyman/hydra/internal/gate"
)

const approvalTimeout = 5 * time.Minute

type approvalAnswer struct {
	decision agenthostapi.ApprovalResponseCommandDecision
	scope    agenthostapi.ApprovalResponseCommandScope
}

type approvalBroker struct {
	writer            *writer
	seq               atomic.Uint64
	mu                sync.Mutex
	pending           map[string]chan approvalAnswer
	gatePending       map[string]gate.Request
	gateApprovalDir   string
	gatePolicyPath    string
	chatNetworkGrants map[string]bool
	chatGitGrants     map[string]bool
}

func newApprovalBroker(writer *writer) *approvalBroker {
	return &approvalBroker{writer: writer, pending: map[string]chan approvalAnswer{}, gatePending: map[string]gate.Request{}, chatNetworkGrants: map[string]bool{}, chatGitGrants: map[string]bool{}}
}

func (b *approvalBroker) requestGit(operation, branch string, cancel <-chan struct{}) bool {
	b.mu.Lock()
	if b.chatGitGrants[operation] {
		b.mu.Unlock()
		return true
	}
	id := fmt.Sprintf("git-%d", b.seq.Add(1))
	answer := make(chan approvalAnswer, 1)
	b.pending[id] = answer
	b.mu.Unlock()
	if err := b.writer.write(agenthostapi.ApprovalRequestFrame{Type: agenthostapi.ApprovalRequest, RequestId: id, Kind: agenthostapi.Git, Target: operation, CanonicalTarget: operation, Summary: fmt.Sprintf("Allow git_%s on %s?", operation, branch), Reason: "The active profile requires approval for this Git operation."}); err != nil {
		b.remove(id)
		return false
	}
	timer := time.NewTimer(approvalTimeout)
	defer timer.Stop()
	select {
	case result := <-answer:
		allowed := result.decision == agenthostapi.Allow
		if allowed && result.scope != agenthostapi.Once {
			b.mu.Lock()
			b.chatGitGrants[operation] = true
			b.mu.Unlock()
		}
		return allowed
	case <-cancel:
		b.remove(id)
		return false
	case <-timer.C:
		b.remove(id)
		return false
	}
}

func (b *approvalBroker) requestNetwork(host string, cancel <-chan struct{}) egress.Approval {
	b.mu.Lock()
	if b.chatNetworkGrants[host] {
		b.mu.Unlock()
		return egress.Approval{Allow: true, Remember: true}
	}
	id := fmt.Sprintf("network-%d", b.seq.Add(1))
	answer := make(chan approvalAnswer, 1)
	b.pending[id] = answer
	b.mu.Unlock()

	if err := b.writer.write(agenthostapi.ApprovalRequestFrame{
		Type: agenthostapi.ApprovalRequest, RequestId: id, Kind: agenthostapi.Network,
		Target: host, CanonicalTarget: host, Summary: "Allow outbound connection to " + host + "?",
		Reason: "The destination is not in this profile's network allow-list.",
	}); err != nil {
		b.remove(id)
		return egress.Approval{}
	}

	timer := time.NewTimer(approvalTimeout)
	defer timer.Stop()
	select {
	case result := <-answer:
		allowed := result.decision == agenthostapi.Allow
		remember := allowed && result.scope != agenthostapi.Once
		if remember {
			b.mu.Lock()
			b.chatNetworkGrants[host] = true
			b.mu.Unlock()
		}
		return egress.Approval{Allow: allowed, Remember: remember}
	case <-cancel:
		b.remove(id)
		return egress.Approval{}
	case <-timer.C:
		b.remove(id)
		return egress.Approval{}
	}
}

func (b *approvalBroker) resolve(command agenthostapi.ApprovalResponseCommand) error {
	b.mu.Lock()
	answer := b.pending[command.RequestId]
	if answer != nil {
		delete(b.pending, command.RequestId)
	}
	request, gatePending := b.gatePending[command.RequestId]
	if gatePending {
		delete(b.gatePending, command.RequestId)
	}
	approvalDir, policyPath := b.gateApprovalDir, b.gatePolicyPath
	b.mu.Unlock()
	if answer != nil {
		answer <- approvalAnswer{decision: command.Decision, scope: command.Scope}
		return nil
	}
	if gatePending {
		decision := gate.Deny
		remember := command.Decision == agenthostapi.Allow && command.Scope != agenthostapi.Once
		if command.Decision == agenthostapi.Allow {
			decision = gate.Allow
		}
		if remember {
			if err := rememberGateGrant(policyPath, request); err != nil {
				return errtrace.Wrap(err)
			}
		}
		return errtrace.Wrap(gate.WriteDecision(approvalDir, command.RequestId, gate.DecisionFile{Decision: decision, Remember: remember}))
	}
	return errtrace.Wrap(fmt.Errorf("unknown or expired approval %q", command.RequestId))
}

func (b *approvalBroker) remove(id string) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

func (b *approvalBroker) watchGate(approvalDir, policyPath string) func() {
	stop := make(chan struct{})
	b.mu.Lock()
	b.gateApprovalDir, b.gatePolicyPath = approvalDir, policyPath
	b.mu.Unlock()
	go func() {
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				requests, err := gate.ListRequests(approvalDir)
				if err != nil {
					continue
				}
				for _, request := range requests {
					b.publishGateRequest(request)
				}
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(func() { close(stop) }) }
}

func (b *approvalBroker) publishGateRequest(request gate.Request) {
	b.mu.Lock()
	if _, exists := b.gatePending[request.ReqID]; exists {
		b.mu.Unlock()
		return
	}
	b.gatePending[request.ReqID] = request
	b.mu.Unlock()
	_ = b.writer.write(agenthostapi.ApprovalRequestFrame{
		Type: agenthostapi.ApprovalRequest, RequestId: request.ReqID,
		Kind: gateRequestKind(request.Kind), Target: request.Target,
		CanonicalTarget: request.Kind, Summary: request.Summary, Reason: request.Reason,
	})
}

func gateRequestKind(kind string) agenthostapi.ApprovalRequestFrameKind {
	switch kind {
	case "webfetch":
		return agenthostapi.Network
	case "mcp":
		return agenthostapi.Mcp
	case "mcp_tool":
		return agenthostapi.McpTool
	default:
		return agenthostapi.CoreTool
	}
}

func rememberGateGrant(policyPath string, request gate.Request) error {
	policy, err := gate.LoadPolicy(policyPath)
	if err != nil {
		return errtrace.Wrap(err)
	}
	switch request.Kind {
	case "read", "search", "edit", "bash", "fetch":
		if policy.ToolDecisions == nil {
			policy.ToolDecisions = map[string]gate.Decision{}
		}
		policy.ToolDecisions[request.Kind] = gate.Allow
	case "mcp":
		policy.MCPAllowed = appendUnique(policy.MCPAllowed, request.Target)
	case "mcp_tool":
		policy.MCPToolsAllowed = appendUnique(policy.MCPToolsAllowed, request.Target)
	case "webfetch":
		policy.WebFetchAllowHosts = appendUnique(policy.WebFetchAllowHosts, request.Target)
	}
	return errtrace.Wrap(policy.Save(policyPath))
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

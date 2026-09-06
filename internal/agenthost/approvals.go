package agenthost

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"braces.dev/errtrace"
	"github.com/trolleyman/hydra/internal/agenthostapi"
	"github.com/trolleyman/hydra/internal/egress"
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
	chatNetworkGrants map[string]bool
}

func newApprovalBroker(writer *writer) *approvalBroker {
	return &approvalBroker{writer: writer, pending: map[string]chan approvalAnswer{}, chatNetworkGrants: map[string]bool{}}
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
	b.mu.Unlock()
	if answer == nil {
		return errtrace.Wrap(fmt.Errorf("unknown or expired approval %q", command.RequestId))
	}
	answer <- approvalAnswer{decision: command.Decision, scope: command.Scope}
	return nil
}

func (b *approvalBroker) remove(id string) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

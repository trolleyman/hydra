package agenthost

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/trolleyman/hydra/internal/agenthostapi"
)

type frameSink struct{ frames chan []byte }

func (s frameSink) Write(data []byte) (int, error) {
	s.frames <- append([]byte(nil), data...)
	return len(data), nil
}

func TestApprovalBrokerNetworkScopes(t *testing.T) {
	sink := frameSink{frames: make(chan []byte, 4)}
	broker := newApprovalBroker(&writer{enc: json.NewEncoder(sink)})
	cancel := make(chan struct{})

	result := make(chan bool, 1)
	go func() { result <- broker.requestNetwork("once.example", cancel).Remember }()
	request := waitApprovalRequest(t, sink.frames)
	if err := broker.resolve(agenthostapi.ApprovalResponseCommand{RequestId: request, Decision: agenthostapi.Allow, Scope: agenthostapi.Once}); err != nil {
		t.Fatal(err)
	}
	if <-result {
		t.Fatal("once approval was remembered")
	}

	granted := make(chan bool, 1)
	go func() { granted <- broker.requestNetwork("chat.example", cancel).Remember }()
	request = waitApprovalRequest(t, sink.frames)
	if err := broker.resolve(agenthostapi.ApprovalResponseCommand{RequestId: request, Decision: agenthostapi.Allow, Scope: agenthostapi.Chat}); err != nil {
		t.Fatal(err)
	}
	if !<-granted {
		t.Fatal("chat approval was not remembered")
	}
	if approval := broker.requestNetwork("chat.example", cancel); !approval.Allow || !approval.Remember {
		t.Fatalf("remembered approval = %+v", approval)
	}
	select {
	case <-sink.frames:
		t.Fatal("remembered chat grant emitted another prompt")
	case <-time.After(10 * time.Millisecond):
	}
}

func waitApprovalRequest(t *testing.T, frames <-chan []byte) string {
	t.Helper()
	select {
	case data := <-frames:
		var frame map[string]any
		if json.Unmarshal(data, &frame) != nil {
			t.Fatalf("invalid approval frame: %s", data)
		}
		if id, ok := frame["request_id"].(string); ok {
			return id
		}
		t.Fatalf("approval frame has no request id: %s", data)
	case <-time.After(time.Second):
		t.Fatal("approval request was not emitted")
	}
	return ""
}

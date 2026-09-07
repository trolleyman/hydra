package agenthost

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/agenthostapi"
	"github.com/trolleyman/hydra/internal/chat"
)

type fakeProvider struct{}

func (fakeProvider) Send(json.RawMessage) error    { return nil }
func (fakeProvider) Interrupt() error              { return nil }
func (fakeProvider) Respond(json.RawMessage) error { return nil }
func (fakeProvider) SetModel(string) error         { return nil }
func (fakeProvider) Close()                        {}

func launchFake(context.Context, agenthostapi.InitializeCommand, *chat.Manager, *writer, *approvalBroker, ioLogger) (providerRuntime, error) {
	return fakeProvider{}, nil
}

func TestRunHandshakeReplayAndPersistedUserMessage(t *testing.T) {
	workspace := t.TempDir()
	conversation := filepath.Join(t.TempDir(), "chat")
	initialize := map[string]any{
		"type": "initialize", "protocol_version": ProtocolVersion,
		"workspace": workspace, "conversation_dir": conversation,
		"policy": map[string]any{
			"profile": "implement", "provider": "codex", "workspace": workspace, "user_home": workspace,
			"filesystem": map[string]any{"readable": []string{workspace}, "writable": []string{workspace}, "copy_on_write": []string{}, "masked": []string{}},
			"network":    map[string]any{"mode": "off", "allowed_hosts": []string{}, "blocked_hosts": []string{}},
			"tools":      map[string]any{},
			"git":        map[string]any{},
		},
	}
	message := map[string]any{
		"type": "user_message", "request_id": "request-1", "id": "message-1",
		"content": []map[string]any{{"type": "text", "text": "hello"}},
	}
	input := encodeLines(t, initialize, message, map[string]any{"type": "shutdown"})
	var output, logs bytes.Buffer
	if err := run(context.Background(), strings.NewReader(input), &output, &logs, "test-version", launchFake); err != nil {
		t.Fatal(err)
	}

	frames := decodeLines(t, output.String())
	wantTypes := []string{"hello", "state_snapshot", "chat_history", "replay_done", "ready", "operation_result"}
	for _, want := range wantTypes {
		if !hasFrameType(frames, want) {
			t.Fatalf("missing %s frame: %s", want, output.String())
		}
	}
	if frames[0]["protocol_version"] != float64(ProtocolVersion) || frames[0]["host_version"] != "test-version" {
		t.Fatalf("hello = %+v", frames[0])
	}

	store, err := chat.OpenDirectory(conversation)
	if err != nil {
		t.Fatal(err)
	}
	events := store.Events()
	if len(events) != 1 || events[0].Type != "user_message" {
		t.Fatalf("persisted events = %+v", events)
	}
}

func hasFrameType(frames []map[string]any, want string) bool {
	for _, frame := range frames {
		if frame["type"] == want {
			return true
		}
	}
	return false
}

func TestRunRejectsCommandBeforeInitialize(t *testing.T) {
	input := encodeLines(t, map[string]any{"type": "interrupt", "request_id": "early"})
	var output bytes.Buffer
	err := Run(context.Background(), strings.NewReader(input), &output, &bytes.Buffer{}, "test")
	if err == nil {
		t.Fatal("Run accepted a command before initialize")
	}
	frames := decodeLines(t, output.String())
	if len(frames) != 2 || frames[1]["type"] != "host_error" || frames[1]["code"] != "not_initialized" || frames[1]["fatal"] != true {
		t.Fatalf("frames = %+v", frames)
	}
}

func TestRunRebuildsProviderForPolicyUpdate(t *testing.T) {
	workspace := t.TempDir()
	conversation := filepath.Join(t.TempDir(), "chat")
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	home, err = filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	policy := map[string]any{
		"profile": "implement", "provider": "codex", "workspace": workspace, "user_home": home,
		"filesystem": map[string]any{"readable": []string{workspace}, "writable": []string{workspace}, "copy_on_write": []string{}, "masked": []string{}},
		"network":    map[string]any{"mode": "off", "allowed_hosts": []string{}, "blocked_hosts": []string{}},
		"tools":      map[string]any{}, "git": map[string]any{"isolation": "readonly"},
	}
	updated := mapsClone(policy)
	updated["profile"] = "review"
	input := encodeLines(t,
		map[string]any{"type": "initialize", "protocol_version": ProtocolVersion, "workspace": workspace, "conversation_dir": conversation, "policy": policy},
		map[string]any{"type": "update_policy", "request_id": "update", "policy": updated, "provider_executable": "codex", "behavior": "interrupt"},
		map[string]any{"type": "shutdown"},
	)
	launches := 0
	launcher := func(context.Context, agenthostapi.InitializeCommand, *chat.Manager, *writer, *approvalBroker, ioLogger) (providerRuntime, error) {
		launches++
		return fakeProvider{}, nil
	}
	var output bytes.Buffer
	if err := run(context.Background(), strings.NewReader(input), &output, &bytes.Buffer{}, "test", launcher); err != nil {
		t.Fatal(err)
	}
	if launches != 2 {
		t.Fatalf("provider launch count = %d, want 2", launches)
	}
	frames := decodeLines(t, output.String())
	ready := 0
	for _, frame := range frames {
		if frame["type"] == "ready" {
			ready++
		}
	}
	if ready != 2 || !hasFrameType(frames, "operation_result") {
		t.Fatalf("policy update frames = %+v", frames)
	}
	store, err := chat.OpenDirectory(conversation)
	if err != nil {
		t.Fatal(err)
	}
	events := store.Events()
	if len(events) != 1 || events[0].Type != "notice" {
		t.Fatalf("profile transition events = %+v", events)
	}
}

func mapsClone(source map[string]any) map[string]any {
	data, _ := json.Marshal(source)
	var clone map[string]any
	_ = json.Unmarshal(data, &clone)
	return clone
}

func encodeLines(t *testing.T, values ...any) string {
	t.Helper()
	var out strings.Builder
	enc := json.NewEncoder(&out)
	for _, value := range values {
		if err := enc.Encode(value); err != nil {
			t.Fatal(err)
		}
	}
	return out.String()
}

func decodeLines(t *testing.T, input string) []map[string]any {
	t.Helper()
	var frames []map[string]any
	scanner := strings.Split(strings.TrimSpace(input), "\n")
	for _, line := range scanner {
		var frame map[string]any
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatalf("decode %q: %v", line, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

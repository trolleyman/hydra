package agenthost

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/chat"
)

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
	if err := Run(context.Background(), strings.NewReader(input), &output, &logs, "test-version"); err != nil {
		t.Fatal(err)
	}

	frames := decodeLines(t, output.String())
	wantTypes := []string{"hello", "state_snapshot", "chat_history", "replay_done", "ready", "chat_event", "operation_result"}
	if len(frames) != len(wantTypes) {
		t.Fatalf("frame count = %d, want %d: %s", len(frames), len(wantTypes), output.String())
	}
	for i, want := range wantTypes {
		if frames[i]["type"] != want {
			t.Fatalf("frame %d type = %v, want %s", i, frames[i]["type"], want)
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

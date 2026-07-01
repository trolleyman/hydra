package mcpclient

import (
	"bufio"
	"encoding/json"
	"io"
	"testing"
)

// mockServer speaks just enough MCP to answer the client's handshake, replying to
// tools/list with the given tools payload.
func mockServer(in io.Reader, out io.Writer, tools []map[string]any) {
	br := bufio.NewReader(in)
	enc := json.NewEncoder(out)
	for {
		line, err := br.ReadBytes('\n')
		if err != nil {
			return
		}
		var m map[string]any
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		switch m["method"] {
		case "initialize":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": m["id"], "result": map[string]any{
				"protocolVersion": protocolVersion,
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]any{"name": "mock"},
			}})
		case "tools/list":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": m["id"], "result": map[string]any{"tools": tools}})
		}
		// notifications/initialized has no id → no response.
	}
}

func TestHandshakeReadsAnnotations(t *testing.T) {
	clientToServer := newPipe()
	serverToClient := newPipe()
	tools := []map[string]any{
		{"name": "search_issues", "annotations": map[string]any{"readOnlyHint": true}},
		{"name": "create_issue", "annotations": map[string]any{"readOnlyHint": false}},
		{"name": "mystery"}, // no annotations → ReadOnly nil
	}
	go mockServer(clientToServer.r, serverToClient.w, tools)

	got, err := Handshake(clientToServer.w, serverToClient.r)
	if err != nil {
		t.Fatalf("Handshake: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d tools, want 3: %+v", len(got), got)
	}
	byName := map[string]*bool{}
	for _, tl := range got {
		byName[tl.Name] = tl.ReadOnly
	}
	if byName["search_issues"] == nil || *byName["search_issues"] != true {
		t.Errorf("search_issues readOnly = %v, want true", byName["search_issues"])
	}
	if byName["create_issue"] == nil || *byName["create_issue"] != false {
		t.Errorf("create_issue readOnly = %v, want false", byName["create_issue"])
	}
	if _, ok := byName["mystery"]; !ok || byName["mystery"] != nil {
		t.Errorf("mystery readOnly = %v, want nil", byName["mystery"])
	}
}

// pipe is a one-directional in-memory byte channel (io.Pipe wrapper).
type pipe struct {
	r *io.PipeReader
	w *io.PipeWriter
}

func newPipe() pipe {
	r, w := io.Pipe()
	return pipe{r: r, w: w}
}

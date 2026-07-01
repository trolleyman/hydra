// Package mcpclient is a minimal Model Context Protocol (MCP) client used to
// introspect a configured MCP server: it spawns the server, performs the stdio
// handshake (initialize → initialized → tools/list) and returns each tool's name
// and read-only hint (the server-declared `annotations.readOnlyHint`). Hydra uses
// this to classify MCP tools as read vs write from the authoritative annotation,
// falling back to a name heuristic only when a server doesn't declare one.
//
// It is deliberately small and defensive: an unresponsive or misbehaving server
// yields an error (the caller falls back), never a hang — every read is bounded by
// the caller's context.
package mcpclient

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"os/exec"
	"time"

	"braces.dev/errtrace"
)

const protocolVersion = "2024-11-05"

// ToolInfo is one tool from tools/list: its name and read-only hint. ReadOnly is
// nil when the server declares no readOnlyHint annotation.
type ToolInfo struct {
	Name     string
	ReadOnly *bool
}

// ListTools spawns `command args...` (with env, if non-nil) and returns its tools
// via the MCP stdio handshake. The whole exchange is bounded by ctx; the process
// is killed when ctx ends or the handshake completes.
func ListTools(ctx context.Context, command string, args, env []string) ([]ToolInfo, error) {
	cmd := exec.CommandContext(ctx, command, args...) //errtrace:skip
	if env != nil {
		cmd.Env = env
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	if err := cmd.Start(); err != nil {
		return nil, errtrace.Wrap(err)
	}
	// Ensure the process is reaped even on early return.
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	tools, err := Handshake(stdin, stdout)
	return tools, errtrace.Wrap(err)
}

// Handshake performs the MCP tools-discovery exchange over an already-connected
// server: it writes to w (the server's stdin) and reads newline-delimited JSON-RPC
// responses from r (the server's stdout). Exposed for testing with in-memory pipes.
func Handshake(w io.Writer, r io.Reader) ([]ToolInfo, error) {
	br := bufio.NewReader(r)
	enc := json.NewEncoder(w)

	// 1. initialize
	if err := enc.Encode(rpc(1, "initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "hydra", "version": "1"},
	})); err != nil {
		return nil, errtrace.Wrap(err)
	}
	if _, err := readResult(br, 1); err != nil {
		return nil, errtrace.Wrap(err)
	}

	// 2. initialized notification (no response)
	if err := enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}); err != nil {
		return nil, errtrace.Wrap(err)
	}

	// 3. tools/list
	if err := enc.Encode(rpc(2, "tools/list", map[string]any{})); err != nil {
		return nil, errtrace.Wrap(err)
	}
	result, err := readResult(br, 2)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return parseTools(result), nil
}

// rpc builds a JSON-RPC request object.
func rpc(id int, method string, params any) map[string]any {
	return map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}
}

// readResult reads newline-delimited JSON-RPC messages until it finds a response
// with the given id, returning its "result" object. Notifications and other-id
// messages are skipped (a well-behaved server interleaves none, but be lenient).
func readResult(br *bufio.Reader, id float64) (map[string]any, error) {
	for {
		line, err := readLine(br)
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		if len(line) == 0 {
			continue
		}
		var msg struct {
			ID     *float64        `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  json.RawMessage `json:"error"`
		}
		if json.Unmarshal(line, &msg) != nil || msg.ID == nil || *msg.ID != id {
			continue
		}
		if len(msg.Error) > 0 {
			return nil, errtrace.Wrap(errServerError)
		}
		var result map[string]any
		_ = json.Unmarshal(msg.Result, &result)
		return result, nil
	}
}

// readLine reads a single newline-delimited message, tolerating long lines.
func readLine(br *bufio.Reader) ([]byte, error) {
	var buf []byte
	for {
		chunk, isPrefix, err := br.ReadLine()
		if err != nil {
			return nil, errtrace.Wrap(err)
		}
		buf = append(buf, chunk...)
		if !isPrefix {
			return buf, nil
		}
	}
}

// parseTools extracts name + readOnlyHint from a tools/list result.
func parseTools(result map[string]any) []ToolInfo {
	rawTools, _ := result["tools"].([]any)
	out := make([]ToolInfo, 0, len(rawTools))
	for _, rt := range rawTools {
		t, ok := rt.(map[string]any)
		if !ok {
			continue
		}
		name, _ := t["name"].(string)
		if name == "" {
			continue
		}
		info := ToolInfo{Name: name}
		if ann, ok := t["annotations"].(map[string]any); ok {
			if ro, ok := ann["readOnlyHint"].(bool); ok {
				info.ReadOnly = &ro
			}
		}
		out = append(out, info)
	}
	return out
}

// errServerError is returned when the server replies with a JSON-RPC error.
var errServerError = errStr("mcp server returned an error")

type errStr string

func (e errStr) Error() string { return string(e) }

// DefaultTimeout bounds a single server introspection.
const DefaultTimeout = 8 * time.Second

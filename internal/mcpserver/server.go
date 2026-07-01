// Package mcpserver implements a minimal Model Context Protocol (MCP) server that
// Hydra seeds into the agent's own toolset, so the inner agent can DISCOVER MCP
// servers configured on the host and REQUEST access to one at runtime — gated by
// the same approval flow as the security gate. Granting a server appends it to the
// allow-list; because MCP servers are loaded at launch, the new server becomes
// usable on the agent's next launch/resume.
//
// It speaks the MCP stdio transport: newline-delimited JSON-RPC 2.0, one message
// per line on stdin/stdout. Only the handful of methods a tools-only server needs
// are implemented (initialize, tools/list, tools/call, and the initialized
// notification); anything else gets a JSON-RPC "method not found".
package mcpserver

import (
	"bufio"
	"encoding/json"
	"io"
	"strings"

	"braces.dev/errtrace"
)

// protocolVersion is the MCP revision this server advertises in initialize.
const protocolVersion = "2024-11-05"

// Candidate is a host-configured MCP server the agent may request access to.
type Candidate struct {
	Name   string `json:"name"`
	Source string `json:"source"`
}

// Deps are the host-provided behaviours the tools call into, injected so the
// server logic is testable without a sandbox or real files.
type Deps struct {
	// ListAvailable returns candidate servers not yet on the allow-list.
	ListAvailable func() []Candidate
	// RequestAccess submits an approval request for server `name` and blocks until
	// the user decides (or it times out). It returns whether it was approved and a
	// human-readable message to relay to the agent.
	RequestAccess func(name string) (approved bool, message string)
}

// rpcRequest / rpcResponse are the subset of JSON-RPC 2.0 we parse/emit. A
// request with no ID is a notification (no response is written).
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Run reads JSON-RPC messages from in and writes responses to out until in is
// exhausted (the client closed the pipe). Each line is one message.
func Run(deps Deps, in io.Reader, out io.Writer) error {
	sc := bufio.NewScanner(in)
	// MCP messages can be large (a tools/list with many schemas); raise the line cap.
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	enc := json.NewEncoder(out)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			// Can't recover an ID from an unparseable line; skip it.
			continue
		}
		resp, respond := dispatch(deps, req)
		if !respond {
			continue
		}
		if err := enc.Encode(resp); err != nil {
			return errtrace.Wrap(err)
		}
	}
	return errtrace.Wrap(sc.Err())
}

// dispatch routes one request to its handler, returning the response and whether
// a response should be written (notifications produce none).
func dispatch(deps Deps, req rpcRequest) (rpcResponse, bool) {
	// Notifications (no ID) are acknowledged silently.
	if len(req.ID) == 0 {
		return rpcResponse{}, false
	}
	base := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		base.Result = map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "hydra", "version": "1"},
		}
	case "ping":
		base.Result = map[string]any{}
	case "tools/list":
		base.Result = map[string]any{"tools": toolDefs()}
	case "tools/call":
		base.Result = callTool(deps, req.Params)
	default:
		base.Error = &rpcError{Code: -32601, Message: "method not found: " + req.Method}
	}
	return base, true
}

// toolDefs is the advertised tool catalog (tools/list).
func toolDefs() []map[string]any {
	return []map[string]any{
		{
			"name":        "list_available_mcp_servers",
			"description": "List MCP servers configured on the host that are NOT yet available to you. Use this to discover tools you could request access to.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{}},
			"annotations": map[string]any{"readOnlyHint": true},
		},
		{
			"name":        "request_mcp_server",
			"description": "Request access to a host-configured MCP server by name. This asks the user to approve it; if granted, the server is added to your allow-list and becomes available after your session reloads. Only servers from list_available_mcp_servers can be requested.",
			"inputSchema": map[string]any{
				"type":     "object",
				"required": []string{"name"},
				"properties": map[string]any{
					"name": map[string]any{"type": "string", "description": "The MCP server name to request."},
				},
			},
		},
	}
}

// callTool dispatches a tools/call by name and returns an MCP tool result
// (a content array; isError marks a failure).
func callTool(deps Deps, params json.RawMessage) map[string]any {
	var p struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	}
	_ = json.Unmarshal(params, &p)
	switch p.Name {
	case "list_available_mcp_servers":
		return textResult(listAvailableText(deps), false)
	case "request_mcp_server":
		var args struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(p.Arguments, &args)
		if args.Name == "" {
			return textResult("request_mcp_server requires a non-empty \"name\".", true)
		}
		approved, msg := deps.RequestAccess(args.Name)
		return textResult(msg, !approved)
	default:
		return textResult("unknown tool: "+p.Name, true)
	}
}

// listAvailableText renders the available-server list as human/agent-readable text.
func listAvailableText(deps Deps) string {
	servers := deps.ListAvailable()
	if len(servers) == 0 {
		return "No additional MCP servers are available to request. You already have access to every server the host has configured."
	}
	var b strings.Builder
	b.WriteString("MCP servers you can request access to (use request_mcp_server with the name):\n")
	for _, s := range servers {
		b.WriteString("- ")
		b.WriteString(s.Name)
		b.WriteString(" (")
		b.WriteString(s.Source)
		b.WriteString(")\n")
	}
	return b.String()
}

// textResult wraps text in the MCP tool-result content shape.
func textResult(text string, isError bool) map[string]any {
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
		"isError": isError,
	}
}

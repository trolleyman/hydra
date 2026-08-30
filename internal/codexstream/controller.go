// Package codexstream implements the client side of Codex app-server's
// JSONL-over-stdio protocol. It deliberately models only lifecycle requests;
// notification-to-Hydra event normalization lives in internal/chat.
package codexstream

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"braces.dev/errtrace"
)

type SendFunc func([]byte) error

type Options struct {
	CWD            string
	Model          string
	ConversationID string
	InitialPrompt  string
	Send           SendFunc
	OnConversation func(string)
	OnModel        func(string)
	OnTurnStart    func(string)
	OnActivity     func(string)
	OnMessage      func(string)
	OnNeedsInput   func(string)
	OnStep         func()
	OnTurnEnd      func(string)
	OnHistoryLine  func([]byte)
	OnError        func(error)
}

type Controller struct {
	opts Options
	seq  atomic.Uint64

	mu              sync.Mutex
	threadID        string
	threadReady     bool
	turnID          string
	initialPrompt   string
	pending         []json.RawMessage
	requests        map[string]pendingRequest
	initializeID    uint64
	modelListID     uint64
	threadRequestID uint64
	readRequestID   uint64
	model           string
}

type pendingRequest struct {
	id     json.RawMessage
	method string
	params json.RawMessage
}

func New(opts Options) *Controller {
	return &Controller{opts: opts, threadID: opts.ConversationID, initialPrompt: opts.InitialPrompt, model: opts.Model, requests: map[string]pendingRequest{}}
}

func (c *Controller) nextID() uint64 { return c.seq.Add(1) }

func (c *Controller) send(method string, params any) (uint64, error) {
	id := c.nextID()
	return id, errtrace.Wrap(c.sendMessage(map[string]any{"id": id, "method": method, "params": params}))
}

func (c *Controller) notify(method string, params any) error {
	return errtrace.Wrap(c.sendMessage(map[string]any{"method": method, "params": params}))
}

func (c *Controller) sendMessage(value any) error {
	line, err := json.Marshal(value)
	if err != nil {
		return errtrace.Wrap(err)
	}
	if c.opts.Send == nil {
		return errtrace.Wrap(fmt.Errorf("codex app-server send function is nil"))
	}
	return errtrace.Wrap(c.opts.Send(append(line, '\n')))
}

func (c *Controller) Start() error {
	id, err := c.send("initialize", map[string]any{
		"clientInfo":   map[string]any{"name": "hydra", "title": "Hydra", "version": "1"},
		"capabilities": map[string]any{"experimentalApi": true},
	})
	if err == nil {
		c.mu.Lock()
		c.initializeID = id
		c.mu.Unlock()
	}
	return errtrace.Wrap(err)
}

type message struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
}

// OnLine advances the handshake and tracks the active turn. It is safe to call
// from a single ordered stdout reader.
func (c *Controller) OnLine(line []byte) {
	var msg message
	if json.Unmarshal(bytes.TrimSpace(line), &msg) != nil {
		return
	}
	c.mu.Lock()
	initializeID, modelListID, threadRequestID, readRequestID := c.initializeID, c.modelListID, c.threadRequestID, c.readRequestID
	c.mu.Unlock()
	numericID, _ := strconv.ParseUint(string(msg.ID), 10, 64)
	if msg.Error != nil {
		// model/list is newer than the initial app-server protocol. Preserve
		// compatibility with an older installed CLI by falling back to its prior
		// model-selection behavior rather than failing the whole chat handshake.
		if numericID != 0 && numericID == modelListID {
			c.startThread(c.opts.Model)
			return
		}
		c.fail(fmt.Errorf("codex app-server error %d: %s", msg.Error.Code, msg.Error.Message))
		return
	}
	// Some app-server versions/reattached streams can expose item activity
	// before Hydra observes the matching turn/started notification. Treat a new
	// item as a provider-neutral running edge as well; this is deliberately not
	// called for token deltas, so status persistence is bounded per item.
	if msg.Method == "item/started" && c.opts.OnActivity != nil {
		c.opts.OnActivity(itemActivity(msg.Params))
	}
	hasID := len(msg.ID) > 0 && string(msg.ID) != "null"
	switch {
	case msg.Method == "" && numericID != 0 && numericID == initializeID:
		if err := c.notify("initialized", map[string]any{}); err != nil {
			c.fail(err)
			return
		}
		id, err := c.send("model/list", map[string]any{"limit": 100, "includeHidden": false})
		if err != nil {
			c.fail(err)
			return
		}
		c.mu.Lock()
		c.modelListID = id
		c.mu.Unlock()
	case msg.Method == "" && numericID != 0 && numericID == modelListID:
		c.startThread(modelFromList(msg.Result, c.opts.Model))
	case msg.Method == "" && numericID != 0 && numericID == threadRequestID:
		var result struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		if json.Unmarshal(msg.Result, &result) != nil || result.Thread.ID == "" {
			c.fail(fmt.Errorf("codex app-server thread response has no id"))
			return
		}
		c.mu.Lock()
		c.threadID = result.Thread.ID
		prompt := c.initialPrompt
		c.initialPrompt = ""
		if prompt != "" {
			c.pending = append([]json.RawMessage{mustJSON([]map[string]any{{"type": "text", "text": prompt}})}, c.pending...)
		}
		c.mu.Unlock()
		if c.opts.OnConversation != nil {
			c.opts.OnConversation(result.Thread.ID)
		}
		if c.opts.ConversationID != "" {
			id, err := c.send("thread/read", map[string]any{"threadId": result.Thread.ID, "includeTurns": true})
			if err != nil {
				c.fail(err)
				return
			}
			c.mu.Lock()
			c.readRequestID = id
			c.mu.Unlock()
			return
		}
		c.mu.Lock()
		c.threadReady = true
		c.mu.Unlock()
		c.drainPending()
	case msg.Method == "" && numericID != 0 && numericID == readRequestID:
		c.emitThreadHistory(msg.Result)
		c.mu.Lock()
		c.threadReady = true
		c.mu.Unlock()
		c.drainPending()
	case msg.Method == "turn/started":
		var params struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		if json.Unmarshal(msg.Params, &params) == nil {
			c.mu.Lock()
			c.turnID = params.Turn.ID
			c.mu.Unlock()
			if c.opts.OnTurnStart != nil {
				c.opts.OnTurnStart(params.Turn.ID)
			}
		}
	case msg.Method == "turn/completed":
		var params struct {
			Turn struct {
				ID string `json:"id"`
			} `json:"turn"`
		}
		_ = json.Unmarshal(msg.Params, &params)
		c.mu.Lock()
		c.turnID = ""
		c.mu.Unlock()
		if c.opts.OnTurnEnd != nil {
			c.opts.OnTurnEnd(params.Turn.ID)
		}
	case msg.Method == "item/completed":
		if c.opts.OnMessage != nil {
			if text := completedMessage(msg.Params); text != "" {
				c.opts.OnMessage(text)
			}
		}
		if c.opts.OnStep != nil {
			c.opts.OnStep()
		}
	case hasID && AutoApproved(msg.Method):
		// Hydra runs Codex with approvals disabled, so an approval prompt only
		// appears when that policy did not reach the thread. Nothing in the web
		// UI can answer one, and app-server blocks the turn until it is
		// answered, so accept here instead of wedging the head forever.
		if err := c.sendMessage(struct {
			ID     json.RawMessage `json:"id"`
			Result any             `json:"result"`
		}{ID: msg.ID, Result: map[string]any{"decision": "accept"}}); err != nil {
			c.fail(err)
		}
	case hasID && msg.Method != "":
		key := requestKey(msg.ID)
		c.mu.Lock()
		c.requests[key] = pendingRequest{id: append(json.RawMessage(nil), msg.ID...), method: msg.Method, params: append(json.RawMessage(nil), msg.Params...)}
		c.mu.Unlock()
		if msg.Method == "item/tool/requestUserInput" && c.opts.OnNeedsInput != nil {
			c.opts.OnNeedsInput(firstQuestion(msg.Params))
		}
	}
}

// itemActivity turns a Codex item/started notification into the durable,
// one-line "latest thing" shown in Hydra's agent list. The full structured item
// remains available to the chat normalizer and tool card.
func itemActivity(raw json.RawMessage) string {
	var params struct {
		Item struct {
			Type    string          `json:"type"`
			Command string          `json:"command"`
			Changes json.RawMessage `json:"changes"`
			Query   string          `json:"query"`
			Path    string          `json:"path"`
			Tool    string          `json:"tool"`
			Prompt  string          `json:"prompt"`
		} `json:"item"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return ""
	}
	item := params.Item
	switch item.Type {
	case "agent_message", "agentMessage", "reasoning":
		return ""
	case "commandExecution", "command_execution":
		if description := CommandDescription(item.Command); description != "" {
			return "# " + description
		}
		if command := firstCommandLine(item.Command); command != "" {
			return "$ " + truncateRunes(command, 80)
		}
		return "Running a command"
	case "fileChange", "file_change":
		return fileChangeActivity(item.Changes)
	case "webSearch", "web_search":
		if item.Query != "" {
			return "Searching the web: " + truncateRunes(item.Query, 50)
		}
		return "Searching the web"
	case "imageView", "image_view":
		if base := pathBase(item.Path); base != "" {
			return "Viewing " + base
		}
		return "Viewing an image"
	case "mcpToolCall":
		return "Using " + friendlyToolName(item.Tool)
	case "collabToolCall", "collabAgentToolCall":
		if item.Prompt != "" {
			return "Using Agent: " + truncateRunes(item.Prompt, 50)
		}
		return "Using Agent"
	case "sleep":
		return "Waiting"
	default:
		if item.Type == "" {
			return ""
		}
		return "Using " + friendlyToolName(item.Type)
	}
}

func completedMessage(raw json.RawMessage) string {
	var params struct {
		Item struct {
			Type   string `json:"type"`
			Text   string `json:"text"`
			Review string `json:"review"`
		} `json:"item"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return ""
	}
	switch params.Item.Type {
	case "agent_message", "agentMessage":
		return strings.TrimSpace(params.Item.Text)
	case "exitedReviewMode":
		return strings.TrimSpace(params.Item.Review)
	default:
		return ""
	}
}

func firstQuestion(raw json.RawMessage) string {
	var params struct {
		Questions []struct {
			Question string `json:"question"`
		} `json:"questions"`
	}
	if json.Unmarshal(raw, &params) != nil {
		return ""
	}
	for _, question := range params.Questions {
		if text := strings.TrimSpace(question.Question); text != "" {
			return text
		}
	}
	return ""
}

// CommandDescription reads the concise `# description` first-line convention
// from a Codex shell item. Both the transcript tool card and current-status line
// use this helper so they always show the same authored description.
func CommandDescription(command string) string {
	script := strings.TrimSpace(command)
	for _, launcher := range []string{"bash -lc ", "bash -c ", "/bin/bash -lc ", "/bin/bash -c ", "/usr/bin/bash -lc ", "/usr/bin/bash -c "} {
		if strings.HasPrefix(script, launcher) {
			script = strings.TrimSpace(strings.TrimPrefix(script, launcher))
			if len(script) >= 2 && (script[0] == '\'' || script[0] == '"') && script[len(script)-1] == script[0] {
				script = script[1 : len(script)-1]
			}
			break
		}
	}
	first, _, _ := strings.Cut(script, "\n")
	first = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(first), `"`), `'`))
	if !strings.HasPrefix(first, "#") || strings.HasPrefix(first, "#!") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(first, "#"))
}

func firstCommandLine(command string) string {
	for _, line := range strings.Split(command, "\n") {
		if line = strings.TrimSpace(line); line != "" && !strings.HasPrefix(line, "#") {
			return line
		}
	}
	return ""
}

func fileChangeActivity(raw json.RawMessage) string {
	var changes []struct {
		Path string          `json:"path"`
		Kind json.RawMessage `json:"kind"`
	}
	if json.Unmarshal(raw, &changes) != nil || len(changes) == 0 {
		return "Editing files"
	}
	verb := "Editing"
	kind := strings.ToLower(strings.Trim(string(changes[0].Kind), `"`))
	if strings.Contains(kind, "add") || strings.Contains(kind, "create") || strings.Contains(kind, "write") {
		verb = "Writing"
	} else if strings.Contains(kind, "delete") || strings.Contains(kind, "remove") {
		verb = "Deleting"
	}
	if len(changes) > 1 {
		return fmt.Sprintf("%s %d files", verb, len(changes))
	}
	if base := pathBase(changes[0].Path); base != "" {
		return verb + " " + base
	}
	return verb + " files"
}

func pathBase(path string) string {
	parts := strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' })
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

func friendlyToolName(name string) string {
	if name == "" {
		return "tool"
	}
	name = strings.TrimPrefix(name, "mcp__")
	if i := strings.Index(name, "__"); i >= 0 {
		name = name[i+2:]
	}
	name = strings.NewReplacer("__", " ", "_", " ", "-", " ").Replace(name)
	words := strings.Fields(name)
	if len(words) > 0 && len(words[0]) > 0 {
		words[0] = strings.ToUpper(words[0][:1]) + words[0][1:]
	}
	return strings.Join(words, " ")
}

func truncateRunes(value string, max int) string {
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max]) + "..."
}

func modelFromList(raw json.RawMessage, requested string) string {
	var result struct {
		Data []struct {
			ID        string `json:"id"`
			Model     string `json:"model"`
			IsDefault bool   `json:"isDefault"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return requested
	}
	if requested != "" {
		for _, entry := range result.Data {
			model := entry.Model
			if model == "" {
				model = entry.ID
			}
			if requested == entry.ID || requested == model || (requested == "gpt-5.6" && model == "gpt-5.6-sol") {
				return model
			}
		}
		return requested
	}
	for _, entry := range result.Data {
		if entry.IsDefault {
			if entry.Model != "" {
				return entry.Model
			}
			return entry.ID
		}
	}
	return ""
}

// AutoApproved reports whether a server-initiated request is a
// command/patch approval prompt that Hydra answers itself. These all take a
// bare {"decision": ...} response. item/permissions/requestApproval is
// deliberately excluded: its response is a permission profile, not a decision,
// and it cannot fire while the thread runs with sandbox "danger-full-access".
func AutoApproved(method string) bool {
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "applyPatchApproval", "execCommandApproval":
		return true
	}
	return false
}

func (c *Controller) startThread(model string) {
	c.mu.Lock()
	c.modelListID = 0
	c.model = model
	threadID := c.threadID
	c.mu.Unlock()
	if model != "" && c.opts.OnModel != nil {
		c.opts.OnModel(model)
	}
	// thread/resume accepts the same cwd/approval/sandbox overrides as
	// thread/start and, without them, falls back to the on-disk Codex defaults
	// (ask-for-approval + workspace-write). Codex cannot build its own sandbox
	// inside Hydra's, so a resumed thread would then block on an approval
	// prompt for its first command. Send the policy on both paths.
	params := map[string]any{"cwd": c.opts.CWD, "approvalPolicy": "never", "sandbox": "danger-full-access"}
	method := "thread/start"
	if threadID != "" {
		method = "thread/resume"
		params["threadId"] = threadID
	}
	if model != "" {
		params["model"] = model
	}
	id, err := c.send(method, params)
	if err != nil {
		c.fail(err)
		return
	}
	c.mu.Lock()
	c.threadRequestID = id
	c.mu.Unlock()
}

func (c *Controller) drainPending() {
	c.mu.Lock()
	pending := append([]json.RawMessage(nil), c.pending...)
	c.pending = nil
	c.mu.Unlock()
	for _, content := range pending {
		if err := c.SendUser(content); err != nil {
			c.fail(err)
		}
	}
}

func (c *Controller) emitThreadHistory(raw json.RawMessage) {
	if c.opts.OnHistoryLine == nil {
		return
	}
	var result struct {
		Thread struct {
			Turns []struct {
				Items []json.RawMessage `json:"items"`
			} `json:"turns"`
		} `json:"thread"`
	}
	if json.Unmarshal(raw, &result) != nil {
		return
	}
	for _, turn := range result.Thread.Turns {
		for _, item := range turn.Items {
			line, _ := json.Marshal(map[string]any{"method": "item/completed", "params": map[string]any{"item": json.RawMessage(item)}})
			c.opts.OnHistoryLine(line)
		}
	}
}

func requestKey(id json.RawMessage) string {
	var text string
	if json.Unmarshal(id, &text) == nil {
		return text
	}
	return string(id)
}

func (c *Controller) SendText(text string) error {
	return errtrace.Wrap(c.SendUser(mustJSON([]map[string]any{{"type": "text", "text": text}})))
}

// SendUser translates Hydra's provider-neutral content blocks to app-server
// turn input. Text is supported directly; unknown blocks become explicit text
// rather than disappearing silently.
func (c *Controller) SendUser(content json.RawMessage) error {
	var blocks []map[string]any
	if err := json.Unmarshal(content, &blocks); err != nil {
		return errtrace.Wrap(err)
	}
	input := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		if block["type"] == "text" {
			if text, ok := block["text"].(string); ok {
				input = append(input, map[string]any{"type": "text", "text": text})
			}
			continue
		}
		raw, _ := json.Marshal(block)
		input = append(input, map[string]any{"type": "text", "text": "[Hydra attachment] " + string(raw)})
	}
	if len(input) == 0 {
		return errtrace.Wrap(fmt.Errorf("empty Codex turn input"))
	}
	c.mu.Lock()
	threadID, turnID, ready, model := c.threadID, c.turnID, c.threadReady, c.model
	if threadID == "" || !ready {
		c.pending = append(c.pending, append(json.RawMessage(nil), content...))
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()
	if turnID != "" {
		_, err := c.send("turn/steer", map[string]any{
			"threadId":       threadID,
			"input":          input,
			"expectedTurnId": turnID,
		})
		return errtrace.Wrap(err)
	}
	params := map[string]any{"threadId": threadID, "input": input}
	if model != "" {
		params["model"] = model
	}
	_, err := c.send("turn/start", params)
	return errtrace.Wrap(err)
}

// SetModel applies to subsequent turn/start requests; an active turn is not
// mutated underneath the model that is already producing it.
func (c *Controller) SetModel(model string) error {
	if strings.TrimSpace(model) == "" {
		return errtrace.Wrap(fmt.Errorf("Codex model is empty"))
	}
	c.mu.Lock()
	c.model = model
	c.mu.Unlock()
	return nil
}

func (c *Controller) Interrupt() error {
	c.mu.Lock()
	threadID, turnID := c.threadID, c.turnID
	c.mu.Unlock()
	if threadID == "" || turnID == "" {
		return nil
	}
	_, err := c.send("turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID})
	return errtrace.Wrap(err)
}

// Respond translates Hydra's interaction response envelope into the matching
// app-server JSON-RPC response. Ask-user answers are keyed by visible question
// text in Hydra, so map them back to Codex's stable question ids.
func (c *Controller) Respond(raw json.RawMessage) error {
	var envelope struct {
		RequestID string `json:"request_id"`
		Response  struct {
			Behavior     string `json:"behavior"`
			UpdatedInput struct {
				Answers map[string]string `json:"answers"`
				// The free-text note the user attached to an answer, keyed by
				// question text. Claude's AskUserQuestion takes these natively;
				// Codex has no such field, so they are folded into the answer
				// list below.
				Annotations map[string]struct {
					Notes string `json:"notes"`
				} `json:"annotations"`
			} `json:"updatedInput"`
		} `json:"response"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil || envelope.RequestID == "" {
		return errtrace.Wrap(fmt.Errorf("invalid Codex interaction response"))
	}
	c.mu.Lock()
	request, ok := c.requests[envelope.RequestID]
	if ok {
		delete(c.requests, envelope.RequestID)
	}
	c.mu.Unlock()
	if !ok {
		return errtrace.Wrap(fmt.Errorf("unknown Codex interaction %q", envelope.RequestID))
	}
	result := map[string]any{}
	if request.method == "item/tool/requestUserInput" {
		var params struct {
			Questions []struct {
				ID       string `json:"id"`
				Question string `json:"question"`
			} `json:"questions"`
		}
		_ = json.Unmarshal(request.params, &params)
		answers := map[string]any{}
		for _, question := range params.Questions {
			answer, exists := envelope.Response.UpdatedInput.Answers[question.Question]
			note := envelope.Response.UpdatedInput.Annotations[question.Question].Notes
			if !exists && note == "" {
				continue
			}
			var parts []string
			if answer != "" {
				parts = strings.Split(answer, ", ")
			}
			// Codex takes a plain list of chosen answers per question, with
			// nowhere to put a note that qualifies them. Send it as one more
			// entry, labelled so it does not read as another option the user
			// picked. A note with nothing selected is a valid answer on its own.
			if note != "" {
				parts = append(parts, "note: "+note)
			}
			if len(parts) == 0 {
				continue
			}
			answers[question.ID] = map[string]any{"answers": parts}
		}
		result["answers"] = answers
	} else if envelope.Response.Behavior == "allow" {
		result["decision"] = "accept"
	} else {
		result["decision"] = "decline"
	}
	err := c.sendMessage(struct {
		ID     json.RawMessage `json:"id"`
		Result any             `json:"result"`
	}{ID: request.id, Result: result})
	if err == nil && request.method == "item/tool/requestUserInput" {
		// App-server's serverRequest/resolved notification does not include the
		// answer. Record Hydra's outgoing response as a synthetic resolved event
		// so a replay can restore the choices on the question card.
		if c.opts.OnHistoryLine != nil {
			line, _ := json.Marshal(map[string]any{
				"method": "serverRequest/resolved",
				"params": map[string]any{
					"method": request.method, "request_id": json.RawMessage(request.id),
					"params": json.RawMessage(request.params), "response": envelope.Response,
				},
			})
			c.opts.OnHistoryLine(line)
		}
		if c.opts.OnActivity != nil {
			c.opts.OnActivity("")
		}
	}
	return errtrace.Wrap(err)
}

func (c *Controller) fail(err error) {
	if c.opts.OnError != nil {
		c.opts.OnError(err)
	}
}

func mustJSON(value any) json.RawMessage {
	raw, _ := json.Marshal(value)
	return raw
}

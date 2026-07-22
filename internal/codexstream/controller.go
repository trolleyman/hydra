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
	OnTurnStart    func(string)
	OnTurnEnd      func(string)
	OnError        func(error)
}

type Controller struct {
	opts Options
	seq  atomic.Uint64

	mu              sync.Mutex
	threadID        string
	turnID          string
	initialPrompt   string
	pending         []json.RawMessage
	requests        map[string]pendingRequest
	initializeID    uint64
	threadRequestID uint64
}

type pendingRequest struct {
	id     uint64
	method string
	params json.RawMessage
}

func New(opts Options) *Controller {
	return &Controller{opts: opts, threadID: opts.ConversationID, initialPrompt: opts.InitialPrompt, requests: map[string]pendingRequest{}}
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
	ID     uint64          `json:"id,omitempty"`
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
	if msg.Error != nil {
		c.fail(fmt.Errorf("codex app-server error %d: %s", msg.Error.Code, msg.Error.Message))
		return
	}
	c.mu.Lock()
	initializeID, threadRequestID := c.initializeID, c.threadRequestID
	c.mu.Unlock()
	switch {
	case msg.Method == "" && msg.ID != 0 && msg.ID == initializeID:
		if err := c.notify("initialized", map[string]any{}); err != nil {
			c.fail(err)
			return
		}
		params := map[string]any{"cwd": c.opts.CWD, "approvalPolicy": "never", "sandbox": "danger-full-access"}
		if c.opts.Model != "" {
			params["model"] = c.opts.Model
		}
		method := "thread/start"
		c.mu.Lock()
		if c.threadID != "" {
			method = "thread/resume"
			params = map[string]any{"threadId": c.threadID}
		}
		c.mu.Unlock()
		id, err := c.send(method, params)
		if err != nil {
			c.fail(err)
			return
		}
		c.mu.Lock()
		c.threadRequestID = id
		c.mu.Unlock()
	case msg.Method == "" && msg.ID != 0 && msg.ID == threadRequestID:
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
		pending := append([]json.RawMessage(nil), c.pending...)
		c.pending = nil
		c.mu.Unlock()
		if c.opts.OnConversation != nil {
			c.opts.OnConversation(result.Thread.ID)
		}
		for _, content := range pending {
			if err := c.SendUser(content); err != nil {
				c.fail(err)
			}
		}
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
	case msg.ID != 0 && msg.Method != "":
		key := strconv.FormatUint(msg.ID, 10)
		c.mu.Lock()
		c.requests[key] = pendingRequest{id: msg.ID, method: msg.Method, params: append(json.RawMessage(nil), msg.Params...)}
		c.mu.Unlock()
	}
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
	threadID := c.threadID
	if threadID == "" {
		c.pending = append(c.pending, append(json.RawMessage(nil), content...))
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()
	_, err := c.send("turn/start", map[string]any{"threadId": threadID, "input": input})
	return errtrace.Wrap(err)
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
			if answer, exists := envelope.Response.UpdatedInput.Answers[question.Question]; exists {
				parts := strings.Split(answer, ", ")
				answers[question.ID] = map[string]any{"answers": parts}
			}
		}
		result["answers"] = answers
	} else if envelope.Response.Behavior == "allow" {
		result["decision"] = "accept"
	} else {
		result["decision"] = "decline"
	}
	return errtrace.Wrap(c.sendMessage(map[string]any{"id": request.id, "result": result}))
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

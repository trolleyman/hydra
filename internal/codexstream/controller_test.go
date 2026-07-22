package codexstream

import (
	"braces.dev/errtrace"
	"encoding/json"
	"testing"
)

func TestControllerFreshThreadAndInitialTurn(t *testing.T) {
	var sent []map[string]any
	var conversation string
	c := New(Options{CWD: "/repo", Model: "gpt-test", InitialPrompt: "hello", OnConversation: func(id string) { conversation = id }, Send: func(line []byte) error {
		var value map[string]any
		if err := json.Unmarshal(line, &value); err != nil {
			return errtrace.Wrap(err)
		}
		sent = append(sent, value)
		return nil
	}})
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	c.OnLine([]byte(`{"id":1,"result":{"userAgent":"test"}}`))
	c.OnLine([]byte(`{"id":2,"result":{"thread":{"id":"thr-1"}}}`))
	if conversation != "thr-1" {
		t.Fatalf("conversation = %q", conversation)
	}
	methods := []string{"initialize", "initialized", "thread/start", "turn/start"}
	if len(sent) != len(methods) {
		t.Fatalf("sent = %+v", sent)
	}
	for i, method := range methods {
		if sent[i]["method"] != method {
			t.Errorf("message %d method = %v", i, sent[i]["method"])
		}
	}
}

func TestControllerModelChangeAppliesToNextTurn(t *testing.T) {
	var sent []map[string]any
	c := New(Options{Model: "gpt-old", Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	_ = c.Start()
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	c.OnLine([]byte(`{"id":2,"result":{"thread":{"id":"thr"}}}`))
	if err := c.SetModel("gpt-new"); err != nil {
		t.Fatal(err)
	}
	if err := c.SendText("hello"); err != nil {
		t.Fatal(err)
	}
	params := sent[len(sent)-1]["params"].(map[string]any)
	if params["model"] != "gpt-new" {
		t.Fatalf("turn params = %+v", params)
	}
}

func TestControllerResumeAndInterrupt(t *testing.T) {
	var sent []map[string]any
	var started, ended string
	c := New(Options{ConversationID: "thr-old", OnTurnStart: func(id string) { started = id }, OnTurnEnd: func(id string) { ended = id }, Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	if sent[2]["method"] != "thread/resume" {
		t.Fatalf("sent = %+v", sent)
	}
	c.OnLine([]byte(`{"id":2,"result":{"thread":{"id":"thr-old"}}}`))
	c.OnLine([]byte(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`))
	if started != "turn-1" {
		t.Fatalf("started = %q", started)
	}
	if err := c.Interrupt(); err != nil {
		t.Fatal(err)
	}
	if sent[len(sent)-1]["method"] != "turn/interrupt" {
		t.Fatalf("sent = %+v", sent)
	}
	c.OnLine([]byte(`{"method":"turn/completed","params":{"turn":{"id":"turn-1"}}}`))
	if ended != "turn-1" {
		t.Fatalf("ended = %q", ended)
	}
}

func TestControllerItemActivityMarksRunning(t *testing.T) {
	activity := 0
	c := New(Options{OnActivity: func() { activity++ }})
	c.OnLine([]byte(`{"method":"item/started","params":{"item":{"id":"a","type":"agentMessage"}}}`))
	c.OnLine([]byte(`{"method":"item/agentMessage/delta","params":{"delta":"hello"}}`))
	if activity != 1 {
		t.Fatalf("activity callbacks = %d, want 1", activity)
	}
}

func TestControllerReadsHistoryBeforeQueuedResumeTurn(t *testing.T) {
	var sent []map[string]any
	var recovered [][]byte
	c := New(Options{ConversationID: "thr-old", OnHistoryLine: func(line []byte) { recovered = append(recovered, line) }, Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	_ = c.Start()
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	if err := c.SendText("queued"); err != nil {
		t.Fatal(err)
	}
	c.OnLine([]byte(`{"id":2,"result":{"thread":{"id":"thr-old"}}}`))
	if sent[len(sent)-1]["method"] != "thread/read" {
		t.Fatalf("sent = %+v", sent)
	}
	c.OnLine([]byte(`{"id":3,"result":{"thread":{"turns":[{"items":[{"id":"m1","type":"agentMessage","text":"old"}]}]}}}`))
	if len(recovered) != 1 || sent[len(sent)-1]["method"] != "turn/start" {
		t.Fatalf("recovered=%q sent=%+v", recovered, sent)
	}
}

func TestControllerRespondsToUserInputRequest(t *testing.T) {
	var sent []map[string]any
	c := New(Options{Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	c.OnLine([]byte(`{"id":42,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q1","question":"Which?"}]}}`))
	response := json.RawMessage(`{"request_id":"42","response":{"behavior":"allow","updatedInput":{"answers":{"Which?":"A, B"}}}}`)
	if err := c.Respond(response); err != nil {
		t.Fatal(err)
	}
	result := sent[0]["result"].(map[string]any)
	answers := result["answers"].(map[string]any)
	if _, ok := answers["q1"]; !ok {
		t.Fatalf("response = %+v", sent[0])
	}
}

func TestControllerRespondsToZeroIDUserInputRequest(t *testing.T) {
	var sent []map[string]any
	c := New(Options{Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	c.OnLine([]byte(`{"id":0,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q1","question":"Which?"}]}}`))
	response := json.RawMessage(`{"request_id":"0","response":{"behavior":"allow","updatedInput":{"answers":{"Which?":"A"}}}}`)
	if err := c.Respond(response); err != nil {
		t.Fatal(err)
	}
	if got := sent[0]["id"]; got != float64(0) {
		t.Fatalf("response id = %#v, want 0", got)
	}
}

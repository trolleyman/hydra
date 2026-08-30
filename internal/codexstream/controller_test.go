package codexstream

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"braces.dev/errtrace"
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
	c.OnLine([]byte(`{"id":2,"result":{"data":[{"id":"gpt-test","model":"gpt-test","isDefault":true}]}}`))
	c.OnLine([]byte(`{"id":3,"result":{"thread":{"id":"thr-1"}}}`))
	if conversation != "thr-1" {
		t.Fatalf("conversation = %q", conversation)
	}
	methods := []string{"initialize", "initialized", "model/list", "thread/start", "turn/start"}
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
	c.OnLine([]byte(`{"id":2,"result":{"data":[{"id":"gpt-old","model":"gpt-old"}]}}`))
	c.OnLine([]byte(`{"id":3,"result":{"thread":{"id":"thr"}}}`))
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

func TestControllerResolvesAccountDefaultAndAliasFromModelList(t *testing.T) {
	var sent []map[string]any
	resolved := ""
	c := New(Options{Model: "gpt-5.6", OnModel: func(model string) { resolved = model }, Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	_ = c.Start()
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	c.OnLine([]byte(`{"id":2,"result":{"data":[{"id":"gpt-5.6-sol","model":"gpt-5.6-sol","isDefault":true}]}}`))
	params := sent[len(sent)-1]["params"].(map[string]any)
	if params["model"] != "gpt-5.6-sol" || resolved != "gpt-5.6-sol" {
		t.Fatalf("thread params=%+v resolved=%q", params, resolved)
	}
}

func TestControllerUsesAccountDefaultWhenNoModelWasRequested(t *testing.T) {
	var sent []map[string]any
	c := New(Options{Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	_ = c.Start()
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	c.OnLine([]byte(`{"id":2,"result":{"data":[{"id":"old","model":"old"},{"id":"sol","model":"gpt-5.6-sol","isDefault":true}]}}`))
	params := sent[len(sent)-1]["params"].(map[string]any)
	if params["model"] != "gpt-5.6-sol" {
		t.Fatalf("thread params = %+v", params)
	}
}

func TestControllerFallsBackWhenModelListIsUnsupported(t *testing.T) {
	var sent []map[string]any
	c := New(Options{Model: "gpt-legacy", Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	_ = c.Start()
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	c.OnLine([]byte(`{"id":2,"error":{"code":-32601,"message":"Method not found"}}`))
	last := sent[len(sent)-1]
	params := last["params"].(map[string]any)
	if last["method"] != "thread/start" || params["model"] != "gpt-legacy" {
		t.Fatalf("sent = %+v", sent)
	}
}

func TestControllerResumeAndInterrupt(t *testing.T) {
	var sent []map[string]any
	var started, ended string
	c := New(Options{ConversationID: "thr-old", Model: "gpt-restored", OnTurnStart: func(id string) { started = id }, OnTurnEnd: func(id string) { ended = id }, Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	c.OnLine([]byte(`{"id":2,"result":{"data":[{"id":"gpt-restored","model":"gpt-restored","isDefault":true}]}}`))
	if sent[3]["method"] != "thread/resume" {
		t.Fatalf("sent = %+v", sent)
	}
	// A resumed thread must carry the same approval/sandbox policy as a fresh
	// one; otherwise Codex reverts to prompting for command approval and the
	// head blocks on a prompt no Hydra UI can answer.
	resumeParams := sent[3]["params"].(map[string]any)
	if resumeParams["threadId"] != "thr-old" || resumeParams["approvalPolicy"] != "never" || resumeParams["sandbox"] != "danger-full-access" {
		t.Fatalf("resume params = %+v", resumeParams)
	}
	c.OnLine([]byte(`{"id":3,"result":{"thread":{"id":"thr-old"}}}`))
	c.OnLine([]byte(`{"id":4,"result":{"thread":{"turns":[]}}}`))
	if err := c.SendText("resumed"); err != nil {
		t.Fatal(err)
	}
	turnParams := sent[len(sent)-1]["params"].(map[string]any)
	if turnParams["model"] != "gpt-restored" {
		t.Fatalf("resumed turn params = %+v", turnParams)
	}
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

func TestControllerAutoAcceptsApprovalRequests(t *testing.T) {
	var sent []map[string]any
	c := New(Options{Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	c.OnLine([]byte(`{"id":"req-1","method":"item/commandExecution/requestApproval","params":{"command":"ls"}}`))
	last := sent[len(sent)-1]
	if last["id"] != "req-1" {
		t.Fatalf("sent = %+v", sent)
	}
	if result, ok := last["result"].(map[string]any); !ok || result["decision"] != "accept" {
		t.Fatalf("approval response = %+v", last)
	}
	// Requests Hydra can actually surface stay parked for the user to answer.
	before := len(sent)
	c.OnLine([]byte(`{"id":"req-2","method":"item/tool/requestUserInput","params":{"questions":[]}}`))
	if len(sent) != before {
		t.Fatalf("requestUserInput answered automatically: %+v", sent[before:])
	}
}

func TestControllerItemActivityMarksRunning(t *testing.T) {
	activity, steps := 0, 0
	c := New(Options{
		OnActivity: func(string) { activity++ },
		OnStep:     func() { steps++ },
	})
	c.OnLine([]byte(`{"method":"item/started","params":{"item":{"id":"a","type":"agentMessage"}}}`))
	c.OnLine([]byte(`{"method":"item/agentMessage/delta","params":{"delta":"hello"}}`))
	c.OnLine([]byte(`{"method":"item/completed","params":{"item":{"id":"a","type":"agentMessage","text":"hello"}}}`))
	if activity != 1 {
		t.Fatalf("activity callbacks = %d, want 1", activity)
	}
	if steps != 1 {
		t.Fatalf("step callbacks = %d, want 1", steps)
	}
}

func TestControllerReportsLatestThing(t *testing.T) {
	var activities, messages, questions []string
	c := New(Options{
		OnActivity:   func(detail string) { activities = append(activities, detail) },
		OnMessage:    func(message string) { messages = append(messages, message) },
		OnNeedsInput: func(question string) { questions = append(questions, question) },
	})
	c.OnLine([]byte(`{"method":"item/started","params":{"item":{"id":"shell","type":"commandExecution","command":"/usr/bin/bash -lc '# Run backend tests\ngo test ./...'"}}}`))
	c.OnLine([]byte(`{"method":"item/started","params":{"item":{"id":"edit","type":"fileChange","changes":[{"path":"internal/heads/activity.go","kind":{"type":"update"}}]}}}`))
	c.OnLine([]byte(`{"method":"item/started","params":{"item":{"id":"mcp","type":"mcpToolCall","server":"hydra","tool":"get_head_status"}}}`))
	c.OnLine([]byte(`{"method":"item/completed","params":{"item":{"id":"message","type":"agentMessage","text":"The improved status is implemented.\n\nTests pass."}}}`))
	c.OnLine([]byte(`{"id":7,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q1","question":"Which status behavior should Codex use?"},{"id":"q2","question":"Anything else?"}]}}`))

	wantActivities := []string{"# Run backend tests", "Editing activity.go", "Using Get head status"}
	if !reflect.DeepEqual(activities, wantActivities) {
		t.Fatalf("activities = %#v, want %#v", activities, wantActivities)
	}
	if want := []string{"The improved status is implemented.\n\nTests pass."}; !reflect.DeepEqual(messages, want) {
		t.Fatalf("messages = %#v, want %#v", messages, want)
	}
	if want := []string{"Which status behavior should Codex use?"}; !reflect.DeepEqual(questions, want) {
		t.Fatalf("questions = %#v, want %#v", questions, want)
	}
}

func TestItemActivityFallbacks(t *testing.T) {
	tests := []struct {
		name string
		line string
		want string
	}{
		{"raw command", `{"item":{"type":"commandExecution","command":"mage build"}}`, "$ mage build"},
		{"unknown item", `{"item":{"type":"ToolSearch"}}`, "Using ToolSearch"},
		{"image basename", `{"item":{"type":"imageView","path":"/tmp/image1.png"}}`, "Viewing image1.png"},
		{"web query", `{"item":{"type":"webSearch","query":"Codex app server"}}`, "Searching the web: Codex app server"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := itemActivity(json.RawMessage(test.line)); got != test.want {
				t.Fatalf("itemActivity() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestControllerSteersActiveTurnAndStartsNextTurnWhenIdle(t *testing.T) {
	var sent []map[string]any
	c := New(Options{Model: "gpt-test", Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	_ = c.Start()
	c.OnLine([]byte(`{"id":1,"result":{}}`))
	c.OnLine([]byte(`{"id":2,"result":{"data":[{"id":"gpt-test","model":"gpt-test","isDefault":true}]}}`))
	c.OnLine([]byte(`{"id":3,"result":{"thread":{"id":"thr"}}}`))
	c.OnLine([]byte(`{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}`))

	if err := c.SendText("focus on the test failure"); err != nil {
		t.Fatal(err)
	}
	steer := sent[len(sent)-1]
	steerParams := steer["params"].(map[string]any)
	if steer["method"] != "turn/steer" || steerParams["threadId"] != "thr" || steerParams["expectedTurnId"] != "turn-1" {
		t.Fatalf("active turn send = %+v", steer)
	}
	if _, ok := steerParams["model"]; ok {
		t.Fatalf("turn/steer must not carry turn-level model override: %+v", steerParams)
	}

	c.OnLine([]byte(`{"method":"turn/completed","params":{"turn":{"id":"turn-1"}}}`))
	if err := c.SendText("now summarize"); err != nil {
		t.Fatal(err)
	}
	next := sent[len(sent)-1]
	if next["method"] != "turn/start" {
		t.Fatalf("idle send = %+v", next)
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
	c.OnLine([]byte(`{"id":2,"result":{"data":[{"id":"gpt-default","model":"gpt-default","isDefault":true}]}}`))
	if err := c.SendText("queued"); err != nil {
		t.Fatal(err)
	}
	c.OnLine([]byte(`{"id":3,"result":{"thread":{"id":"thr-old"}}}`))
	if sent[len(sent)-1]["method"] != "thread/read" {
		t.Fatalf("sent = %+v", sent)
	}
	c.OnLine([]byte(`{"id":4,"result":{"thread":{"turns":[{"items":[{"id":"m1","type":"agentMessage","text":"old"}]}]}}}`))
	if len(recovered) != 1 || sent[len(sent)-1]["method"] != "turn/start" {
		t.Fatalf("recovered=%q sent=%+v", recovered, sent)
	}
}

func TestControllerRespondsToUserInputRequest(t *testing.T) {
	var sent []map[string]any
	var history [][]byte
	needsInput, activity := 0, 0
	c := New(Options{OnNeedsInput: func(string) { needsInput++ }, OnActivity: func(string) { activity++ }, OnHistoryLine: func(line []byte) { history = append(history, line) }, Send: func(line []byte) error {
		var value map[string]any
		_ = json.Unmarshal(line, &value)
		sent = append(sent, value)
		return nil
	}})
	c.OnLine([]byte(`{"id":42,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q1","question":"Which?"}]}}`))
	if needsInput != 1 || activity != 0 {
		t.Fatalf("request callbacks: needsInput=%d activity=%d, want 1/0", needsInput, activity)
	}
	response := json.RawMessage(`{"request_id":"42","response":{"behavior":"allow","updatedInput":{"answers":{"Which?":"A, B"}}}}`)
	if err := c.Respond(response); err != nil {
		t.Fatal(err)
	}
	result := sent[0]["result"].(map[string]any)
	answers := result["answers"].(map[string]any)
	if _, ok := answers["q1"]; !ok {
		t.Fatalf("response = %+v", sent[0])
	}
	if activity != 1 {
		t.Fatalf("activity callbacks after answer = %d, want 1", activity)
	}
	if len(history) != 1 || !strings.Contains(string(history[0]), `"answers":{"Which?":"A, B"}`) {
		t.Fatalf("answer history = %q", history)
	}
}

func TestControllerFailedUserInputResponseStaysNeedsInput(t *testing.T) {
	activity := 0
	c := New(Options{
		OnActivity: func(string) { activity++ },
		Send:       func([]byte) error { return errtrace.Wrap(errors.New("send failed")) },
	})
	c.OnLine([]byte(`{"id":42,"method":"item/tool/requestUserInput","params":{"questions":[]}}`))
	err := c.Respond(json.RawMessage(`{"request_id":"42","response":{"behavior":"allow","updatedInput":{}}}`))
	if err == nil {
		t.Fatal("Respond succeeded, want send error")
	}
	if activity != 0 {
		t.Fatalf("activity callbacks = %d, want 0 after failed answer", activity)
	}
}

// Claude's AskUserQuestion carries a note qualifying an answer in its own
// `annotations` field; Codex's requestUserInput has no such field, only a list
// of chosen answers per question. Dropping the note would lose what the user
// actually said, so it rides as one more entry, labelled.
func TestControllerFoldsAnswerNotesIntoCodexAnswers(t *testing.T) {
	answersFor := func(t *testing.T, updatedInput string) map[string]any {
		t.Helper()
		var sent []map[string]any
		c := New(Options{Send: func(line []byte) error {
			var value map[string]any
			_ = json.Unmarshal(line, &value)
			sent = append(sent, value)
			return nil
		}})
		c.OnLine([]byte(`{"id":7,"method":"item/tool/requestUserInput","params":{"questions":[{"id":"q1","question":"Which?"},{"id":"q2","question":"Extras?"}]}}`))
		if err := c.Respond(json.RawMessage(`{"request_id":"7","response":{"behavior":"allow","updatedInput":` + updatedInput + `}}`)); err != nil {
			t.Fatal(err)
		}
		return sent[0]["result"].(map[string]any)["answers"].(map[string]any)
	}

	t.Run("alongside a pick", func(t *testing.T) {
		answers := answersFor(t, `{"answers":{"Which?":"A, B"},"annotations":{"Which?":{"notes":"but not in prod"}}}`)
		got := answers["q1"].(map[string]any)["answers"].([]any)
		want := []any{"A", "B", "note: but not in prod"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("answers = %#v, want %#v", got, want)
		}
	})

	t.Run("on its own", func(t *testing.T) {
		answers := answersFor(t, `{"answers":{"Which?":""},"annotations":{"Which?":{"notes":"neither"}}}`)
		got := answers["q1"].(map[string]any)["answers"].([]any)
		if want := []any{"note: neither"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("answers = %#v, want %#v", got, want)
		}
	})

	// A question left blank with no note is left out entirely rather than sent
	// as a single empty answer.
	t.Run("skips an empty answer", func(t *testing.T) {
		answers := answersFor(t, `{"answers":{"Which?":"A","Extras?":""}}`)
		if _, ok := answers["q2"]; ok {
			t.Fatalf("unanswered question sent anyway: %#v", answers)
		}
	})
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

package claudestream

import (
	"bytes"
	"encoding/json"
	"os"
	"regexp"
	"sort"
	"strconv"
)

// Server-side reconstruction of the chat plan / to-do list from a session
// transcript.
//
// The chat view rebuilds the plan panel from TaskCreate/TaskUpdate/TodoWrite
// tool calls and persists it to the agent record - but only a browser that had
// the chat open while those calls were reachable (live, or still inside the
// backfill tail window) could do so. A head that ran unwatched, or whose
// transcript outgrew the window before anyone attached, ended up with no plan
// anywhere: the attach backfill starts megabytes past the creates, and the
// scroll-older page deliberately renders Task* calls as plain tool cards
// without touching the panel. This scan is the durable fallback: on chat
// attach the daemon replays the WHOLE transcript through the same reducer
// semantics as web/src/lib/planReducer.ts and hands the client the finished
// list, so the panel no longer depends on any browser having watched the run.
//
// The two reducers must stay in lockstep; the mirrored rules are:
//   - TodoWrite replaces the whole list (synthetic "todo:<i>" keys).
//   - TaskCreate adds one pending task, keyed provisionally by its tool_use id;
//     the harness-assigned "#N" id arrives in the tool RESULT, which re-keys it
//     (a later TaskUpdate references that id, not creation order).
//   - TaskUpdate mutates one task by id; status "deleted" removes it; an update
//     for an unknown id is dropped.
//   - A session uses ONE planning tool: a TaskCreate after a TodoWrite plan
//     (or vice versa) clears the old list.

// PlanEntry matches the client's persisted shape (web/src/lib/planStore.ts);
// the JSON is what lands in Agent.Plan and in the chat "plan" frame.
type PlanEntry struct {
	Key         string `json:"key"`
	Content     string `json:"content"`
	Status      string `json:"status"`
	ActiveForm  string `json:"activeForm,omitempty"`
	Description string `json:"description,omitempty"`
	Order       int    `json:"order"`
}

// planLine is the slice of a transcript entry the reconstruction needs.
type planLine struct {
	Type        string `json:"type"`
	IsSidechain bool   `json:"isSidechain"`
	Message     struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type planBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
	Content   json.RawMessage `json:"content"`
}

type planTask struct {
	content     string
	status      string
	activeForm  string
	description string
	order       int
}

var taskResultID = regexp.MustCompile(`#(\d+)`)

// resultText flattens a tool_result content payload (a bare string or an array
// of text blocks) into its text, for extracting the assigned task id.
func resultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	var buf bytes.Buffer
	for _, b := range blocks {
		if b.Type == "text" {
			buf.WriteString(b.Text)
		}
	}
	return buf.String()
}

// optString reads a string field from a decoded tool input, reporting whether
// it was present as a string at all (the update semantics distinguish "not
// sent" from "sent empty", mirroring parseTaskUpdate).
func optString(m map[string]any, key string) (string, bool) {
	v, ok := m[key].(string)
	return v, ok
}

// ReconstructPlan scans a whole session transcript file and returns the
// agent's current plan as PlanEntry JSON, or "" when the session never built
// one. Best-effort: any read/parse failure yields "".
func ReconstructPlan(path string) string {
	if path == "" {
		return ""
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return ReconstructPlanFromTranscript(data)
}

// ReconstructPlanFromTranscript is ReconstructPlan over in-memory transcript
// lines (also feeds the simulation server, so sim exercises the real reducer).
func ReconstructPlanFromTranscript(transcript []byte) string {
	entries := reconstructPlan(transcript)
	if len(entries) == 0 {
		return ""
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return ""
	}
	return string(data)
}

var planToolMarkers = [][]byte{[]byte(`"TaskCreate"`), []byte(`"TaskUpdate"`), []byte(`"TodoWrite"`)}
var toolResultMarker = []byte(`"tool_result"`)

func reconstructPlan(data []byte) []PlanEntry {
	tasks := map[string]*planTask{}
	seq := 0
	// "todo" | "task" | "" - which planning tool currently owns the list.
	mode := ""
	// Create tool_use ids already folded in, so a re-emitted block (the
	// transcript can repeat a message's blocks; see reduceHistoryEvents'
	// seenBlocks note) doesn't resurrect a settled task as a pending clone.
	seenCreates := map[string]bool{}

	// mightMatter is the cheap pre-filter: transcript lines are often huge
	// (embedded images), so only lines that can affect the plan - a planning
	// tool call, or a tool_result that could carry a pending create's id - get
	// JSON-decoded at all.
	mightMatter := func(line []byte) bool {
		for _, m := range planToolMarkers {
			if bytes.Contains(line, m) {
				return true
			}
		}
		if !bytes.Contains(line, toolResultMarker) {
			return false
		}
		for key := range tasks {
			if len(key) > 4 && key[:4] == "use:" && bytes.Contains(line, []byte(key[4:])) {
				return true
			}
		}
		return false
	}

	applyCreate := func(b planBlock) {
		var in map[string]any
		if json.Unmarshal(b.Input, &in) != nil {
			return
		}
		subject, _ := optString(in, "subject")
		if subject == "" || b.ID == "" || seenCreates[b.ID] {
			return
		}
		seenCreates[b.ID] = true
		if mode == "todo" {
			tasks = map[string]*planTask{}
			seq = 0
		}
		mode = "task"
		seq++
		activeForm, _ := optString(in, "activeForm")
		description, _ := optString(in, "description")
		tasks["use:"+b.ID] = &planTask{content: subject, status: "pending", activeForm: activeForm, description: description, order: seq}
	}

	applyUpdate := func(b planBlock) {
		var in map[string]any
		if json.Unmarshal(b.Input, &in) != nil {
			return
		}
		taskID, _ := optString(in, "taskId")
		if taskID == "" {
			if n, ok := in["taskId"].(float64); ok {
				taskID = strconv.Itoa(int(n))
			}
		}
		if taskID == "" {
			return
		}
		cur, ok := tasks[taskID]
		if !ok {
			return
		}
		if status, _ := optString(in, "status"); status == "deleted" {
			delete(tasks, taskID)
			return
		} else if status == "pending" || status == "in_progress" || status == "completed" {
			cur.status = status
		}
		if subject, _ := optString(in, "subject"); subject != "" {
			cur.content = subject
		}
		if activeForm, ok := optString(in, "activeForm"); ok {
			cur.activeForm = activeForm
		}
		if description, ok := optString(in, "description"); ok && description != "" {
			cur.description = description
		}
	}

	applyTodoWrite := func(b planBlock) {
		var in struct {
			Todos []map[string]any `json:"todos"`
		}
		if json.Unmarshal(b.Input, &in) != nil || in.Todos == nil {
			return
		}
		next := map[string]*planTask{}
		n := 0
		for _, t := range in.Todos {
			content, _ := optString(t, "content")
			if content == "" {
				continue
			}
			status, _ := optString(t, "status")
			if status != "in_progress" && status != "completed" {
				status = "pending"
			}
			activeForm, _ := optString(t, "activeForm")
			next["todo:"+strconv.Itoa(n)] = &planTask{content: content, status: status, activeForm: activeForm, order: n + 1}
			n++
		}
		if n == 0 {
			return
		}
		mode = "todo"
		tasks = next
		seq = n
	}

	applyResult := func(b planBlock) {
		cur, ok := tasks["use:"+b.ToolUseID]
		if !ok {
			return
		}
		id := strconv.Itoa(cur.order)
		if m := taskResultID.FindStringSubmatch(resultText(b.Content)); m != nil {
			id = m[1]
		}
		delete(tasks, "use:"+b.ToolUseID)
		// The real id can already exist (a re-delivered create for a known
		// task); fold into it rather than duplicating.
		if existing, ok := tasks[id]; ok {
			existing.content = cur.content
			existing.activeForm = cur.activeForm
			existing.description = cur.description
		} else {
			tasks[id] = cur
		}
	}

	for line := range bytes.SplitSeq(data, []byte{'\n'}) {
		if len(line) == 0 || !mightMatter(line) {
			continue
		}
		var ev planLine
		if json.Unmarshal(line, &ev) != nil || ev.IsSidechain {
			continue
		}
		var blocks []planBlock
		if json.Unmarshal(ev.Message.Content, &blocks) != nil {
			continue
		}
		switch ev.Type {
		case "assistant":
			for _, b := range blocks {
				if b.Type != "tool_use" {
					continue
				}
				switch b.Name {
				case "TaskCreate":
					applyCreate(b)
				case "TaskUpdate":
					applyUpdate(b)
				case "TodoWrite":
					applyTodoWrite(b)
				}
			}
		case "user":
			for _, b := range blocks {
				if b.Type == "tool_result" && !b.IsError && b.ToolUseID != "" {
					applyResult(b)
				}
			}
		}
	}

	entries := make([]PlanEntry, 0, len(tasks))
	for key, t := range tasks {
		entries = append(entries, PlanEntry{Key: key, Content: t.content, Status: t.status, ActiveForm: t.activeForm, Description: t.description, Order: t.order})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Order < entries[j].Order })
	return entries
}

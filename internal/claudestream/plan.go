package claudestream

import (
	"bytes"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
)

// Server-side incremental tracking of the chat plan / to-do list.
//
// The chat view rebuilds the plan panel from TaskCreate/TaskUpdate/TodoWrite
// tool calls and keeps a localStorage copy - but only a browser that had the
// chat open while those calls streamed could do so. A head that ran unwatched
// ended up with no plan anywhere: the attach backfill starts megabytes past
// the creates in a byte-dense transcript, and the scroll-older page
// deliberately renders Task* calls as plain tool cards without touching the
// panel. The daemon therefore owns the durable copy: a PlanTracker rides the
// live stdout stream (RingFilter.Plan), folding each line in as it arrives,
// and the daemon persists every change to Agent.Plan - so the panel no longer
// depends on any browser having watched the run. On attach the daemon hands
// the client the persisted list in a "plan" frame; no transcript replay
// involved. (A head's earlier life under a daemon without this tracking is
// not reconstructed - accepted, only new activity needs to be accurate.)
//
// This reducer and web/src/lib/planReducer.ts must stay in lockstep; the
// mirrored rules are:
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

// planLine is the slice of a stream/transcript entry the tracker needs.
type planLine struct {
	Type        string `json:"type"`
	IsSidechain bool   `json:"isSidechain"`
	// ParentToolUseID marks a sub-agent line on live stdout (current CLIs set
	// only this, not isSidechain); a sub-agent's own task list must not leak
	// into the main plan.
	ParentToolUseID string `json:"parent_tool_use_id"`
	Message         struct {
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

var planToolMarkers = [][]byte{[]byte(`"TaskCreate"`), []byte(`"TaskUpdate"`), []byte(`"TodoWrite"`)}
var toolResultMarker = []byte(`"tool_result"`)

// PlanTracker folds stream lines into the current plan. Not safe for
// concurrent use; in the live path it runs under the session lock inside
// RingFilter.Filter, so Feed must stay cheap - a substring pre-filter skips
// JSON work for the vast majority of lines.
type PlanTracker struct {
	tasks map[string]*planTask
	seq   int
	// "todo" | "task" | "" - which planning tool currently owns the list.
	mode string
	// Create tool_use ids already folded in, so a re-delivered block (the
	// transcript can repeat a message's blocks; see reduceHistoryEvents'
	// seenBlocks note) doesn't resurrect a settled task as a pending clone.
	seenCreates map[string]bool
	// lastJSON is the marshaled entries as of the last change Feed reported,
	// "" when empty - both the Feed change signal and what JSON() returns.
	lastJSON string
	dirty    bool
}

func NewPlanTracker() *PlanTracker {
	return &PlanTracker{tasks: map[string]*planTask{}, seenCreates: map[string]bool{}}
}

// Seed restores persisted entries (Agent.Plan) into the tracker, so a resumed
// session's TaskUpdates land on tasks created before the daemon restart.
// Mirrors the client builder's seed: keys are authoritative, order caps the
// sequence, mode is inferred from the keys.
func (t *PlanTracker) Seed(planJSON string) {
	var entries []PlanEntry
	if planJSON == "" || json.Unmarshal([]byte(planJSON), &entries) != nil || len(entries) == 0 {
		return
	}
	for _, e := range entries {
		t.tasks[e.Key] = &planTask{content: e.Content, status: e.Status, activeForm: e.ActiveForm, description: e.Description, order: e.Order}
		if e.Order > t.seq {
			t.seq = e.Order
		}
	}
	t.mode = "task"
	for key := range t.tasks {
		if len(key) > 5 && key[:5] == "todo:" {
			t.mode = "todo"
			break
		}
	}
	t.lastJSON = t.marshal()
}

// JSON returns the current plan as PlanEntry JSON, "" when there is none.
func (t *PlanTracker) JSON() string {
	return t.lastJSON
}

// Feed folds one complete stream line into the plan and reports whether the
// plan changed (the caller persists on true). Lines that cannot affect the
// plan - the vast majority - are dismissed by substring checks alone.
func (t *PlanTracker) Feed(line []byte) bool {
	if len(line) == 0 || !t.mightMatter(line) {
		return false
	}
	var ev planLine
	if json.Unmarshal(line, &ev) != nil || ev.IsSidechain || ev.ParentToolUseID != "" {
		return false
	}
	var blocks []planBlock
	if json.Unmarshal(ev.Message.Content, &blocks) != nil {
		return false
	}
	switch ev.Type {
	case "assistant":
		for _, b := range blocks {
			if b.Type != "tool_use" {
				continue
			}
			switch b.Name {
			case "TaskCreate":
				t.applyCreate(b)
			case "TaskUpdate":
				t.applyUpdate(b)
			case "TodoWrite":
				t.applyTodoWrite(b)
			}
		}
	case "user":
		for _, b := range blocks {
			if b.Type == "tool_result" && !b.IsError && b.ToolUseID != "" {
				t.applyResult(b)
			}
		}
	}
	if !t.dirty {
		return false
	}
	t.dirty = false
	if j := t.marshal(); j != t.lastJSON {
		t.lastJSON = j
		return true
	}
	return false
}

// mightMatter is the cheap pre-filter: only lines carrying a planning tool
// call, or a tool_result that could carry a pending create's id, get
// JSON-decoded at all.
func (t *PlanTracker) mightMatter(line []byte) bool {
	for _, m := range planToolMarkers {
		if bytes.Contains(line, m) {
			return true
		}
	}
	if !bytes.Contains(line, toolResultMarker) {
		return false
	}
	for key := range t.tasks {
		if len(key) > 4 && key[:4] == "use:" && bytes.Contains(line, []byte(key[4:])) {
			return true
		}
	}
	return false
}

func (t *PlanTracker) applyCreate(b planBlock) {
	var in map[string]any
	if json.Unmarshal(b.Input, &in) != nil {
		return
	}
	subject, _ := optString(in, "subject")
	if subject == "" || b.ID == "" || t.seenCreates[b.ID] {
		return
	}
	t.seenCreates[b.ID] = true
	if t.mode == "todo" {
		t.tasks = map[string]*planTask{}
		t.seq = 0
	}
	t.mode = "task"
	t.seq++
	activeForm, _ := optString(in, "activeForm")
	description, _ := optString(in, "description")
	t.tasks["use:"+b.ID] = &planTask{content: subject, status: "pending", activeForm: activeForm, description: description, order: t.seq}
	t.dirty = true
}

func (t *PlanTracker) applyUpdate(b planBlock) {
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
	cur, ok := t.tasks[taskID]
	if !ok {
		return
	}
	if status, _ := optString(in, "status"); status == "deleted" {
		delete(t.tasks, taskID)
		t.dirty = true
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
	t.dirty = true
}

func (t *PlanTracker) applyTodoWrite(b planBlock) {
	var in struct {
		Todos []map[string]any `json:"todos"`
	}
	if json.Unmarshal(b.Input, &in) != nil || in.Todos == nil {
		return
	}
	next := map[string]*planTask{}
	n := 0
	for _, todo := range in.Todos {
		content, _ := optString(todo, "content")
		if content == "" {
			continue
		}
		status, _ := optString(todo, "status")
		if status != "in_progress" && status != "completed" {
			status = "pending"
		}
		activeForm, _ := optString(todo, "activeForm")
		next["todo:"+strconv.Itoa(n)] = &planTask{content: content, status: status, activeForm: activeForm, order: n + 1}
		n++
	}
	if n == 0 {
		return
	}
	t.mode = "todo"
	t.tasks = next
	t.seq = n
	t.dirty = true
}

func (t *PlanTracker) applyResult(b planBlock) {
	cur, ok := t.tasks["use:"+b.ToolUseID]
	if !ok {
		return
	}
	id := strconv.Itoa(cur.order)
	if m := taskResultID.FindStringSubmatch(resultText(b.Content)); m != nil {
		id = m[1]
	}
	delete(t.tasks, "use:"+b.ToolUseID)
	// The real id can already exist (a re-delivered create for a known task);
	// fold into it rather than duplicating.
	if existing, ok := t.tasks[id]; ok {
		existing.content = cur.content
		existing.activeForm = cur.activeForm
		existing.description = cur.description
	} else {
		t.tasks[id] = cur
	}
	t.dirty = true
}

// marshal renders the current entries as JSON, "" when empty.
func (t *PlanTracker) marshal() string {
	if len(t.tasks) == 0 {
		return ""
	}
	entries := make([]PlanEntry, 0, len(t.tasks))
	for key, task := range t.tasks {
		entries = append(entries, PlanEntry{Key: key, Content: task.content, Status: task.status, ActiveForm: task.activeForm, Description: task.description, Order: task.order})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Order < entries[j].Order })
	data, err := json.Marshal(entries)
	if err != nil {
		return ""
	}
	return string(data)
}

// ReconstructPlanFromTranscript runs a fresh tracker over in-memory transcript
// lines (feeds the simulation server and tests; the live path tracks
// incrementally via RingFilter.Plan instead).
func ReconstructPlanFromTranscript(transcript []byte) string {
	t := NewPlanTracker()
	for line := range bytes.SplitSeq(transcript, []byte{'\n'}) {
		t.Feed(line)
	}
	return t.JSON()
}

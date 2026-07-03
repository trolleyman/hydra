package http

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"

	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/heads"
	hydratests "github.com/trolleyman/hydra/internal/tests"
)

// testsWSMessage is a server→client message on the tests WebSocket. It mirrors
// artifactWSMessage but is single-sided (tests have no before/after), so a runner
// is addressed by name alone.
//   - "snapshot": the full runner list (sent on connect).
//   - "runner":   one runner's verdict changed (a run settled or was re-run).
//   - "log":      one new captured log line for a runner.
//   - "progress": the live progress header changed for a runner.
//   - "counts":   a streamed (type=stdout) run's running totals plus the cases
//     appended since the last counts message (coalesced server-side).
type testsWSMessage struct {
	Type     string               `json:"type"`
	Runners  []api.TestRunResult  `json:"runners,omitempty"`
	Runner   *api.TestRunResult   `json:"runner,omitempty"`
	Name     string               `json:"name,omitempty"`
	Line     *api.ArtifactLogLine `json:"line,omitempty"`
	Progress *string              `json:"progress,omitempty"`
	Counts   *testsWSCounts       `json:"counts,omitempty"`
}

// testsWSCounts is the "counts" payload: authoritative running totals (not
// deltas) and the newly-appended cases the client merges into its case list.
type testsWSCounts struct {
	Passed         int            `json:"passed"`
	Failed         int            `json:"failed"`
	Skipped        int            `json:"skipped"`
	Warnings       int            `json:"warnings"`
	Total          int            `json:"total"`                     // denominator, 0 = unknown
	TotalEstimated bool           `json:"total_estimated,omitempty"` // Total is an estimate from a prior run (no ::hydra:test:total::)
	Cases          []api.TestCase `json:"cases,omitempty"`
}

// testsClientMessage is a client→server message. Only "refresh" (re-run one
// runner, like the HTTP refresh param) is supported.
type testsClientMessage struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

// HandleTestsWS streams test-runner verdict updates over a WebSocket so the diff
// viewer's tests panel reflects progress, the live log and the settled verdict
// instantly instead of polling getAgentTests every 1.5s. The client may send a
// {"type":"refresh","name":..} to re-run a single runner.
// URL pattern: /ws/projects/{project_id}/agents/{id}/tests
func (s *Server) HandleTestsWS(w http.ResponseWriter, r *http.Request) {
	projectID := r.PathValue("project_id")
	agentID := r.PathValue("id")
	if agentID == "" {
		http.Error(w, "agent ID required", http.StatusBadRequest)
		return
	}
	projectRoot, err := s.resolveProjectRoot(projectID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	head, err := heads.GetHeadByID(r.Context(), s.Sessions, s.DB, projectRoot, agentID)
	if err != nil {
		http.Error(w, "failed to find agent", http.StatusInternalServerError)
		return
	}
	if head == nil {
		http.Error(w, "agent not found", http.StatusNotFound)
		return
	}

	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("tests ws: upgrade error for agent %q: %v", agentID, err)
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	q := r.URL.Query()
	var headRef *string
	if v := q.Get("head_ref"); v != "" {
		headRef = &v
	}
	includeUncommitted := q.Get("include_uncommitted") == "true"
	s.streamTests(r.Context(), conn, projectRoot, projectID, head, headRef, includeUncommitted)
}

// streamTests sends an initial snapshot, then forwards run events (log lines,
// progress, settles) until the connection closes. A client refresh message
// re-runs one runner.
func (s *Server) streamTests(ctx context.Context, conn *safeConn, projectRoot, projectID string, head *heads.Head, headRef *string, includeUncommitted bool) {
	writeMsg := func(m testsWSMessage) error {
		data, err := json.Marshal(m)
		if err != nil {
			return errtrace.Wrap(err)
		}
		return errtrace.Wrap(conn.WriteMessage(websocket.TextMessage, data))
	}

	if s.Tests == nil || head.Branch == nil {
		// Nothing to run (feature off / no branch). Send an empty snapshot and keep
		// the socket open until the client closes it.
		_ = writeMsg(testsWSMessage{Type: "snapshot", Runners: []api.TestRunResult{}})
		drainUntilClose(conn)
		return
	}

	mgr := s.Tests.Manager(projectRoot)
	v := testVersion(head, headRef, includeUncommitted)

	var runners []config.TestScript
	if liveCfg, err := config.Load(projectRoot); err == nil {
		runners = s.testRunnersFor(projectRoot, v, liveCfg)
	}
	if len(runners) == 0 {
		// No runners for this version — empty snapshot, socket stays open.
		_ = writeMsg(testsWSMessage{Type: "snapshot", Runners: []api.TestRunResult{}})
		drainUntilClose(conn)
		return
	}

	// Map each runner's on-disk entry dir back to its spec, so an incoming event
	// (keyed by dir) tells us which runner to update / rebuild.
	specByDir := map[string]config.TestScript{}
	for _, rspec := range runners {
		if d, err := mgr.EntryDir(rspec.Name, v); err == nil {
			specByDir[d] = rspec
		}
	}

	// Subscribe before building the snapshot so we don't miss an event between the
	// Get (which may kick off a run) and the subscription.
	events, unsub := mgr.Subscribe()
	defer unsub()

	// Initial snapshot. buildTestRunners triggers any needed runs, after which the
	// subscription delivers their progress/log/settle.
	if err := writeMsg(testsWSMessage{Type: "snapshot", Runners: s.buildTestRunners(projectID, mgr, runners, v)}); err != nil {
		return
	}

	// Heartbeat + read loop: handle pings and client refresh messages. Closing the
	// connection here unblocks the event loop via ctx/conn.
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	readCtx, cancelRead := context.WithCancel(ctx)
	defer cancelRead()
	go func() {
		defer cancelRead()
		for {
			msgType, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if msgType != websocket.TextMessage {
				continue
			}
			var msg testsClientMessage
			if err := json.Unmarshal(data, &msg); err != nil || msg.Type != "refresh" || msg.Name == "" {
				continue
			}
			// Discard the cached verdict and re-run; its progress/log streams back
			// via the subscription, and the settle delivers the new verdict. The
			// immediate "runner" reply flips the card to running right away.
			_ = mgr.Invalidate(msg.Name, v)
			for _, rspec := range runners {
				if rspec.Name == msg.Name {
					rep, _ := mgr.Get(rspec, v)
					_ = writeMsg(testsWSMessage{Type: "runner", Runner: ptr(buildTestRunResult(projectID, mgr, rep))})
					break
				}
			}
		}
	}()

	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-readCtx.Done():
			return
		case <-ticker.C:
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case ev, ok := <-events:
			if !ok {
				return
			}
			rspec, known := specByDir[ev.Dir]
			if !known {
				continue
			}
			switch ev.Kind {
			case "log":
				line := api.ArtifactLogLine{Text: ev.Line.Text, Stream: api.ArtifactLogLineStream(ev.Line.Stream)}
				if err := writeMsg(testsWSMessage{Type: "log", Name: rspec.Name, Line: &line}); err != nil {
					return
				}
			case "progress":
				p := ev.Progress
				if err := writeMsg(testsWSMessage{Type: "progress", Name: rspec.Name, Progress: &p}); err != nil {
					return
				}
			case "counts":
				if ev.Counts == nil {
					continue
				}
				counts := &testsWSCounts{
					Passed: ev.Counts.Passed, Failed: ev.Counts.Failed,
					Skipped: ev.Counts.Skipped, Warnings: ev.Counts.Warnings,
					Total:          ev.Counts.Total,
					TotalEstimated: ev.Counts.TotalEstimated,
					Cases:          toAPITestCases(ev.Counts.Cases),
				}
				if err := writeMsg(testsWSMessage{Type: "counts", Name: rspec.Name, Counts: counts}); err != nil {
					return
				}
			case "settled":
				rep, _ := mgr.Get(rspec, v)
				if err := writeMsg(testsWSMessage{Type: "runner", Runner: ptr(buildTestRunResult(projectID, mgr, rep))}); err != nil {
					return
				}
			}
		}
	}
}

// buildTestRunners runs (or returns the cached verdict for) each runner and maps
// it into the API shape — the snapshot equivalent of GetAgentTests's loop.
func (s *Server) buildTestRunners(projectID string, mgr *hydratests.Manager, runners []config.TestScript, v hydratests.Version) []api.TestRunResult {
	out := make([]api.TestRunResult, 0, len(runners))
	for _, rspec := range runners {
		rep, err := mgr.Get(rspec, v)
		if err != nil {
			out = append(out, api.TestRunResult{Name: rspec.Name, Status: api.TestStatusErrored, Error: ptr(err.Error())})
			continue
		}
		out = append(out, buildTestRunResult(projectID, mgr, rep))
	}
	return out
}

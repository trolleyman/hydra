package http

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"time"

	"braces.dev/errtrace"
	"github.com/gorilla/websocket"
	"github.com/trolleyman/hydra/internal/api"
	"github.com/trolleyman/hydra/internal/artifacts"
	"github.com/trolleyman/hydra/internal/heads"
)

// metaHasFile reports whether a meta already carries a file of the given name.
func metaHasFile(m artifacts.Meta, name string) bool {
	for _, f := range m.Files {
		if f.Name == name {
			return true
		}
	}
	return false
}

// artifactWSMessage is a server→client message on the artifacts WebSocket.
//   - "snapshot": the full set list (sent on connect and after a reconnect).
//   - "set":      one script's set changed (a generation settled or was refreshed).
//   - "log":      one new captured log line for one side ("left"/"right") of a script.
//   - "progress": the header progress line changed for one side of a script.
//   - "file":     one output file finished and was compared (a FileMarker fired),
//     carried in File - so the client can render/diff that tile before the run
//     ends. The client upserts it into the set by name; the authoritative "set"
//     at settle reconciles the full list.
type artifactWSMessage struct {
	Type     string               `json:"type"`
	Scripts  []api.ArtifactSet    `json:"scripts,omitempty"`
	Set      *api.ArtifactSet     `json:"set,omitempty"`
	Script   string               `json:"script,omitempty"`
	Side     string               `json:"side,omitempty"`
	Line     *api.ArtifactLogLine `json:"line,omitempty"`
	Progress *string              `json:"progress,omitempty"`
	File     *api.ArtifactFile    `json:"file,omitempty"`
}

// artifactClientMessage is a client→server message. Only "refresh" (regenerate
// one script, like the HTTP refresh param) is supported. An optional side
// ("left"/"right") regenerates just that side, leaving the other side cached.
type artifactClientMessage struct {
	Type   string `json:"type"`
	Script string `json:"script"`
	Side   string `json:"side,omitempty"`
}

// HandleArtifactsWS streams artifact set updates over a WebSocket so the diff
// viewer's artifacts panel can reflect generation progress and the live log
// instantly, instead of polling. The client may send a {"type":"refresh"} to
// regenerate a single script.
// URL pattern: /ws/projects/{project_id}/agents/{id}/artifacts
func (s *Server) HandleArtifactsWS(w http.ResponseWriter, r *http.Request) {
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
		log.Printf("artifacts ws: upgrade error for agent %q: %v", agentID, err)
		return
	}
	conn := &safeConn{Conn: rawConn}
	defer conn.Close()

	params := artifactParamsFromQuery(r.URL.Query())
	s.streamArtifacts(r.Context(), conn, projectRoot, projectID, head, params)
}

// artifactParamsFromQuery parses the same query parameters the HTTP artifacts
// endpoint accepts, so the WS comparison matches what a poll would return.
func artifactParamsFromQuery(q url.Values) api.GetAgentArtifactsParams {
	var params api.GetAgentArtifactsParams
	if v := q.Get("base_ref"); v != "" {
		params.BaseRef = &v
	}
	if v := q.Get("head_ref"); v != "" {
		params.HeadRef = &v
	}
	if q.Get("include_uncommitted") == "true" {
		t := true
		params.IncludeUncommitted = &t
	}
	return params
}

// streamArtifacts sends an initial snapshot, then forwards generation events
// (log lines, settles) until the connection closes. A client refresh message
// regenerates one script.
func (s *Server) streamArtifacts(ctx context.Context, conn *safeConn, projectRoot, projectID string, head *heads.Head, params api.GetAgentArtifactsParams) {
	writeMsg := func(m artifactWSMessage) error {
		data, err := json.Marshal(m)
		if err != nil {
			return errtrace.Wrap(err)
		}
		return errtrace.Wrap(conn.WriteMessage(websocket.TextMessage, data))
	}

	plan, err := s.resolveArtifactPlan(projectRoot, head, params)
	if err != nil || plan == nil {
		// Nothing to compare (no artifacts configured, etc.). Send an empty
		// snapshot and keep the socket open until the client closes it.
		_ = writeMsg(artifactWSMessage{Type: "snapshot", Scripts: []api.ArtifactSet{}})
		drainUntilClose(conn)
		return
	}

	// Map each side's on-disk entry dir back to its script name AND which side it
	// is, so an incoming event (keyed by dir) tells us which set to rebuild and -
	// for log/progress - which side's pane to update. Left and right have distinct
	// entry dirs, so their logs stay separate (no interleaving into one stream).
	type dirRef struct{ script, side string }
	dirToRef := map[string]dirRef{}
	for _, name := range plan.names {
		leftSpec, rightSpec := plan.specsFor(name)
		if leftSpec != nil {
			if d, err := plan.mgr.EntryDir(name, plan.left); err == nil {
				dirToRef[d] = dirRef{script: name, side: "left"}
			}
		}
		if rightSpec != nil {
			if d, err := plan.mgr.EntryDir(name, plan.right); err == nil {
				dirToRef[d] = dirRef{script: name, side: "right"}
			}
		}
	}

	// Subscribe before building the snapshot so we don't miss an event between the
	// Get (which may kick off generation) and the subscription.
	events, unsub := plan.mgr.Subscribe()
	defer unsub()

	// Initial snapshot. buildSets triggers any needed generations, after which the
	// subscription delivers their progress.
	if err := writeMsg(artifactWSMessage{Type: "snapshot", Scripts: plan.buildSets(s, projectID)}); err != nil {
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
			var msg artifactClientMessage
			if err := json.Unmarshal(data, &msg); err != nil || msg.Type != "refresh" || msg.Script == "" {
				continue
			}
			// Drop the cached result and rebuild - this restarts the generation,
			// and its progress streams back via the subscription. An optional side
			// ("left"/"right") restarts just that side, keeping the other cached.
			plan.invalidateSide(msg.Script, msg.Side)
			set := plan.buildSet(s, projectID, msg.Script)
			_ = writeMsg(artifactWSMessage{Type: "set", Set: &set})
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
			ref, known := dirToRef[ev.Dir]
			if !known {
				continue
			}
			switch ev.Kind {
			case "log":
				line := api.ArtifactLogLine{Text: ev.Line.Text, Stream: api.ArtifactLogLineStream(ev.Line.Stream)}
				if err := writeMsg(artifactWSMessage{Type: "log", Script: ref.script, Side: ref.side, Line: &line}); err != nil {
					return
				}
			case "progress":
				p := ev.Progress
				if err := writeMsg(artifactWSMessage{Type: "progress", Script: ref.script, Side: ref.side, Progress: &p}); err != nil {
					return
				}
			case "file":
				// One output file finished on ref.side. Diff and stream just that tile
				// - but only once its verdict is knowable: the OTHER side has the file
				// too (a real modified/unchanged compare), or has already settled
				// without it (a genuine added/removed). When the other side is still
				// generating and hasn't produced this file yet we hold off; its own
				// file event (or the authoritative "set" at settle) delivers the
				// verdict later, so each file is compared and sent exactly once.
				left, right := plan.metasFor(ref.script)
				other := right
				if ref.side == "right" {
					other = left
				}
				name := ev.File.Name
				if !metaHasFile(other, name) && other.Status == artifacts.StatusGenerating {
					continue
				}
				delta, ok := plan.mgr.CompareFile(left, right, name)
				if !ok {
					continue
				}
				f := artifactFileFromDelta(projectID, ref.script, left.Key, right.Key, delta)
				if err := writeMsg(artifactWSMessage{Type: "file", Script: ref.script, File: &f}); err != nil {
					return
				}
			case "settled":
				set := plan.buildSet(s, projectID, ref.script)
				if err := writeMsg(artifactWSMessage{Type: "set", Set: &set}); err != nil {
					return
				}
			}
		}
	}
}

// drainUntilClose reads (and discards) until the peer closes the connection, so
// an idle WS with nothing to stream still honors close/ping handling.
func drainUntilClose(conn *safeConn) {
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}

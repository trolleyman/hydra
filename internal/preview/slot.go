package preview

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"braces.dev/errtrace"

	"github.com/trolleyman/hydra/internal/config"
	"github.com/trolleyman/hydra/internal/git"
)

// slot is the one visible server per (project, script, head). It owns the
// stable proxy listener/port and forwards requests to whichever backing
// instance is its front - `active` once a server is up, or `pending` during a
// cold start. Switching the selected channel replaces `active`; a branch-tip
// move builds a `pending` in the background and hot-swaps it in when ready, so
// the URL and port survive across rebuilds.
type slot struct {
	mgr    *Manager
	root   string
	name   string // script name
	headID string
	key    string

	ln   net.Listener
	srv  *http.Server
	port int

	mu      sync.Mutex
	spec    config.PreviewScript
	active  *instance // front once running; may be starting (cold start) or nil transiently
	pending *instance // building in the background for a tip hot-swap
}

// front returns the instance that should currently handle requests: the active
// server, or the pending one during a cold start before any active exists.
// Caller must NOT hold s.mu.
func (s *slot) front() *instance {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil {
		return s.active
	}
	return s.pending
}

// status snapshots the slot's front server, stamped with the slot's proxy port.
func (s *slot) status() Status {
	front := s.front()
	if front == nil {
		return Status{Name: s.name, State: StateStopped}
	}
	st := front.status()
	st.Port = s.port
	return st
}

// serveHTTP is the slot listener's handler: forward to the front instance,
// which does auth, the reserved status endpoint, lazy spawn, the loading page,
// and the reverse proxy with in-flight accounting.
func (s *slot) serveHTTP(w http.ResponseWriter, r *http.Request) {
	front := s.front()
	if front == nil {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "preview not started, retry", http.StatusServiceUnavailable)
		return
	}
	front.serveHTTP(w, r)
}

// retarget points the slot at the channel the selected version names. When the
// channel is unchanged the current server is kept (a tip whose SHA moved is
// rebuilt in the background, not here); a different channel swaps the backing
// server. If start is set (an explicit Start/Open) the front server is spawned.
func (s *slot) retarget(spec config.PreviewScript, v Version, start bool) error {
	desired := v.channelID()

	s.mu.Lock()
	s.spec = spec
	if s.active != nil {
		s.active.setSpec(spec)
	}
	if s.pending != nil {
		s.pending.setSpec(spec)
	}

	var toReap []*instance
	switch {
	case s.active == nil:
		in, err := s.newInstance(spec, v)
		if err != nil {
			s.mu.Unlock()
			return errtrace.Wrap(err)
		}
		s.active = in
	case s.active.channel == desired:
		// Right channel already. Drop any pending build for a superseded target.
		if s.pending != nil && s.pending.channel != desired {
			toReap = append(toReap, s.pending)
			s.pending = nil
		}
	default:
		// Manual channel switch (worktree <-> commit, or a different pin): show
		// the newly selected version by swapping the backing server outright.
		// There is one visible server per script, so the old one is torn down.
		in, err := s.newInstance(spec, v)
		if err != nil {
			s.mu.Unlock()
			return errtrace.Wrap(err)
		}
		toReap = append(toReap, s.active)
		if s.pending != nil {
			toReap = append(toReap, s.pending)
			s.pending = nil
		}
		s.active = in
	}
	active := s.active
	s.mu.Unlock()

	for _, in := range toReap {
		go in.teardown()
	}
	if start && active != nil {
		active.ensureStarted()
	}
	// A tip whose SHA moved between selections gets its background rebuild kicked
	// off now rather than waiting for the next reaper tick.
	s.followTip()
	return nil
}

// followTip starts a background rebuild + hot-swap when the slot's running
// active server tracks a branch tip that has since moved. No-op for pinned
// commits, worktree channels, a server that isn't up, or while a pending build
// is already in flight.
func (s *slot) followTip() {
	s.mu.Lock()
	active := s.active
	if active == nil || s.pending != nil {
		s.mu.Unlock()
		return
	}
	branch := active.version.Branch
	curSHA := active.version.SHA
	if branch == "" || active.channel != "tip:"+branch {
		s.mu.Unlock()
		return
	}
	active.mu.Lock()
	up := active.state == StateRunning
	active.mu.Unlock()
	spec := s.spec
	s.mu.Unlock()
	if !up {
		return
	}

	newSHA, err := git.ResolveRef(s.root, branch)
	if err != nil || newSHA == "" || newSHA == curSHA {
		return
	}

	s.mu.Lock()
	// Re-check under lock: nothing changed the active server or started a build
	// while we resolved the ref.
	if s.active != active || s.pending != nil {
		s.mu.Unlock()
		return
	}
	p, err := s.newInstance(spec, Version{HeadID: s.headID, SHA: newSHA, Branch: branch})
	if err != nil {
		s.mu.Unlock()
		return
	}
	s.pending = p
	s.mu.Unlock()

	p.ensureStarted()
	go s.awaitSwap(p)
}

// awaitSwap waits for a pending build to become ready, then promotes it to
// active (reaping the old server). A pending that fails is discarded and the
// old server keeps serving - a broken new tip should not take down a working
// preview.
func (s *slot) awaitSwap(p *instance) {
	for {
		p.mu.Lock()
		state := p.state
		ready := p.readyCh
		p.mu.Unlock()
		switch state {
		case StateRunning:
			s.promote(p)
			return
		case StateError, StateStopped:
			s.mu.Lock()
			superseded := s.pending != p
			if !superseded {
				s.pending = nil
			}
			s.mu.Unlock()
			go p.teardown()
			return
		}
		if ready != nil {
			<-ready
		} else {
			time.Sleep(100 * time.Millisecond)
		}
	}
}

// promote makes the ready pending server the active one and reaps the old.
func (s *slot) promote(p *instance) {
	s.mu.Lock()
	if s.pending != p {
		s.mu.Unlock()
		go p.teardown() // superseded (e.g. a channel switch) - drop it
		return
	}
	old := s.active
	s.active = p
	s.pending = nil
	s.mu.Unlock()
	if old != nil && old != p {
		go old.teardown()
	}
}

// newInstance builds a backing instance for a version, always in its own
// ephemeral detached checkout under the preview scratch dir - so even the
// worktree channel builds without racing or polluting the agent's live
// workspace. Caller holds s.mu. The checkout path includes the head so two
// heads previewing the same script/commit don't collide.
func (s *slot) newInstance(spec config.PreviewScript, v Version) (*instance, error) {
	in := &instance{
		mgr:        s.mgr,
		root:       s.root,
		spec:       spec,
		version:    v,
		channel:    v.channelID(),
		state:      StateStopped,
		lastActive: time.Now(),
	}
	// The base commit the checkout is created at: HEAD of the live worktree for
	// the worktree channel (its uncommitted changes are then mirrored in), or
	// the pinned/tip SHA otherwise.
	baseSHA := v.SHA
	if v.WorktreeDir != "" {
		sha, err := git.ResolveRef(v.WorktreeDir, "HEAD")
		if err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("resolve worktree HEAD: %w", err))
		}
		baseSHA = sha
		in.syncFrom = v.WorktreeDir
		in.syncBaseSHA = sha
	}

	suffix := shortSHA(v.SHA)
	if v.WorktreeDir != "" {
		suffix = "worktree"
	}
	dir := filepath.Join(previewDir(s.root), "checkouts", spec.Name+"-"+s.headID+"-"+suffix)
	// Defensively clear any stale worktree at the path before adding.
	_ = git.RemoveWorktree(s.root, dir)
	_ = os.RemoveAll(dir)
	if err := git.AddDetachedWorktree(s.root, dir, baseSHA); err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("materialize preview checkout: %w", err))
	}
	in.runDir = dir
	in.ownsCheckout = true
	return in, nil
}

// teardown disposes of the slot: both backing servers killed, checkouts
// removed, and the listener closed. The slot must already be out of the map.
func (s *slot) teardown() {
	s.mu.Lock()
	active := s.active
	pending := s.pending
	s.active = nil
	s.pending = nil
	s.mu.Unlock()
	if active != nil {
		active.teardown()
	}
	if pending != nil {
		pending.teardown()
	}
	_ = s.srv.Close()
}

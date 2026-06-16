// Package nshost implements a "namespace host": a single sandbox (one bwrap on
// Linux) whose pid-1 is a small supervisor that spawns further PTY-attached
// child processes on demand and hands their master fds back out to the daemon.
//
// Why: every child of that one supervisor shares the supervisor's mount
// namespace, and therefore the single copy-on-write overlay set up by that one
// bwrap. Two processes writing one overlay mount is fine; the corruption hazard
// is only two *separate* overlay mounts sharing an upperdir. So routing both the
// agent and its bash terminals through one supervisor lets them share a single
// writable COW path — something the "one bwrap per session" model can't do
// safely (see internal/heads/cow.go).
//
// The daemon side (Client) dials the supervisor's control socket; each spawn
// gets its own connection that carries the request, the returned PTY master fd
// (via SCM_RIGHTS), later signal requests, and the final exit notification.
package nshost

// SpawnRequest asks the supervisor to launch one PTY-attached child. All paths
// are resolved in the supervisor's (sandboxed) view of the filesystem.
type SpawnRequest struct {
	Argv []string `json:"argv"`
	Env  []string `json:"env"`
	Cwd  string   `json:"cwd"`
	Rows uint16   `json:"rows"`
	Cols uint16   `json:"cols"`
}

// spawnReply is the supervisor's answer to a SpawnRequest. When OK, the same
// message carries the child's PTY master fd as an SCM_RIGHTS control message.
type spawnReply struct {
	OK  bool   `json:"ok"`
	Pid int    `json:"pid"`
	Err string `json:"err,omitempty"`
}

// control is a daemon->supervisor message sent after a successful spawn (e.g. to
// deliver a signal to the child).
type control struct {
	Signal int `json:"signal,omitempty"`
}

// event is a supervisor->daemon message reporting child lifecycle.
type event struct {
	Exited   bool `json:"exited"`
	ExitCode int  `json:"exitCode"`
}

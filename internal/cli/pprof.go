package cli

import (
	"log"
	"net/http"
	"net/http/pprof"
	"os"
)

// PprofEnv is the environment variable that mounts Go's runtime profiler on the
// web server. Any non-empty value enables it.
const PprofEnv = "HYDRA_PPROF"

// registerPprof mounts net/http/pprof under /debug/pprof/ when PprofEnv is set.
//
// It exists because the daemon is otherwise a black box from the outside, and
// the questions worth asking about it - what is doing all this disk IO, where is
// everything blocked during a freeze - are exactly the ones a goroutine profile
// answers in one request. The alternatives are all worse: SIGQUIT dumps every
// stack but kills the daemon (taking the running heads, and the evidence, with
// it), and strace/perf/bpftrace need root here (ptrace_scope=1,
// perf_event_paranoid=4) and charge a real overhead on a busy process.
//
// Off by default, and deliberately not a config field. A profile is a snapshot
// of the process's internals - goroutine stacks carry function names and
// arguments, the heap profile carries allocation sites - so this is a debugging
// tool you turn on for a session, not a setting to leave on. Being registered on
// the same mux as everything else, it sits behind the same auth gate (localhost
// is trusted; anything else needs the key), so enabling it does not expose the
// server further than it already is.
//
// Useful once enabled - all against the web address, e.g. localhost:26600:
//
//	/debug/pprof/goroutine?debug=2   every goroutine's stack, the SIGQUIT dump
//	                                 without the dying. This is the one for a
//	                                 hang: whatever the daemon is stuck behind
//	                                 appears at the top of hundreds of stacks.
//	/debug/pprof/profile?seconds=30  30s CPU profile (go tool pprof)
//	/debug/pprof/heap                live allocations by site
//	/debug/pprof/block               where goroutines block, but only if
//	                                 runtime.SetBlockProfileRate was called - it
//	                                 is not, so this reads empty by design
func registerPprof(mux *http.ServeMux) {
	if os.Getenv(PprofEnv) == "" {
		return
	}
	// Index dispatches every named runtime profile (goroutine, heap, allocs,
	// threadcreate, ...); the other four are its own handlers and are not
	// reachable through it.
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	log.Printf("pprof enabled (%s is set): /debug/pprof/ - goroutine?debug=2 is the one for a hang", PprofEnv)
}

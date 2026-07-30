package config

// Which events wake a head with a short message.
//
// Its own section rather than switches scattered through [review] and [tests]:
// the list of things that can notify keeps growing (comments published, a comment
// resolved, a test gone red, and a forge reviewer one day), and one place to look
// is worth more than each switch sitting next to the feature it came from.
//
// Every one of these costs a model turn, which is why each is a deliberate choice
// rather than something Hydra does because it can. See docs/review-agent.md for
// the four rules they all follow.

// NotifyConfig is the [notify] table.
type NotifyConfig struct {
	// TestFailures wakes the head when one of its test runners settles FAILING.
	//
	// On by default, which is only safe because of the gate: it fires solely while
	// the head is IDLE, so it cannot interrupt a turn, and it is deduped per
	// (runner, commit), so re-running the same red suite is silent. The message is
	// one line naming the runner - the agent pulls the detail with get_test_logs,
	// a tool it already has - so a failure costs one turn, not a transcript full
	// of log. nil = on.
	TestFailures *bool `toml:"test_failures"`
}

// NotifyTestFailures reports whether a failing test run should wake the head.
func (c *Config) NotifyTestFailures() bool {
	if c == nil || c.Notify == nil || c.Notify.TestFailures == nil {
		return true
	}
	return *c.Notify.TestFailures
}

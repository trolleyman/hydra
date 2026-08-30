package config

import "testing"

// The default is OFF, and it has to survive every way of not saying anything -
// no [notify] table at all, an empty one, or a layer that sets something else.
func TestNotifyTestFailuresDefaultsOff(t *testing.T) {
	var nilCfg *Config
	if nilCfg.NotifyTestFailures() {
		t.Error("a nil config should not notify (the default is off)")
	}
	if (&Config{}).NotifyTestFailures() {
		t.Error("no [notify] table should leave notifications off")
	}
	if (&Config{Notify: &NotifyConfig{}}).NotifyTestFailures() {
		t.Error("an empty [notify] table should leave notifications off")
	}
	off := false
	if (&Config{Notify: &NotifyConfig{TestFailures: &off}}).NotifyTestFailures() {
		t.Error("test_failures = false should silence it")
	}
	on := true
	if !(&Config{Notify: &NotifyConfig{TestFailures: &on}}).NotifyTestFailures() {
		t.Error("test_failures = true should notify")
	}
}

// [notify] merges field-by-field like the other pointer sections, so a local
// layer turning it off does not wipe anything else the table grows later.
func TestNotifyMergesAcrossLayers(t *testing.T) {
	off := false
	base := &Config{}
	base.Merge(Config{Notify: &NotifyConfig{TestFailures: &off}})
	if base.Notify == nil || base.NotifyTestFailures() {
		t.Fatalf("a later layer did not turn notifications off: %+v", base.Notify)
	}
	// And a layer that says nothing about notify leaves the earlier answer alone.
	base.Merge(Config{})
	if base.NotifyTestFailures() {
		t.Error("a layer with no [notify] table reset the explicit off setting")
	}
}

package reviewstore

import "testing"

func TestParseMentions(t *testing.T) {
	cases := []struct {
		body           string
		head, reviewer bool
		why            string
	}{
		{"please fix this", true, false, "no mention addresses the head, exactly as before mentions existed"},
		{"", true, false, "an empty body still has a default audience"},
		{"@agent please fix this", true, false, "explicit head"},
		{"@head please fix this", true, false, "head, spelled the other way"},
		{"@review what do you think?", false, true, "the reviewer INSTEAD of the head - the point of the feature"},
		{"@reviewer what do you think?", false, true, "the other spelling of the same idea"},
		{"@agent fix it, @review sanity-check it", true, true, "both"},
		{"mail me at bob@review.example.com", true, false, "an email address is not a summons"},
		{"see foo@reviewer", true, false, "a mention needs a word boundary before the @"},
		{"the @reviewers were unhappy", true, false, "a longer word is not the token"},
		{"`@review` in a code span still counts", false, true, "we do not parse markdown - a mention is a mention"},
	}
	for _, c := range cases {
		got := ParseMentions(c.body)
		if got.Head != c.head || got.Reviewer != c.reviewer {
			t.Errorf("ParseMentions(%q) = %+v, want head=%v reviewer=%v (%s)", c.body, got, c.head, c.reviewer, c.why)
		}
	}
}

// The highlighter paints exactly what the parser reads. A token painted but not
// routed (or routed but not painted) is worse than no highlighting at all.
func TestMentionTokensMatchTheParser(t *testing.T) {
	for _, tok := range MentionTokens {
		if m := ParseMentions("hello " + tok + " there"); !m.Head && !m.Reviewer {
			t.Errorf("%q is highlighted but routes nowhere", tok)
		}
		if m := ParseMentions("hello " + tok + " there"); m == (Mentions{Head: true}) && tok != "@agent" && tok != "@head" {
			t.Errorf("%q is highlighted but only reaches the default audience", tok)
		}
	}
}

package reviewstore

// Who a review comment is addressed to.
//
// A head can have two agents working on the same diff - itself and its reviewer -
// so a comment needs to be able to say which one it is for. `@review` does that;
// everything else keeps the behaviour Hydra has always had, which is that a
// comment is for the head.
//
// The default is the important part. "No mention means the head" keeps every
// existing gesture working - you write a comment, submit the review, the head is
// told - while making the reviewer addressable for the first time. The explicit
// `@agent` is redundant with that default and exists anyway, because once two
// agents are in play "who am I talking to" is worth being able to say out loud
// rather than leaving to a rule you have to remember.

import "regexp"

// Mentions is the audience for one comment. Both can be true (a comment naming
// each of them); Head is true by default.
type Mentions struct {
	Head     bool
	Reviewer bool
}

// mentionRe matches a mention token at a word boundary, so an email address, a Go
// build tag or `foo@review.example.com` is not a summons. The leading group keeps
// the character before it out of the match.
//
// `@reviewer` is accepted alongside `@review` on purpose: the slot is `@review`
// (matching the session id, the tab and the config section) but "reviewer" is what
// people call a person, and making someone guess between two spellings of the same
// idea is a worse failure than accepting both.
var mentionRe = regexp.MustCompile(`(^|[^\w@/.-])@(agent|head|review|reviewer)\b`)

// ParseMentions reads a comment body's audience.
//
// An empty or mention-free body addresses the head, which is what makes this safe
// to run over every comment: the answer for the overwhelming majority is "the head",
// exactly as before mentions existed.
func ParseMentions(body string) Mentions {
	var m Mentions
	for _, match := range mentionRe.FindAllStringSubmatch(body, -1) {
		switch match[2] {
		case "agent", "head":
			m.Head = true
		case "review", "reviewer":
			m.Reviewer = true
		}
	}
	// No mention at all: the head, as it has always been. Note this is NOT the same
	// as "@review means also the head" - naming the reviewer and nobody else is a
	// deliberate way to ask a question the head should not be interrupted by.
	if !m.Head && !m.Reviewer {
		m.Head = true
	}
	return m
}

// MentionTokens are the words ParseMentions recognises, for the editor's
// highlighter. Exported so the two cannot drift: a token the box paints and the
// parser ignores is worse than no highlighting at all.
var MentionTokens = []string{"@agent", "@head", "@review", "@reviewer"}

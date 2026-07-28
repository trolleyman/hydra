package forge

import (
	"context"
	"strings"
	"testing"
)

func TestGithubThreads(t *testing.T) {
	const graphql = `{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[
	  {"isResolved":false,"isOutdated":false,"path":"a.go","line":12,"originalLine":12,
	   "comments":{"nodes":[
	     {"databaseId":101,"body":"rename this","url":"https://gh/pr/7#d101","createdAt":"2026-07-28T09:00:00Z","author":{"login":"alice"}},
	     {"databaseId":102,"body":"agreed","url":"https://gh/pr/7#d102","createdAt":"2026-07-28T09:05:00Z","author":{"login":"bob"}}]}},
	  {"isResolved":true,"isOutdated":true,"path":"b.go","line":null,"originalLine":4,
	   "comments":{"nodes":[{"databaseId":103,"body":"done","url":"https://gh/pr/7#d103","createdAt":"2026-07-28T08:00:00Z","author":{"login":"alice"}}]}},
	  {"isResolved":false,"path":"c.go","line":1,"comments":{"nodes":[]}}]}}}}}`
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "repo view") {
			return "org/repo\n", nil
		}
		return graphql, nil
	}}
	p := &githubProvider{run: f.run}

	threads, err := p.Threads(context.Background(), "/repo", "origin", "7")
	if err != nil {
		t.Fatalf("Threads: %v", err)
	}
	// The comment-less thread is dropped: it has nothing to show or reply to.
	if len(threads) != 2 {
		t.Fatalf("got %d threads, want 2: %+v", len(threads), threads)
	}
	first := threads[0]
	// GitHub replies address the ROOT comment's REST id, so that is the handle.
	if first.ID != "101" {
		t.Errorf("thread id = %q, want the root comment id 101", first.ID)
	}
	if first.Path != "a.go" || first.Line != 12 || first.Resolved {
		t.Errorf("thread anchor/resolution wrong: %+v", first)
	}
	if len(first.Notes) != 2 || first.Notes[1].Author != "bob" {
		t.Errorf("notes wrong: %+v", first.Notes)
	}
	// An outdated thread's `line` is null; originalLine still says where it was
	// written, which is the only thing the diff viewer can match on.
	if second := threads[1]; second.Line != 4 || !second.Outdated || !second.Resolved {
		t.Errorf("outdated thread = %+v, want line 4, outdated, resolved", second)
	}
}

func TestGithubReplyAndCommentArgv(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		switch {
		case strings.Contains(cmd, "repo view"):
			return "org/repo\n", nil
		case strings.Contains(cmd, "-q .head.sha"):
			return "abc123\n", nil
		}
		return "{}", nil
	}}
	p := &githubProvider{run: f.run}

	if err := p.ReplyToThread(context.Background(), "/repo", "origin", "7", "101", "thanks"); err != nil {
		t.Fatalf("ReplyToThread: %v", err)
	}
	if !hasCall(f.calls, "repos/org/repo/pulls/7/comments/101/replies") {
		t.Errorf("reply did not POST to the thread's replies endpoint: %v", f.calls)
	}

	if err := p.CommentOnLine(context.Background(), "/repo", "origin", "7", NewLineComment{Path: "a.go", Line: 12, Body: "hi"}); err != nil {
		t.Fatalf("CommentOnLine: %v", err)
	}
	// GitHub rejects a new review comment without the commit it applies to.
	if !hasCall(f.calls, "commit_id=abc123") || !hasCall(f.calls, "side=RIGHT") {
		t.Errorf("new comment missing commit_id/side: %v", f.calls)
	}

	// An empty body never reaches the forge.
	if err := p.ReplyToThread(context.Background(), "/repo", "origin", "7", "101", "  "); err == nil {
		t.Error("empty reply should be rejected locally")
	}
}

func TestGitlabThreads(t *testing.T) {
	const discussions = `[
	  {"id":"d1","notes":[
	    {"id":1,"body":"drop this","system":false,"resolved":false,"created_at":"2026-07-28T09:00:00Z","author":{"username":"alice"},"position":{"new_path":"a.go","new_line":12}},
	    {"id":2,"body":"ok","system":false,"resolved":false,"created_at":"2026-07-28T09:02:00Z","author":{"username":"bob"}}]},
	  {"id":"d2","notes":[{"id":3,"body":"added 1 commit","system":true,"author":{"username":"alice"}}]},
	  {"id":"d3","notes":[{"id":4,"body":"fixed","system":false,"resolved":true,"created_at":"2026-07-28T08:00:00Z","author":{"username":"alice"},"position":{"new_path":"b.go","new_line":3}}]}]`
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "/discussions") {
			return discussions, nil
		}
		return `{"web_url":"https://gl/mr/42"}`, nil
	}}
	p := &gitlabProvider{run: f.run}

	threads, err := p.Threads(context.Background(), "/repo", "origin", "42")
	if err != nil {
		t.Fatalf("Threads: %v", err)
	}
	// The system-note-only discussion is dropped ("added 1 commit" is not a
	// conversation).
	if len(threads) != 2 {
		t.Fatalf("got %d threads, want 2: %+v", len(threads), threads)
	}
	if threads[0].ID != "d1" || threads[0].Path != "a.go" || threads[0].Line != 12 {
		t.Errorf("first thread = %+v, want d1 a.go:12", threads[0])
	}
	if len(threads[0].Notes) != 2 || threads[0].Notes[0].URL != "https://gl/mr/42#note_1" {
		t.Errorf("notes/deep link wrong: %+v", threads[0].Notes)
	}
	// Resolution is per-note on GitLab but is really a thread property.
	if !threads[1].Resolved {
		t.Errorf("thread with a resolved note should be resolved: %+v", threads[1])
	}
}

func TestGitlabCommentNeedsDiffRefs(t *testing.T) {
	f := &fakeRunner{response: func(cmd string) (string, error) {
		if strings.Contains(cmd, "-X POST") {
			return "{}", nil
		}
		return `{"diff_refs":{"base_sha":"b1","start_sha":"s1","head_sha":"h1"}}`, nil
	}}
	p := &gitlabProvider{run: f.run}
	if err := p.CommentOnLine(context.Background(), "/repo", "origin", "42", NewLineComment{Path: "a.go", Line: 12, Body: "hi"}); err != nil {
		t.Fatalf("CommentOnLine: %v", err)
	}
	for _, want := range []string{"position[base_sha]=b1", "position[head_sha]=h1", "position[new_line]=12"} {
		if !hasCall(f.calls, want) {
			t.Errorf("positioned discussion missing %q: %v", want, f.calls)
		}
	}
}

func TestUnresolvedDiscussionsFlattening(t *testing.T) {
	threads := []Thread{
		{ID: "1", Path: "a.go", Line: 3, URL: "https://x/1", Notes: []Note{{Author: "a", Body: "one"}, {Author: "b", Body: "two", URL: "https://x/1#2"}}},
		{ID: "2", Path: "b.go", Resolved: true, Notes: []Note{{Author: "a", Body: "settled"}}},
	}
	got := UnresolvedDiscussions(threads)
	if len(got) != 2 {
		t.Fatalf("got %d discussions, want 2 (resolved thread excluded): %+v", len(got), got)
	}
	if got[0].ID != "1" || got[0].Path != "a.go" || got[0].Line != 3 {
		t.Errorf("discussion lost its thread anchor: %+v", got[0])
	}
	// A note's own URL wins so a reply deep-links to itself, not the thread root.
	if got[1].URL != "https://x/1#2" {
		t.Errorf("note URL = %q, want the note's own", got[1].URL)
	}
}

func hasCall(calls []string, substr string) bool {
	for _, c := range calls {
		if strings.Contains(c, substr) {
			return true
		}
	}
	return false
}

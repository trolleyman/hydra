package git

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"braces.dev/errtrace"
)

// CommitInfo contains information about a single git commit.
type CommitInfo struct {
	SHA         string
	ShortSHA    string
	Message     string
	Subject     string
	AuthorName  string
	AuthorEmail string
	Timestamp   string
	// Parents holds the full SHAs of this commit's parents. A commit with two or
	// more parents is a merge; callers use this to collapse a merge (which drags
	// in every commit from the merged-in branch) into a single summary entry.
	Parents []string
}

// IsMerge reports whether the commit has more than one parent.
func (c CommitInfo) IsMerge() bool { return len(c.Parents) > 1 }

// DiffLineType describes the type of a diff line.
type DiffLineType string

const (
	DiffLineContext   DiffLineType = "context"
	DiffLineAddition  DiffLineType = "addition"
	DiffLineDeletion  DiffLineType = "deletion"
	DiffLineNoNewline DiffLineType = "no_newline"
)

// DiffLine represents one line in a diff hunk.
type DiffLine struct {
	Type       DiffLineType
	Content    string
	OldLineNum *int
	NewLineNum *int
}

// DiffHunk represents a single @@ ... @@ hunk in a diff.
type DiffHunk struct {
	Header   string
	OldStart int
	NewStart int
	Lines    []DiffLine
}

// DiffFile represents one file's worth of diff information.
type DiffFile struct {
	Path       string
	OldPath    *string // non-nil for renamed files
	ChangeType string  // added | modified | deleted | renamed
	Additions  int
	Deletions  int
	Binary     bool
	Hunks      []DiffHunk
	// Expanded is set by the full-context view when Hunks hold the file's entire
	// content (a single whole-file hunk) rather than the default windowed context,
	// so the client can render the reveal/collapse model without re-fetching.
	Expanded bool
}

// UncommittedSummary holds counts of uncommitted changes.
type UncommittedSummary struct {
	TrackedCount   int
	UntrackedCount int
}

// gitLogFormat uses ASCII control characters as separators to avoid collisions
// with commit message content. %x1e = record separator, %x1f = field separator.
// %B (raw body) stays last so an embedded separator in the message can't shift
// the other fields. %P (parent hashes, space-separated) precedes it.
const gitLogFormat = "--format=%x1e%H%x1f%aN%x1f%aE%x1f%aI%x1f%P%x1f%B"

func parseCommitRecord(record string) (CommitInfo, bool) {
	record = strings.TrimRight(record, "\n")
	if record == "" {
		return CommitInfo{}, false
	}
	parts := strings.SplitN(record, "\x1f", 6)
	if len(parts) < 6 {
		return CommitInfo{}, false
	}
	hash := strings.TrimSpace(parts[0])
	if len(hash) < 7 {
		return CommitInfo{}, false
	}
	body := strings.TrimRight(parts[5], "\n")
	subject := strings.SplitN(body, "\n", 2)[0]
	return CommitInfo{
		SHA:         hash,
		ShortSHA:    hash[:7],
		Message:     body,
		Subject:     subject,
		AuthorName:  parts[1],
		AuthorEmail: parts[2],
		Timestamp:   parts[3],
		Parents:     strings.Fields(parts[4]),
	}, true
}

// logCommits runs `git log <args> <format>` and parses the record stream. args
// carries the revision range plus any traversal flags (e.g. --first-parent).
func logCommits(dir string, args ...string) []CommitInfo {
	out, err := gitOutput(dir, append(append([]string{"log"}, args...), gitLogFormat)...)
	if err != nil {
		return []CommitInfo{} // branch doesn't exist or no commits
	}
	var commits []CommitInfo
	for _, record := range strings.Split(out, "\x1e") {
		if c, ok := parseCommitRecord(record); ok {
			commits = append(commits, c)
		}
	}
	return commits
}

// ListCommits returns commits reachable from headBranch but not baseBranch, newest
// first. This walks the full ancestry, so a merge commit on headBranch also brings
// in every commit it merged; use ListFirstParentCommits for a head's own timeline.
func ListCommits(projectRoot, baseBranch, headBranch string) ([]CommitInfo, error) {
	return logCommits(projectRoot, baseBranch+".."+headBranch), nil
}

// ListFirstParentCommits returns the commits headBranch added over baseBranch
// following only first parents, newest first. Merging baseBranch into headBranch
// therefore surfaces as a single merge commit rather than the whole merged-in
// history - the right unit for a review timeline and the chat commit feed.
func ListFirstParentCommits(projectRoot, baseBranch, headBranch string) ([]CommitInfo, error) {
	return logCommits(projectRoot, "--first-parent", baseBranch+".."+headBranch), nil
}

// GetCommitInfo retrieves information about a single commit by ref.
func GetCommitInfo(projectRoot, ref string) (*CommitInfo, error) {
	out, err := gitOutput(projectRoot, "show", "--no-patch", gitLogFormat, ref)
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("resolve revision: %w", err))
	}
	// show output may have extra headers before the format; find the record separator.
	idx := strings.Index(out, "\x1e")
	if idx >= 0 {
		out = out[idx:]
	}
	c, ok := parseCommitRecord(strings.TrimPrefix(out, "\x1e"))
	if !ok {
		return nil, errtrace.Wrap(fmt.Errorf("unexpected git show output"))
	}
	return &c, nil
}

// GetDiff returns the parsed diff between baseRef and headRef.
// If headRef is empty, diffs baseRef against the working tree (uncommitted changes).
func GetDiff(projectRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, path string, context int) ([]DiffFile, error) {
	var paths []string
	if path != "" {
		paths = []string{path}
	}
	return errtrace.Wrap2(GetDiffPaths(projectRoot, baseRef, headRef, ignoreWhitespace, useTripleDot, paths, context))
}

// GetDiffPaths is GetDiff scoped to a set of pathspecs in a single git call. An
// empty paths slice diffs every changed file. Used by the full-context view to
// expand many files at once without one git invocation (or HTTP request) per
// file.
func GetDiffPaths(projectRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, paths []string, context int) ([]DiffFile, error) {
	// git only pairs a rename when BOTH the old and new names fall inside the
	// diff's pathspec. A diff scoped to just a renamed file's new name drops the
	// old name, so git reports the file as a brand-new add (every line green)
	// instead of a rename with its real additions/deletions. Widen the pathspec
	// with the old names of any requested renamed files so scoped diffs render
	// renames the same way the unscoped (whole-tree) diff does. Best-effort: a
	// failure here just falls back to the un-widened pathspec.
	if len(paths) > 0 {
		if extra, err := renameOldPaths(projectRoot, baseRef, headRef, useTripleDot, paths); err == nil && len(extra) > 0 {
			paths = append(append([]string(nil), paths...), extra...)
		}
	}

	// Histogram anchors on the rarest matching line (a generalisation of patience)
	// rather than plain Myers, so highly non-unique lines like a bare "}" or a
	// blank line can't mis-anchor. It gives noticeably better hunk shapes on
	// brace-heavy code - which is most agent-generated code - at comparable speed.
	args := []string{"diff", fmt.Sprintf("-U%d", context), "--diff-algorithm=histogram"}
	if ignoreWhitespace {
		args = append(args, "--ignore-space-change")
	}
	if headRef == "" {
		args = append(args, baseRef)
	} else if useTripleDot {
		args = append(args, baseRef+"..."+headRef)
	} else {
		args = append(args, baseRef, headRef)
	}
	if len(paths) > 0 {
		args = append(args, "--")
		args = append(args, paths...)
	}

	out, err := gitOutput(projectRoot, args...)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return errtrace.Wrap2(parseDiff(out))
}

// renameOldPaths returns the old names of any requested paths that are the new
// side of a rename between the two refs. It runs a cheap whole-tree
// `--name-status` diff (no hunks/content) where git's rename detection still
// sees both sides, then maps each requested new name back to its old name. Used
// to widen a scoped diff's pathspec so renames survive path filtering.
func renameOldPaths(projectRoot, baseRef, headRef string, useTripleDot bool, paths []string) ([]string, error) {
	args := []string{"diff", "--name-status", "-z", "--find-renames"}
	if headRef == "" {
		args = append(args, baseRef)
	} else if useTripleDot {
		args = append(args, baseRef+"..."+headRef)
	} else {
		args = append(args, baseRef, headRef)
	}
	out, err := gitOutput(projectRoot, args...)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	want := make(map[string]bool, len(paths))
	for _, p := range paths {
		want[p] = true
	}

	// The -z name-status stream is a flat sequence of NUL-terminated fields:
	// a non-rename entry is STATUS\0path, while a rename/copy is STATUS\0old\0new
	// (STATUS being e.g. "R100"/"C075"). Walk it, consuming the right field count
	// per entry so old/new stay paired.
	fields := strings.Split(out, "\x00")
	var extra []string
	for i := 0; i < len(fields); {
		status := fields[i]
		if status == "" {
			i++
			continue
		}
		if status[0] == 'R' || status[0] == 'C' {
			if i+2 >= len(fields) {
				break
			}
			oldPath, newPath := fields[i+1], fields[i+2]
			if want[newPath] && !want[oldPath] {
				extra = append(extra, oldPath)
			}
			i += 3
		} else {
			i += 2
		}
	}
	return extra, nil
}

// GetDiffFiles returns summary info (no hunks) for files changed between baseRef and headRef.
func GetDiffFiles(projectRoot, baseRef, headRef string, useTripleDot bool) ([]DiffFile, error) {
	files, err := GetDiff(projectRoot, baseRef, headRef, false, useTripleDot, "", 0)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	for i := range files {
		files[i].Hunks = nil
	}
	return files, nil
}

// WorktreeChangesSince reports how worktreeDir's working tree differs from
// baseRef: `changed` are added/modified/type-changed tracked files plus every
// untracked-but-not-ignored file (all to be copied), `deleted` are tracked
// files removed since baseRef. Rename detection is off, so a rename surfaces as
// a delete of the old path and an add of the new one. Paths are repo-relative
// with forward slashes. Used by the preview worktree channel to mirror a head's
// live changes into its own checkout.
func WorktreeChangesSince(worktreeDir, baseRef string) (changed, deleted []string, err error) {
	if err := ValidateRef(baseRef); err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	// Tracked changes vs the base commit (working tree, not the index): -z gives
	// NUL-delimited paths, --no-renames keeps each entry a clean STATUS\0path
	// pair (a rename becomes a delete + an add).
	out, err := gitOutput(worktreeDir, "diff", "--name-status", "--no-renames", "-z", baseRef, "--")
	if err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	fields := strings.Split(out, "\x00")
	for i := 0; i+1 < len(fields); i += 2 {
		status, path := fields[i], fields[i+1]
		if status == "" || path == "" {
			continue
		}
		if status[0] == 'D' {
			deleted = append(deleted, path)
		} else {
			changed = append(changed, path)
		}
	}
	// Untracked, non-ignored files are copied too (--exclude-standard honors
	// .gitignore, so build junk does not sync).
	others, err := gitOutput(worktreeDir, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return nil, nil, errtrace.Wrap(err)
	}
	for _, p := range strings.Split(others, "\x00") {
		if p != "" {
			changed = append(changed, p)
		}
	}
	return changed, deleted, nil
}

// GetUntrackedDiffFiles returns DiffFile summary entries for untracked files.
func GetUntrackedDiffFiles(projectRoot string) ([]DiffFile, error) {
	out, err := gitOutput(projectRoot, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var files []DiffFile
	for _, p := range strings.Split(out, "\n") {
		if p == "" {
			continue
		}
		content, err := os.ReadFile(filepath.Join(projectRoot, p))
		additions := 0
		if err == nil {
			additions = strings.Count(string(content), "\n")
			if len(content) > 0 && !strings.HasSuffix(string(content), "\n") {
				additions++
			}
		}
		files = append(files, DiffFile{Path: p, ChangeType: "added", Additions: additions})
	}
	return files, nil
}

// GetUntrackedDiff returns full parsed diffs for untracked files.
func GetUntrackedDiff(projectRoot, path string, context int) ([]DiffFile, error) {
	out, err := gitOutput(projectRoot, "ls-files", "--others", "--exclude-standard")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	var files []DiffFile
	for _, p := range strings.Split(out, "\n") {
		if p == "" || (path != "" && p != path) {
			continue
		}
		cmd := exec.Command("git", "-C", projectRoot, "diff", "--no-index",
			fmt.Sprintf("-U%d", context), "/dev/null", p)
		diffOut, err := cmd.Output()
		if err != nil {
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
				continue // skip file on unexpected error
			}
			// exit code 1 = files differ, expected for --no-index
		}
		diffs, err := parseDiff(string(diffOut))
		if err != nil {
			continue
		}
		files = append(files, diffs...)
	}
	return files, nil
}

// GetMergeBase returns the merge-base commit hash between two refs.
func GetMergeBase(projectRoot, baseRef, headRef string) (string, error) {
	return errtrace.Wrap2(gitOutput(projectRoot, "merge-base", baseRef, headRef))
}

// HasConflicts returns true if merging headRef into baseRef would conflict.
func HasConflicts(projectRoot, baseRef, headRef string) (bool, error) {
	conflicts, err := GetConflictingFiles(projectRoot, baseRef, headRef)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return len(conflicts) > 0, nil
}

// GetConflictingFiles returns the files that would actually conflict when
// merging headRef into baseRef.
//
// It performs a real in-memory three-way merge with `git merge-tree
// --write-tree` (git 2.38+), so files that both branches touched but that still
// merge cleanly (e.g. edits to different parts of the same file) are NOT
// reported. The previous implementation flagged any file changed on both sides,
// which produced false-positive conflict warnings on changes git can merge.
func GetConflictingFiles(projectRoot, baseRef, headRef string) ([]string, error) {
	// merge-tree operates purely against the object store: it writes the merged
	// tree as loose objects but does not touch the index, working tree, or any
	// refs, so it is safe to run repeatedly and concurrently. Exit status:
	//   0 -> clean merge, 1 -> conflicts, >1 -> error (e.g. unrelated histories).
	out, err := exec.Command("git", "-C", projectRoot,
		"merge-tree", "--write-tree", "--name-only", baseRef, headRef).Output()
	if err == nil {
		return nil, nil // clean merge, no conflicts
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return nil, errtrace.Wrap(fmt.Errorf("git merge-tree %s %s: %w", baseRef, headRef, err))
	}
	if exitErr.ExitCode() != 1 {
		return nil, errtrace.Wrap(fmt.Errorf("git merge-tree %s %s: %w: %s", baseRef, headRef, err, exitErr.Stderr))
	}

	// Conflicted output (without -z) is three sections:
	//   <OID of toplevel tree>
	//   <conflicted path>...        (one per line; just the path with --name-only)
	//   <blank line>
	//   <informational messages>
	// Skip the OID line and collect paths up to the blank-line separator.
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	var conflicts []string
	for _, f := range lines[1:] {
		if f == "" {
			break
		}
		conflicts = append(conflicts, f)
	}
	return conflicts, nil
}

// GetUncommittedSummary returns counts of tracked and untracked changes.
func GetUncommittedSummary(projectRoot string) (*UncommittedSummary, error) {
	out, err := gitOutput(projectRoot, "status", "--porcelain=v1")
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	s := &UncommittedSummary{}
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		if line[0] == '?' && line[1] == '?' {
			s.UntrackedCount++
		} else {
			s.TrackedCount++
		}
	}
	return s, nil
}

// parseDiff parses raw unified diff output.
func parseDiff(rawDiff string) ([]DiffFile, error) {
	var files []DiffFile
	var cur *DiffFile
	var curHunk *DiffHunk
	oldLineNum, newLineNum := 0, 0

	finishHunk := func() {
		if curHunk != nil && cur != nil {
			cur.Hunks = append(cur.Hunks, *curHunk)
			curHunk = nil
		}
	}
	finishFile := func() {
		if cur != nil {
			finishHunk()
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}
			files = append(files, *cur)
			cur = nil
		}
	}

	lines := strings.SplitSeq(rawDiff, "\n")
	for line := range lines {
		switch {
		case strings.HasPrefix(line, "diff --git ") || strings.HasPrefix(line, "diff "):
			finishFile()
			cur = &DiffFile{}
			if idx := strings.LastIndex(line, " b/"); idx != -1 {
				cur.Path = line[idx+3:]
			} else if idx := strings.LastIndex(line, " "); idx != -1 {
				cur.Path = line[idx+1:]
			}
		case cur == nil && (strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ ")):
			cur = &DiffFile{}
			if after, ok := strings.CutPrefix(line, "+++ "); ok {
				cur.Path = strings.TrimPrefix(after, "b/")
			}
		case cur == nil:
			continue
		case strings.HasPrefix(line, "new file mode"):
			cur.ChangeType = "added"
		case strings.HasPrefix(line, "deleted file mode"):
			cur.ChangeType = "deleted"
		case strings.HasPrefix(line, "rename from "):
			cur.ChangeType = "renamed"
			op := strings.TrimPrefix(line, "rename from ")
			cur.OldPath = &op
		case strings.HasPrefix(line, "rename to "):
			cur.Path = strings.TrimPrefix(line, "rename to ")
		case strings.HasPrefix(line, "Binary files"):
			cur.Binary = true
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}
		case strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ "):
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}
			if cur.Path == "" && strings.HasPrefix(line, "+++ ") {
				cur.Path = strings.TrimPrefix(line, "+++ ")
				cur.Path = strings.TrimPrefix(cur.Path, "b/")
			}
		case strings.HasPrefix(line, "@@ "):
			finishHunk()
			oldLineNum, newLineNum = parseHunkHeader(line)
			curHunk = &DiffHunk{Header: line, OldStart: oldLineNum, NewStart: newLineNum}
		case curHunk != nil:
			switch {
			case strings.HasPrefix(line, "+"):
				n := newLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineAddition, Content: line[1:], NewLineNum: &n})
				newLineNum++
				cur.Additions++
			case strings.HasPrefix(line, "-"):
				o := oldLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineDeletion, Content: line[1:], OldLineNum: &o})
				oldLineNum++
				cur.Deletions++
			case strings.HasPrefix(line, "\\"):
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineNoNewline, Content: line})
			case strings.HasPrefix(line, " "):
				o, n := oldLineNum, newLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{Type: DiffLineContext, Content: line[1:], OldLineNum: &o, NewLineNum: &n})
				oldLineNum++
				newLineNum++
			}
		}
	}
	finishFile()
	return coalesceTypeChanges(files), nil
}

// coalesceTypeChanges merges the split entries git emits for a "type change" -
// when a path flips between a symlink and a regular file (e.g. CLAUDE.md being
// converted from a `CLAUDE.md -> GEMINI.md` symlink into a real file). git can't
// represent that as a single hunk, so it emits a deletion of the old object
// followed by an addition of the new one: two `diff --git a/PATH b/PATH` stanzas
// for the SAME path. Left as-is these parse into two DiffFiles sharing a path,
// which surface as duplicate rows - and duplicate React keys - in the file tree.
// Collapse each run of consecutive same-path entries into a single "modified"
// entry whose additions/deletions/hunks are the union of the parts.
func coalesceTypeChanges(files []DiffFile) []DiffFile {
	if len(files) < 2 {
		return files
	}
	merged := make([]DiffFile, 0, len(files))
	for _, f := range files {
		if n := len(merged); n > 0 && f.Path != "" && merged[n-1].Path == f.Path {
			prev := &merged[n-1]
			prev.ChangeType = "modified"
			prev.Additions += f.Additions
			prev.Deletions += f.Deletions
			prev.Binary = prev.Binary || f.Binary
			prev.Hunks = append(prev.Hunks, f.Hunks...)
			if prev.OldPath == nil {
				prev.OldPath = f.OldPath
			}
			continue
		}
		merged = append(merged, f)
	}
	return merged
}

func parseHunkHeader(header string) (oldStart, newStart int) {
	parts := strings.Fields(header)
	if len(parts) < 3 {
		return 1, 1
	}
	old := strings.TrimPrefix(parts[1], "-")
	newS := strings.TrimPrefix(parts[2], "+")

	parseStart := func(s string) int {
		comma := strings.Index(s, ",")
		if comma != -1 {
			s = s[:comma]
		}
		n, _ := strconv.Atoi(s)
		return n
	}
	return parseStart(old), parseStart(newS)
}

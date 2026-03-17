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
}

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
}

// UncommittedSummary holds counts of uncommitted changes.
type UncommittedSummary struct {
	TrackedCount   int
	UntrackedCount int
}

// gitLogFormat uses ASCII control characters as separators to avoid collisions
// with commit message content. %x1e = record separator, %x1f = field separator.
const gitLogFormat = "--format=%x1e%H%x1f%aN%x1f%aE%x1f%aI%x1f%B"

func parseCommitRecord(record string) (CommitInfo, bool) {
	record = strings.TrimRight(record, "\n")
	if record == "" {
		return CommitInfo{}, false
	}
	parts := strings.SplitN(record, "\x1f", 5)
	if len(parts) < 5 {
		return CommitInfo{}, false
	}
	hash := strings.TrimSpace(parts[0])
	if len(hash) < 7 {
		return CommitInfo{}, false
	}
	body := strings.TrimRight(parts[4], "\n")
	subject := strings.SplitN(body, "\n", 2)[0]
	return CommitInfo{
		SHA:         hash,
		ShortSHA:    hash[:7],
		Message:     body,
		Subject:     subject,
		AuthorName:  parts[1],
		AuthorEmail: parts[2],
		Timestamp:   parts[3],
	}, true
}

// ListCommits returns commits reachable from headBranch but not baseBranch, newest first.
func ListCommits(projectRoot, baseBranch, headBranch string) ([]CommitInfo, error) {
	out, err := gitOutput(projectRoot, "log", baseBranch+".."+headBranch, gitLogFormat)
	if err != nil {
		return []CommitInfo{}, nil // branch doesn't exist or no commits
	}
	var commits []CommitInfo
	for _, record := range strings.Split(out, "\x1e") {
		if c, ok := parseCommitRecord(record); ok {
			commits = append(commits, c)
		}
	}
	return commits, nil
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
	args := []string{"diff", fmt.Sprintf("-U%d", context)}
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
	if path != "" {
		args = append(args, "--", path)
	}

	out, err := gitOutput(projectRoot, args...)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	return parseDiff(out)
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
	return gitOutput(projectRoot, "merge-base", baseRef, headRef)
}

// HasConflicts returns true if merging headRef into baseRef would conflict.
func HasConflicts(projectRoot, baseRef, headRef string) (bool, error) {
	conflicts, err := GetConflictingFiles(projectRoot, baseRef, headRef)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return len(conflicts) > 0, nil
}

// GetConflictingFiles returns files modified in both branches since their common ancestor.
func GetConflictingFiles(projectRoot, baseRef, headRef string) ([]string, error) {
	mergeBase, err := GetMergeBase(projectRoot, baseRef, headRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	baseChangedOut, err := gitOutput(projectRoot, "diff", "--name-only", mergeBase, baseRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	headChangedOut, err := gitOutput(projectRoot, "diff", "--name-only", mergeBase, headRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	baseSet := make(map[string]bool)
	for _, f := range strings.Split(baseChangedOut, "\n") {
		if f != "" {
			baseSet[f] = true
		}
	}
	var conflicts []string
	for _, f := range strings.Split(headChangedOut, "\n") {
		if f != "" && baseSet[f] {
			conflicts = append(conflicts, f)
		}
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

// HasUncommittedChanges returns true if there are uncommitted changes to tracked files.
func HasUncommittedChanges(projectRoot string) (bool, error) {
	out, err := gitOutput(projectRoot, "status", "--porcelain=v1")
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	for _, line := range strings.Split(out, "\n") {
		if len(line) < 2 {
			continue
		}
		if !(line[0] == '?' && line[1] == '?') {
			return true, nil
		}
	}
	return false, nil
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
	return files, nil
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

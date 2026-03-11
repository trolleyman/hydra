package git

import (
	"fmt"
	"os/exec"
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

// ListCommits returns the commits reachable from headBranch but not from baseBranch.
// Results are ordered newest-first.
func ListCommits(projectRoot, baseBranch, headBranch string) ([]CommitInfo, error) {
	// Use NUL-delimited records to handle commit messages with newlines.
	// Format: SHA NUL ShortSHA NUL Subject NUL AuthorName NUL AuthorEmail NUL Timestamp NUL
	out, err := exec.Command("git", "-C", projectRoot,
		"log",
		"--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI%x00",
		baseBranch+".."+headBranch,
	).Output()
	if err != nil {
		// If the branch doesn't exist or there's no diff, return empty list
		return nil, nil
	}

	raw := strings.TrimRight(string(out), "\n")
	if raw == "" {
		return nil, nil
	}

	var commits []CommitInfo
	// Split by NUL; every 6 fields is one commit (with trailing NUL, so chunks of 7 split fields)
	parts := strings.Split(raw, "\x00")
	for i := 0; i+5 < len(parts); i += 6 {
		sha := strings.TrimSpace(parts[i])
		if sha == "" {
			continue
		}
		subject := parts[i+2]
		// Full message would require a separate call; we use subject as message too for now.
		commits = append(commits, CommitInfo{
			SHA:         sha,
			ShortSHA:    strings.TrimSpace(parts[i+1]),
			Message:     subject,
			Subject:     subject,
			AuthorName:  parts[i+3],
			AuthorEmail: parts[i+4],
			Timestamp:   strings.TrimSpace(parts[i+5]),
		})
	}
	return commits, nil
}

// GetCommitInfo retrieves information about a single commit by ref.
func GetCommitInfo(projectRoot, ref string) (*CommitInfo, error) {
	out, err := exec.Command("git", "-C", projectRoot,
		"show", "--no-patch",
		"--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%aI",
		ref,
	).Output()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("git show: %w", err))
	}
	parts := strings.SplitN(strings.TrimSpace(string(out)), "\x00", 6)
	if len(parts) < 6 {
		return nil, errtrace.Wrap(fmt.Errorf("unexpected git show output"))
	}
	subject := parts[2]
	return &CommitInfo{
		SHA:         parts[0],
		ShortSHA:    parts[1],
		Message:     subject,
		Subject:     subject,
		AuthorName:  parts[3],
		AuthorEmail: parts[4],
		Timestamp:   parts[5],
	}, nil
}

// GetDiff returns the parsed diff between baseRef and headRef.
// If useTripleDot is true, uses "..." (merge-base diff, like a GitLab MR).
// If ignoreWhitespace is true, passes -w to git diff.
// If path is non-empty, only returns the diff for that file.
// context specifies the number of context lines (-U<n>).
func GetDiff(projectRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool, path string, context int) ([]DiffFile, error) {
	args := []string{"-C", projectRoot, "diff", "--no-color"}
	if ignoreWhitespace {
		args = append(args, "-w")
	}
	if context > 0 {
		args = append(args, fmt.Sprintf("-U%d", context))
	}
	if headRef == "" {
		// Empty headRef means "compare baseRef to working tree"
		args = append(args, baseRef)
	} else {
		separator := ".."
		if useTripleDot {
			separator = "..."
		}
		args = append(args, baseRef+separator+headRef)
	}

	if path != "" {
		args = append(args, "--", path)
	}

	out, err := exec.Command("git", args...).Output()
	if err != nil {
		// Exit code 1 means there are differences (not an error for our purposes)
		// Exit code >= 2 is a real error
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			// This is fine, there are differences
		} else if ok && exitErr.ExitCode() >= 2 {
			return nil, errtrace.Wrap(fmt.Errorf("git diff: %w", err))
		}
	}

	return errtrace.Wrap2(parseDiff(string(out)))
}

// GetDiffFiles returns the list of files that changed between baseRef and headRef,
// including addition and deletion counts.
func GetDiffFiles(projectRoot, baseRef, headRef string, useTripleDot bool) ([]DiffFile, error) {
	rangeArg := func() string {
		if headRef == "" {
			// Empty headRef means "compare baseRef to working tree"
			return baseRef
		}
		separator := ".."
		if useTripleDot {
			separator = "..."
		}
		return baseRef + separator + headRef
	}()

	args := []string{"-C", projectRoot, "diff", "--numstat", "--no-color", rangeArg}

	out, err := exec.Command("git", args...).CombinedOutput()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			// fine
		} else {
			return nil, errtrace.Wrap(fmt.Errorf("git diff --numstat: %w (output: %q)", err, string(out)))
		}
	}

	stats := make(map[string][2]int)
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		add, _ := strconv.Atoi(parts[0])
		del, _ := strconv.Atoi(parts[1])
		stats[parts[2]] = [2]int{add, del}
	}

	// Now get the change types (--name-status)
	args = []string{"-C", projectRoot, "diff", "--name-status", "--no-color", rangeArg}
	out, err = exec.Command("git", args...).CombinedOutput()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			// fine
		} else {
			return nil, errtrace.Wrap(fmt.Errorf("git diff --name-status: %w (output: %q)", err, string(out)))
		}
	}

	var files []DiffFile
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		status := parts[0]
		path := parts[1]
		var oldPath *string
		if strings.HasPrefix(status, "R") && len(parts) >= 3 {
			old := parts[1]
			oldPath = &old
			path = parts[2]
		}

		changeType := "modified"
		switch {
		case strings.HasPrefix(status, "A"):
			changeType = "added"
		case strings.HasPrefix(status, "D"):
			changeType = "deleted"
		case strings.HasPrefix(status, "R"):
			changeType = "renamed"
		}

		st := stats[path]
		files = append(files, DiffFile{
			Path:       path,
			OldPath:    oldPath,
			ChangeType: changeType,
			Additions:  st[0],
			Deletions:  st[1],
		})
	}

	return files, nil
}

// GetUntrackedDiffFiles returns DiffFile summary entries (no hunks) for all untracked
// files in projectRoot. These are files reported by `git ls-files --others`.
func GetUntrackedDiffFiles(projectRoot string) ([]DiffFile, error) {
	out, err := exec.Command("git", "-C", projectRoot, "ls-files", "--others", "--exclude-standard").Output()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("git ls-files: %w", err))
	}
	var files []DiffFile
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		// Count additions via --numstat diff --no-index /dev/null <file>
		numOut, _ := exec.Command("git", "-C", projectRoot, "diff", "--numstat", "--no-color", "--no-index", "/dev/null", line).Output()
		additions := 0
		for _, l := range strings.Split(strings.TrimSpace(string(numOut)), "\n") {
			if l = strings.TrimSpace(l); l == "" {
				continue
			}
			if parts := strings.Fields(l); len(parts) >= 1 {
				additions, _ = strconv.Atoi(parts[0])
			}
			break
		}
		files = append(files, DiffFile{Path: line, ChangeType: "added", Additions: additions})
	}
	return files, nil
}

// GetUntrackedDiff returns full parsed diffs for untracked files using
// `git diff --no-index /dev/null <file>`. If path is non-empty, only that file
// is returned. context controls the number of context lines.
func GetUntrackedDiff(projectRoot, path string, context int) ([]DiffFile, error) {
	out, err := exec.Command("git", "-C", projectRoot, "ls-files", "--others", "--exclude-standard").Output()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("git ls-files: %w", err))
	}
	var files []DiffFile
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line = strings.TrimSpace(line); line == "" {
			continue
		}
		if path != "" && line != path {
			continue
		}
		args := []string{"-C", projectRoot, "diff", "--no-color", "--no-index"}
		if context > 0 {
			args = append(args, fmt.Sprintf("-U%d", context))
		}
		args = append(args, "/dev/null", line)
		diffOut, _ := exec.Command("git", args...).Output()
		parsed, err := parseDiff(string(diffOut))
		if err != nil {
			continue
		}
		// parseDiff extracts the path from "diff --git a/... b/<path>"; fix it up.
		for i := range parsed {
			parsed[i].Path = line
			parsed[i].ChangeType = "added"
		}
		files = append(files, parsed...)
	}
	return files, nil
}

// parseDiff parses the output of `git diff --no-color` into a slice of DiffFile.
func parseDiff(rawDiff string) ([]DiffFile, error) {
	var files []DiffFile
	var cur *DiffFile
	var curHunk *DiffHunk
	oldLineNum := 0
	newLineNum := 0

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

	lines := strings.Split(rawDiff, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]

		switch {
		case strings.HasPrefix(line, "diff --git "):
			finishFile()
			cur = &DiffFile{}
			// Extract path from "b/" portion: "diff --git a/foo b/foo"
			if idx := strings.LastIndex(line, " b/"); idx != -1 {
				cur.Path = line[idx+3:]
			}

		case cur == nil:
			// Not inside a file block yet; skip.

		case strings.HasPrefix(line, "new file mode"):
			cur.ChangeType = "added"

		case strings.HasPrefix(line, "deleted file mode"):
			cur.ChangeType = "deleted"

		case strings.HasPrefix(line, "rename from "):
			cur.ChangeType = "renamed"
			oldPath := strings.TrimPrefix(line, "rename from ")
			cur.OldPath = &oldPath

		case strings.HasPrefix(line, "rename to "):
			cur.Path = strings.TrimPrefix(line, "rename to ")

		case strings.HasPrefix(line, "Binary files"):
			cur.Binary = true
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}

		case strings.HasPrefix(line, "index "):
			// Skip index lines

		case strings.HasPrefix(line, "--- ") || strings.HasPrefix(line, "+++ "):
			// Skip --- / +++ header lines
			if cur.ChangeType == "" {
				cur.ChangeType = "modified"
			}

		case strings.HasPrefix(line, "@@ "):
			finishHunk()
			curHunk = &DiffHunk{Header: line}
			oldLineNum, newLineNum = parseHunkHeader(line)

		case curHunk != nil:
			switch {
			case strings.HasPrefix(line, "+"):
				n := newLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{
					Type:       DiffLineAddition,
					Content:    line[1:],
					NewLineNum: &n,
				})
				newLineNum++
				cur.Additions++

			case strings.HasPrefix(line, "-"):
				o := oldLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{
					Type:       DiffLineDeletion,
					Content:    line[1:],
					OldLineNum: &o,
				})
				oldLineNum++
				cur.Deletions++

			case strings.HasPrefix(line, "\\"):
				// "\ No newline at end of file"
				curHunk.Lines = append(curHunk.Lines, DiffLine{
					Type:    DiffLineNoNewline,
					Content: line,
				})

			case strings.HasPrefix(line, " "):
				o := oldLineNum
				n := newLineNum
				curHunk.Lines = append(curHunk.Lines, DiffLine{
					Type:       DiffLineContext,
					Content:    line[1:],
					OldLineNum: &o,
					NewLineNum: &n,
				})
				oldLineNum++
				newLineNum++
			}
		}
	}

	finishFile()
	return files, nil
}

// parseHunkHeader parses "@@ -oldStart[,oldCount] +newStart[,newCount] @@" and returns
// the starting line numbers for the old and new file sides.
func parseHunkHeader(header string) (oldStart, newStart int) {
	// Example: "@@ -10,7 +10,8 @@ func foo() {"
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
		n, err := strconv.Atoi(s)
		if err != nil {
			return 1
		}
		return n
	}

	return parseStart(old), parseStart(newS)
}

// GetMergeBase returns the merge-base between two refs.
func GetMergeBase(projectRoot, baseRef, headRef string) (string, error) {
	out, err := exec.Command("git", "-C", projectRoot, "merge-base", baseRef, headRef).Output()
	if err != nil {
		return "", errtrace.Wrap(fmt.Errorf("git merge-base: %w", err))
	}
	return strings.TrimSpace(string(out)), nil
}

// HasConflicts returns true if there would be conflicts when merging headRef into baseRef.
func HasConflicts(projectRoot, baseRef, headRef string) (bool, error) {
	// git merge-tree --real baseRef headRef
	// This command exits with 0 if no conflicts, and 1 if there are conflicts.
	// It doesn't modify the worktree.
	cmd := exec.Command("git", "-C", projectRoot, "merge-tree", "--real", baseRef, headRef)
	err := cmd.Run()
	if err == nil {
		return false, nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
		return true, nil
	}
	return false, errtrace.Wrap(fmt.Errorf("git merge-tree: %w", err))
}

// UncommittedSummary holds counts of uncommitted changes in a worktree.
type UncommittedSummary struct {
	TrackedCount   int // staged or unstaged modifications to tracked files
	UntrackedCount int // untracked (never-added) files
}

// GetUncommittedSummary returns counts of staged/unstaged tracked files and untracked files.
func GetUncommittedSummary(projectRoot string) (*UncommittedSummary, error) {
	out, err := exec.Command("git", "-C", projectRoot, "status", "--porcelain").Output()
	if err != nil {
		return nil, errtrace.Wrap(fmt.Errorf("git status: %w", err))
	}
	s := &UncommittedSummary{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if len(line) < 2 {
			continue
		}
		if line[:2] == "??" {
			s.UntrackedCount++
		} else {
			s.TrackedCount++
		}
	}
	return s, nil
}

// HasUncommittedChanges returns true if there are uncommitted tracked-file changes in the worktree.
// Only considers tracked files (staged and unstaged modifications), not untracked files.
func HasUncommittedChanges(projectRoot string) (bool, error) {
	s, err := GetUncommittedSummary(projectRoot)
	if err != nil {
		return false, errtrace.Wrap(err)
	}
	return s.TrackedCount > 0, nil
}

// GetConflictingFiles returns the approximate list of files that would conflict when merging
// headRef into baseRef. It finds files modified in both branches since their common ancestor.
func GetConflictingFiles(projectRoot, baseRef, headRef string) ([]string, error) {
	mergeBase, err := GetMergeBase(projectRoot, baseRef, headRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	getNames := func(from, to string) (map[string]bool, error) {
		out, err := exec.Command("git", "-C", projectRoot, "diff", "--name-only", from+".."+to).Output()
		if err != nil {
			return nil, errtrace.Wrap(fmt.Errorf("git diff --name-only: %w", err))
		}
		m := make(map[string]bool)
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line = strings.TrimSpace(line); line != "" {
				m[line] = true
			}
		}
		return m, nil
	}

	baseChanged, err := getNames(mergeBase, baseRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}
	headChanged, err := getNames(mergeBase, headRef)
	if err != nil {
		return nil, errtrace.Wrap(err)
	}

	var conflicts []string
	for f := range headChanged {
		if baseChanged[f] {
			conflicts = append(conflicts, f)
		}
	}
	return conflicts, nil
}

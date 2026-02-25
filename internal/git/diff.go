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
	DiffLineAddition DiffLineType = "addition"
	DiffLineDeletion DiffLineType = "deletion"
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
func GetDiff(projectRoot, baseRef, headRef string, ignoreWhitespace, useTripleDot bool) ([]DiffFile, error) {
	args := []string{"-C", projectRoot, "diff", "--no-color"}
	if ignoreWhitespace {
		args = append(args, "-w")
	}
	separator := ".."
	if useTripleDot {
		separator = "..."
	}
	args = append(args, baseRef+separator+headRef)

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

	return parseDiff(string(out))
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

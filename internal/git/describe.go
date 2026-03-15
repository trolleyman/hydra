package git

import (
	"fmt"

	"braces.dev/errtrace"
	gogit "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/storer"
)

// Describe returns a string similar to `git describe --tags --always --dirty`.
func Describe(projectRoot string) (string, error) {
	repo, err := gogit.PlainOpen(projectRoot)
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	head, err := repo.Head()
	if err != nil {
		return "", errtrace.Wrap(err)
	}

	// Get tags
	tags := make(map[plumbing.Hash]string)
	tagIter, err := repo.Tags()
	if err == nil {
		_ = tagIter.ForEach(func(t *plumbing.Reference) error {
			// Resolve tag if it's an annotated tag
			h := t.Hash()
			tagObj, err := repo.TagObject(h)
			if err == nil {
				h = tagObj.Target
			}
			tags[h] = t.Name().Short()
			return nil
		})
	}

	// Walk back from HEAD to find the nearest tag
	var nearestTag string
	var distance int

	// If current HEAD is a tag, we're done
	if name, ok := tags[head.Hash()]; ok {
		nearestTag = name
	} else {
		// Log walker
		iter, err := repo.Log(&gogit.LogOptions{From: head.Hash()})
		if err == nil {
			err = iter.ForEach(func(c *object.Commit) error {
				if name, ok := tags[c.Hash]; ok {
					nearestTag = name
					return storer.ErrStop
				}
				distance++
				return nil
			})
		}
	}

	var res string
	if nearestTag != "" {
		if distance == 0 {
			res = nearestTag
		} else {
			res = fmt.Sprintf("%s-%d-g%s", nearestTag, distance, head.Hash().String()[:7])
		}
	} else {
		// No tag found, use always behavior
		res = head.Hash().String()[:7]
	}

	// Dirty check
	w, err := repo.Worktree()
	if err == nil {
		status, err := w.Status()
		if err == nil && !status.IsClean() {
			res += "-dirty"
		}
	}

	return res, nil
}

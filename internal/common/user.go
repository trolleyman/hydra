package common

import (
	"os/user"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

var nonAlphanumericRe = regexp.MustCompile("[^a-z0-9]")

// ContainerUserInfo extracts UID, GID, and sanitized username/group name from u,
// suitable for use as AGENT_USER/AGENT_GROUP in a Linux container.
// If u is nil, safe defaults (1000/1000/"user"/"user") are returned.
func ContainerUserInfo(u *user.User) (uid, gid int, username, groupName string) {
	uid, gid = 1000, 1000
	username, groupName = "user", "user"
	if u == nil {
		return
	}
	if n, err := strconv.Atoi(u.Uid); err == nil {
		uid = n
	}
	if n, err := strconv.Atoi(u.Gid); err == nil {
		gid = n
	}
	username = sanitizeContainerName(u.Username)
	groupName = sanitizeContainerName(u.Username)
	if grp, err := user.LookupGroupId(u.Gid); err == nil {
		groupName = sanitizeContainerName(grp.Name)
	}
	return
}

// sanitizeContainerName strips domain/machine prefixes and removes characters
// that are invalid in Linux usernames/group names.
// On non-Windows systems the name is returned as-is (already valid).
func sanitizeContainerName(name string) string {
	if runtime.GOOS == "windows" {
		if idx := strings.LastIndex(name, "\\"); idx != -1 {
			name = name[idx+1:]
		}
		name = strings.ToLower(name)
		name = nonAlphanumericRe.ReplaceAllString(name, "")
	}
	if name == "" {
		name = "user"
	}
	return name
}

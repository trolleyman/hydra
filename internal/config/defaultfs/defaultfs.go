package defaultfs

import "embed"

//go:embed *
var DefaultFS embed.FS

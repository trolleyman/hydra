// Package mediasize measures an image's pixel dimensions from its header alone.
//
// Two callers want the same thing for the same reason. The artifacts scan
// records a file's size so the web grid can lay a tile out without downloading
// the file to measure it; the chat's agent-file endpoint answers the same
// question for the pictures an agent embeds in a message, so the renderer can
// reserve each image's box before its bytes arrive rather than letting it land
// mid-transcript and shove everything down (see web/src/lib/serverMediaSize.ts).
//
// image.DecodeConfig reads the header and stops - no pixel decode - so measuring
// a 4K screenshot costs an open and a few hundred bytes.
package mediasize

import (
	"image"
	_ "image/gif"  // register the GIF header decoder
	_ "image/jpeg" // register the JPEG header decoder
	_ "image/png"  // register the PNG header decoder
	"os"
)

// ImagePixelSize returns an image file's natural pixel dimensions, or (0, 0)
// when they cannot be determined.
//
// Best-effort by design, and every caller treats a zero as "don't know" rather
// than as an answer: only the formats registered above can be read (a .webp or
// .avif yields nothing, as does an .svg - which has no pixel size in the raster
// sense anyway), and a truncated file being written as we look at it must not
// produce a wrong box. The client measures the bytes itself in that case, which
// is what it did for everything before this existed.
func ImagePixelSize(path string) (width, height int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

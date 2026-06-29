package http

import (
	_ "embed"
	"encoding/base64"
)

// Demo .webm clips for the simulated agent's artifacts, so the diff viewer's video
// modes (see web/src/components/VideoDiffView.tsx) have something to render in
// --simulation mode and in screenshots — the video twin of simSVG's mock images.
// They are a tiny animated "loading" card: identical chrome on both sides, only the
// progress bar's colour/fill differing, so the difference view highlights just the
// bar. Generated once with web/scripts/screenshots/gen-demo-webm.ts (Chromium
// MediaRecorder); kept as fixed bytes so screenshots stay stable.
//
//go:embed simdata/loader-before.webm
var simVideoBefore []byte

//go:embed simdata/loader-after.webm
var simVideoAfter []byte

// simWebM returns a video/webm data URL for embedded clip bytes, mirroring how
// simSVG hands the frontend a self-contained URL with no blob route needed.
func simWebM(b []byte) string {
	return "data:video/webm;base64," + base64.StdEncoding.EncodeToString(b)
}

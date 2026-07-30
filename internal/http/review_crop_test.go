package http

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"

	"github.com/trolleyman/hydra/internal/paths"
)

// pngDataURL encodes a w x h flat-coloured PNG the way the browser sends one.
// Flat colour is the point for the bomb case: it is what makes PNG's compression
// ratio enormous, so a huge picture fits in very few bytes.
func pngDataURL(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	// A single opaque colour compresses to almost nothing.
	for i := range img.Pix {
		if i%4 == 3 {
			img.Pix[i] = 0xff
		}
	}
	img.Set(0, 0, color.RGBA{1, 2, 3, 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestSaveCommentCropStoresARealPNG(t *testing.T) {
	root := t.TempDir()
	if err := saveCommentCrop(root, "h1", 4, pngDataURL(t, 40, 30)); err != nil {
		t.Fatalf("save: %v", err)
	}
	path := paths.GetReviewCropPath(root, "h1", 4)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("crop not written: %v", err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("stored bytes are not a PNG: %v", err)
	}
	if cfg.Width != 40 || cfg.Height != 30 {
		t.Errorf("stored %dx%d, want 40x30", cfg.Width, cfg.Height)
	}
}

// The byte bound is on the COMPRESSED form, and PNG's ratio on flat colour is
// enormous - so a file well under the size limit can still declare a bitmap that
// would take gigabytes to decode. The dimensions have to be checked from the
// header BEFORE anything allocates pixels.
func TestSaveCommentCropRefusesADecompressionBomb(t *testing.T) {
	root := t.TempDir()
	// 8000x8000 of flat colour: a trivial number of compressed bytes, and a
	// 256MB bitmap if it were ever decoded.
	bomb := pngDataURL(t, 8000, 8000)
	if n := len(bomb); n > maxCropBytes {
		t.Fatalf("test bomb is %d bytes, over the byte limit - it would be caught by size alone and prove nothing", n)
	}
	err := saveCommentCrop(root, "h1", 5, bomb)
	if err == nil {
		t.Fatal("a 8000x8000 crop was accepted")
	}
	if !strings.Contains(err.Error(), "over the") {
		t.Errorf("refused for the wrong reason: %v", err)
	}
	if _, statErr := os.Stat(paths.GetReviewCropPath(root, "h1", 5)); statErr == nil {
		t.Error("the refused crop was written to disk anyway")
	}
}

func TestSaveCommentCropRefusesNonPNG(t *testing.T) {
	root := t.TempDir()
	for name, payload := range map[string]string{
		"not a data URL":     "iVBORw0KGgo=",
		"a JPEG data URL":    "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString([]byte("\xff\xd8\xff")),
		"junk claiming PNG":  "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not a png at all")),
		"undecodable base64": "data:image/png;base64,!!!!",
	} {
		if err := saveCommentCrop(root, "h1", 6, payload); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

package mediasize

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// writePNG writes a w×h PNG and returns its path.
func writePNG(t *testing.T, dir, name string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	img.Set(0, 0, color.RGBA{R: 1, A: 1})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode: %v", err)
	}
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, buf.Bytes(), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

func TestImagePixelSize(t *testing.T) {
	dir := t.TempDir()

	t.Run("reads the dimensions out of the header", func(t *testing.T) {
		w, h := ImagePixelSize(writePNG(t, dir, "shot.png", 780, 1688))
		if w != 780 || h != 1688 {
			t.Fatalf("got %dx%d, want 780x1688", w, h)
		}
	})

	// Every caller reads a zero as "don't know" and falls back to measuring the
	// bytes client-side, so the failures below must be zeroes rather than
	// guesses - a wrong size lays a picture out at a shape it then jumps out of,
	// which is worse than the reflow this whole thing exists to avoid.
	t.Run("says nothing about a file that is not there", func(t *testing.T) {
		if w, h := ImagePixelSize(filepath.Join(dir, "gone.png")); w != 0 || h != 0 {
			t.Fatalf("got %dx%d, want 0x0", w, h)
		}
	})

	t.Run("says nothing about a format it cannot read", func(t *testing.T) {
		// An SVG is in the chat endpoint's allowlist and has no raster size, so
		// this is a real case rather than a hypothetical one.
		svg := filepath.Join(dir, "icon.svg")
		if err := os.WriteFile(svg, []byte(`<svg width="10" height="10"/>`), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		if w, h := ImagePixelSize(svg); w != 0 || h != 0 {
			t.Fatalf("got %dx%d, want 0x0", w, h)
		}
	})

	t.Run("says nothing about a truncated file", func(t *testing.T) {
		// The shape of a screenshot still being written as the page asks for it.
		full, err := os.ReadFile(writePNG(t, dir, "partial-src.png", 40, 20))
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		partial := filepath.Join(dir, "partial.png")
		if err := os.WriteFile(partial, full[:8], 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
		if w, h := ImagePixelSize(partial); w != 0 || h != 0 {
			t.Fatalf("got %dx%d, want 0x0", w, h)
		}
	})

	t.Run("says nothing about a directory", func(t *testing.T) {
		if w, h := ImagePixelSize(dir); w != 0 || h != 0 {
			t.Fatalf("got %dx%d, want 0x0", w, h)
		}
	})
}

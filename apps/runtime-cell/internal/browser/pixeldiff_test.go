package browser

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func solid(w, h int, c color.NRGBA) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = c.R, c.G, c.B, c.A
	}
	return img
}

var white = color.NRGBA{255, 255, 255, 255}

func TestDiffOfTheSameImageIsZero(t *testing.T) {
	d := Diff(solid(40, 30, white), solid(40, 30, white), DefaultTolerance)
	if d.Changed != 0 || d.Total != 1200 || d.SizeDiffers || d.Ratio() != 0 {
		t.Fatalf("got %+v", d)
	}
}

func TestDiffCountsChangedPixelsAndPaintsThemRed(t *testing.T) {
	pr := solid(10, 10, white)
	pr.SetNRGBA(3, 4, color.NRGBA{0, 0, 0, 255})
	pr.SetNRGBA(5, 5, color.NRGBA{0, 0, 0, 255})
	d := Diff(solid(10, 10, white), pr, DefaultTolerance)
	if d.Changed != 2 || d.Ratio() != 0.02 {
		t.Fatalf("got changed %d ratio %v", d.Changed, d.Ratio())
	}
	if got := d.Image.NRGBAAt(3, 4); got != changedColor {
		t.Fatalf("changed pixel drawn %v", got)
	}
	if got := d.Image.NRGBAAt(0, 0); got.R != 255 {
		t.Fatalf("unchanged white pixel drawn %v", got)
	}
}

// Antialiasing moves a channel by a few steps between two renders of the
// same page: under the tolerance it is the same pixel.
func TestDiffIgnoresMovesUnderTheTolerance(t *testing.T) {
	pr := solid(10, 10, color.NRGBA{250, 240, 255, 255})
	if d := Diff(solid(10, 10, white), pr, DefaultTolerance); d.Changed != 0 {
		t.Fatalf("got %d changed", d.Changed)
	}
	if d := Diff(solid(10, 10, white), pr, 4); d.Changed != 100 {
		t.Fatalf("with tolerance 4 got %d changed", d.Changed)
	}
}

func TestDiffOfTwoSizesCountsTheMissingAreaAsChanged(t *testing.T) {
	d := Diff(solid(10, 10, white), solid(10, 20, white), DefaultTolerance)
	if !d.SizeDiffers || d.Total != 200 || d.Changed != 100 {
		t.Fatalf("got %+v", d)
	}
}

func TestEncodePNGRefusesOverTheBound(t *testing.T) {
	img := solid(64, 64, white)
	b := EncodePNG(img, 1<<20)
	if b == nil {
		t.Fatal("small image refused")
	}
	if _, err := png.Decode(bytes.NewReader(b)); err != nil {
		t.Fatal(err)
	}
	if EncodePNG(img, 10) != nil {
		t.Fatal("over the bound kept")
	}
}

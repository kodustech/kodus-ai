package browser

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
)

// DefaultTolerance is how far one channel of a pixel may move (of 255)
// before the pixel counts as changed: font antialiasing differs by a few
// steps between two renders of the same page, a changed label by far more.
const DefaultTolerance = 24

// PixelDiff is one screenshot against the baseline's screenshot of the same
// step: how many pixels changed, of how many, and an image that shows where.
type PixelDiff struct {
	Changed, Total int64
	// SizeDiffers: the two images are not the same size; every pixel outside
	// their overlap counts as changed.
	SizeDiffers bool
	// Image is the PR screenshot faded to grey, with every changed pixel red.
	Image *image.NRGBA
}

// Ratio is Changed over Total (0 for two empty images).
func (d PixelDiff) Ratio() float64 {
	if d.Total == 0 {
		return 0
	}
	return float64(d.Changed) / float64(d.Total)
}

var changedColor = color.NRGBA{R: 230, G: 20, B: 60, A: 255}

func toNRGBA(img image.Image) *image.NRGBA {
	if n, ok := img.(*image.NRGBA); ok && n.Rect.Min == (image.Point{}) {
		return n
	}
	b := img.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Rect, img, b.Min, draw.Src)
	return out
}

func absDiff(a, b uint8) uint8 {
	if a > b {
		return a - b
	}
	return b - a
}

// Diff compares base and pr pixel by pixel. A pixel changed when any of its
// four channels moved more than tolerance.
func Diff(base, pr image.Image, tolerance uint8) PixelDiff {
	a, b := toNRGBA(base), toNRGBA(pr)
	w := max(a.Rect.Dx(), b.Rect.Dx())
	h := max(a.Rect.Dy(), b.Rect.Dy())
	out := image.NewNRGBA(image.Rect(0, 0, w, h))
	d := PixelDiff{Total: int64(w) * int64(h), SizeDiffers: a.Rect.Size() != b.Rect.Size(), Image: out}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			inA := x < a.Rect.Dx() && y < a.Rect.Dy()
			inB := x < b.Rect.Dx() && y < b.Rect.Dy()
			o := out.PixOffset(x, y)
			if !inA || !inB {
				d.Changed++
				copy(out.Pix[o:o+4], []uint8{changedColor.R, changedColor.G, changedColor.B, changedColor.A})
				continue
			}
			pa, pb := a.Pix[a.PixOffset(x, y):], b.Pix[b.PixOffset(x, y):]
			if absDiff(pa[0], pb[0]) > tolerance || absDiff(pa[1], pb[1]) > tolerance || absDiff(pa[2], pb[2]) > tolerance || absDiff(pa[3], pb[3]) > tolerance {
				d.Changed++
				copy(out.Pix[o:o+4], []uint8{changedColor.R, changedColor.G, changedColor.B, changedColor.A})
				continue
			}
			// Unchanged: the PR's pixel in grey, three quarters toward white.
			grey := uint8((uint16(pb[0]) + uint16(pb[1]) + uint16(pb[2])) / 3)
			faded := 255 - (255-grey)/4
			copy(out.Pix[o:o+4], []uint8{faded, faded, faded, 255})
		}
	}
	return d
}

// EncodePNG is the diff image as PNG, or nil when it would be over max bytes.
func EncodePNG(img image.Image, maxBytes int) []byte {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil || buf.Len() > maxBytes {
		return nil
	}
	return buf.Bytes()
}

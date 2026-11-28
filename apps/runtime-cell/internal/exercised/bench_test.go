package exercised

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"testing"
)

// Measured on an Apple M4 (go test -run X -bench . -benchtime 5x), against
// the code before the budget (every script painted, each file unmarshalled
// whole, a paint bound per script only):
//
//	a 36.7 MB coverage file, 2000 modules, one changed file
//	(BenchmarkAnswerLargeCoverage):
//	  before 431 ms, 550 MB, 528 k allocs per answer
//	  after  241 ms,  83 MB,  20 k allocs per answer
//	hostile, 20 scripts mapping to the changed file, each painting
//	15 x 16 Mi units (BenchmarkAnswerHostileCoverage):
//	  before 1.33 s for 16 KB of coverage, linear in its size: 64 MB of it
//	         is about 1.5 h of one core, not cancellable
//	  after  105 ms, the MaxPaint budget, whatever the size

// largeCoverage writes a V8 coverage file: scripts of size units, each
// with fns functions, none of them the changed file.
func largeCoverage(scripts, size, fns int) []byte {
	var b bytes.Buffer
	b.WriteString(`{"result":[`)
	for s := 0; s < scripts; s++ {
		if s > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, `{"scriptId":"%d","url":"file:///app/node_modules/pkg%d/index.js","functions":[`, s, s)
		fmt.Fprintf(&b, `{"functionName":"","ranges":[{"startOffset":0,"endOffset":%d,"count":1}],"isBlockCoverage":true}`, size)
		step := size / fns
		for f := 0; f < fns; f++ {
			st := f * step
			fmt.Fprintf(&b, `,{"functionName":"f%d","ranges":[{"startOffset":%d,"endOffset":%d,"count":%d},{"startOffset":%d,"endOffset":%d,"count":0}],"isBlockCoverage":true}`, f, st, st+step-1, f%2, st+step/4, st+step/2)
		}
		b.WriteString(`]}`)
	}
	b.WriteString(`]}`)
	return b.Bytes()
}

func benchAnswer(b *testing.B, raw []byte) {
	b.Logf("coverage file %.1f MB", float64(len(raw))/(1<<20))
	dir := b.TempDir()
	writeCoverage(b, dir, raw)
	files := []File{{Path: "src/changed.js", Lines: []int{1, 2, 3}}}
	read := func(string) ([]byte, error) { return nil, os.ErrNotExist }
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = Answer(context.Background(), files, dir, read)
	}
}

func BenchmarkAnswerLargeCoverage(b *testing.B) { benchAnswer(b, largeCoverage(2000, 200_000, 120)) }

func BenchmarkAnswerHostileCoverage(b *testing.B) {
	raw := bytes.ReplaceAll(hostileCoverage(20), []byte("../src/plain.js"), []byte("../src/changed.js"))
	b.Logf("coverage file %.1f MB", float64(len(raw))/(1<<20))
	dir := b.TempDir()
	writeCoverage(b, dir, raw)
	files := []File{{Path: "src/changed.js", Lines: []int{1}}}
	read := func(string) ([]byte, error) { return []byte("x\n"), nil }
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, _ = Answer(context.Background(), files, dir, read)
	}
}

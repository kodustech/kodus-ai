package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// The PROTOCOL a release carries is what its cell offers at hello.
func TestTheReleaseSaysTheProtocolItsCellSpeaks(t *testing.T) {
	v := protocol.SupportedVersions()
	if got := speaks(); got.Min != v[0] || got.Max != protocol.ProtocolVersion {
		t.Fatalf("speaks %+v, the cell offers %v", got, v)
	}
}

// The release build writes PROTOCOL into dist before it makes SHA256SUMS
// over every file there, so the signature covers it.
func TestTheReleaseBuildWritesPROTOCOLBeforeSHA256SUMS(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "..", ".github", "workflows", "runtime-cell-release.yml"))
	if err != nil {
		t.Fatal(err)
	}
	wf := string(b)
	write := strings.Index(wf, "go run ./cmd/release-sign protocol -dir dist")
	sums := strings.Index(wf, "sha256sum * > SHA256SUMS")
	if write < 0 || sums < 0 || write > sums {
		t.Fatalf("the release build must run `release-sign protocol -dir dist` before `sha256sum * > SHA256SUMS` (at %d and %d)", write, sums)
	}
}

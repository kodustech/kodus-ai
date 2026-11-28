package vmsnap

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// A round lives as long as its claim, on this host, in this process: its
// memory file and disks (tens of GB on a heavy environment) are not read
// back for a digest nor synced, which made writing kodus-ai's round 4.5 min
// on a 125 MB/s disk. Its state file still is; the size and time of every
// file still guard it; and a process that did not publish it refuses it.
func TestARoundIsPublishedWithoutReadingItsLargeFilesBack(t *testing.T) {
	s := newStore(t)
	id, dir, err := s.Stage("org-a")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range filesOf(isolation.ShapeEnvironment) {
		body := []byte("state of " + id)
		if name == FileMem {
			body = make([]byte, 128<<20)
		}
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	m, err := s.Publish(dir, Manifest{
		ID: id, Org: "org-a", Purpose: isolation.PurposeRound, Claim: "run1", Shape: isolation.ShapeEnvironment, Created: time.Now().UTC(),
		Source: "kodus-c-workload", MemoryMB: 128, VCPUs: 1, Kit: "sha256:kit", Host: "host-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, f := range m.Files {
		if name == FileState && len(f.SHA256) != 64 {
			t.Fatalf("the state file has no digest: %+v", f)
		}
		if name != FileState && f.SHA256 != "" {
			t.Fatalf("%s was read back for a digest", name)
		}
	}
	if _, _, err := s.Open("org-a", id); err != nil {
		t.Fatalf("the process that published the round: %v", err)
	}
	restarted, _ := NewStore(s.Dir())
	if _, _, err := restarted.Open("org-a", id); !errors.Is(err, ErrRefused) {
		t.Fatalf("another process opened a round it cannot verify: %v", err)
	}
	mem := filepath.Join(dir, FileMem)
	_ = os.Chtimes(mem, time.Now().Add(time.Second), time.Now().Add(time.Second))
	if _, _, err := s.Open("org-a", id); !errors.Is(err, ErrRefused) {
		t.Fatalf("a round whose memory file changed since: %v", err)
	}

	// A template keeps its digests: it outlives the process and the claim.
	tpl := stage(t, s, "org-a", isolation.ShapeEnvironment, isolation.PurposeTemplate)
	for name, f := range tpl.Files {
		if len(f.SHA256) != 64 {
			t.Fatalf("template file %s has no digest", name)
		}
	}
}

//go:build unix

package vmsnap

import (
	"archive/tar"
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// sparseTemplate is an environment template whose data disk is 1 GiB with
// a few runs of data, one of them written zeros (data, not a hole), as an
// ext4 image holds.
func sparseTemplate(t *testing.T, s *Store) Manifest {
	t.Helper()
	m := stage(t, s, "org-a", isolation.ShapeEnvironment, isolation.PurposeTemplate)
	dir := filepath.Join(s.Dir(), OrgKey("org-a"), m.ID)
	data := filepath.Join(dir, FileData)
	_ = os.Chmod(data, 0o600)
	f, err := os.OpenFile(data, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteAt(bytes.Repeat([]byte{7}, 64<<10), 0)
	_, _ = f.WriteAt(make([]byte, 64<<10), 256<<20) // zeros written: data
	_, _ = f.WriteAt(bytes.Repeat([]byte{9}, 64<<10), 512<<20)
	_ = f.Truncate(1 << 30)
	_ = f.Close()
	_ = os.Remove(filepath.Join(dir, manifestName))
	m, err = s.Publish(dir, m)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// rewrite is the archive with each entry passed through mut (which may
// change its header or its body) and written in GNU format, whose times
// are whole seconds, as GNU tar writes by default.
func rewrite(t *testing.T, archive []byte, mut func(h *tar.Header, body []byte) []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	tr, tw := tar.NewReader(bytes.NewReader(archive)), tar.NewWriter(&out)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		h.ModTime, h.Format, h.PAXRecords = h.ModTime.Truncate(time.Second), tar.FormatGNU, nil
		if mut != nil {
			body = mut(h, body)
		}
		h.Size = int64(len(body))
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write(body)
	}
	_ = tw.Close()
	return out.Bytes()
}

// A template copied to another host's store keeps opening there: Export
// writes it with its times to the nanosecond and its disks' runs of data,
// and Import lays each run at its offset (holes stay holes, written zeros
// stay data), checks every file against the manifest's digest and stamps
// it with the manifest's time. A copy that kept whole seconds, as plain tar
// does, is refused by Open (round 3: "rootfs.ext4 changed since it was
// published"); the same seconds-only archive through Import opens.
func TestATemplateCopiedToAnotherHostOpensThere(t *testing.T) {
	src := newStore(t)
	m := sparseTemplate(t, src)
	var archive bytes.Buffer
	if err := src.Export("org-a", m.ID, &archive); err != nil {
		t.Fatal(err)
	}

	// By hand: the files with whole-second times, as GNU tar's default keeps them.
	byHand := newStore(t)
	from, to := filepath.Join(src.Dir(), OrgKey("org-a"), m.ID), filepath.Join(byHand.Dir(), OrgKey("org-a"), m.ID)
	_ = os.MkdirAll(to, 0o700)
	for _, name := range append(filesOf(m.Shape), manifestName) {
		raw, _ := os.ReadFile(filepath.Join(from, name))
		_ = os.WriteFile(filepath.Join(to, name), raw, 0o600)
		fi, _ := os.Stat(filepath.Join(from, name))
		_ = os.Chtimes(filepath.Join(to, name), fi.ModTime().Truncate(time.Second), fi.ModTime().Truncate(time.Second))
	}
	if _, _, err := byHand.Open("org-a", m.ID); !errors.Is(err, ErrRefused) {
		t.Fatalf("a copy with whole-second times opened: %v", err)
	}

	for name, a := range map[string][]byte{"the export": archive.Bytes(), "the export rewritten with whole-second times": rewrite(t, archive.Bytes(), nil)} {
		dst := newStore(t)
		got, err := dst.Import("org-a", bytes.NewReader(a))
		if err != nil || got.ID != m.ID {
			t.Fatalf("%s: import %+v %v", name, got, err)
		}
		// A cell that starts later reads every file back to its digest.
		restarted, _ := NewStore(dst.Dir())
		if _, _, err := restarted.Open("org-a", m.ID); err != nil {
			t.Fatalf("%s: the imported template does not open: %v", name, err)
		}
		dir := filepath.Join(dst.Dir(), OrgKey("org-a"), m.ID)
		for _, f := range filesOf(m.Shape) {
			fi, _ := os.Stat(filepath.Join(dir, f))
			if fi.ModTime().UnixNano() != m.Files[f].ModUnixNano || fi.Mode().Perm() != fileMode(f) {
				t.Fatalf("%s: %s is %v %v, published %d", name, f, fi.ModTime().UnixNano(), fi.Mode(), m.Files[f].ModUnixNano)
			}
		}
		if got := allocated(dir); got > 512<<20 {
			t.Fatalf("%s: the template takes %d bytes: its data disk's holes were written", name, got)
		}
	}
}

// Import takes only what Export makes of a template of the org, whole and
// unchanged, and leaves nothing of what it refused.
func TestAnImportRefusesWhatIsNotTheTemplateExported(t *testing.T) {
	src := newStore(t)
	m := sparseTemplate(t, src)
	var buf bytes.Buffer
	if err := src.Export("org-a", m.ID, &buf); err != nil {
		t.Fatal(err)
	}
	archive := buf.Bytes()
	cases := map[string]struct {
		org     string
		archive []byte
	}{
		"another org's template": {"org-b", archive},
		"a byte changed in a disk": {"org-a", rewrite(t, archive, func(h *tar.Header, body []byte) []byte {
			if h.Name == FileRoot {
				body[0] ^= 1
			}
			return body
		})},
		"a run moved": {"org-a", rewrite(t, archive, func(h *tar.Header, body []byte) []byte {
			if h.Name == FileData+runsSuffix {
				return bytes.Replace(body, []byte(`"offset":536870912`), []byte(`"offset":536875008`), 1)
			}
			return body
		})},
		"a run past its file": {"org-a", rewrite(t, archive, func(h *tar.Header, body []byte) []byte {
			if h.Name == FileData+runsSuffix {
				return bytes.Replace(body, []byte(`"offset":536870912`), []byte(`"offset":1073741824`), 1)
			}
			return body
		})},
		"a path for a file": {"org-a", rewrite(t, archive, func(h *tar.Header, body []byte) []byte {
			if h.Name == FileMem {
				h.Name = "../" + FileMem
			}
			return body
		})},
		"cut short": {"org-a", archive[:len(archive)/2]},
	}
	for name, c := range cases {
		dst := newStore(t)
		_, err := dst.Import(c.org, bytes.NewReader(c.archive))
		if err == nil {
			t.Fatalf("%s: imported", name)
		}
		t.Logf("%s: %v", name, err)
		if left, _ := filepath.Glob(filepath.Join(dst.Dir(), "*", "*")); len(left) > 0 {
			t.Fatalf("%s: left %v", name, left)
		}
	}

	// An entry after the files.
	var extra bytes.Buffer
	extra.Write(archive[:len(archive)-1024]) // without the end-of-archive blocks
	tw := tar.NewWriter(&extra)
	_ = writeEntry(tw, "extra", 0o600, time.Now(), []byte("x"))
	_ = tw.Close()
	if _, err := newStore(t).Import("org-a", bytes.NewReader(extra.Bytes())); !errors.Is(err, ErrRefused) {
		t.Fatalf("an archive with more than the template: %v", err)
	}

	// Twice into one store: the id is there already.
	dst := newStore(t)
	if _, err := dst.Import("org-a", bytes.NewReader(archive)); err != nil {
		t.Fatal(err)
	}
	if _, err := dst.Import("org-a", bytes.NewReader(archive)); !errors.Is(err, ErrRefused) {
		t.Fatalf("the same template twice: %v", err)
	}
	if _, _, err := dst.Open("org-a", m.ID); err != nil {
		t.Fatalf("the second import broke the first: %v", err)
	}

	// A session never leaves its host.
	session := stage(t, src, "org-a", isolation.ShapeSandbox, isolation.PurposeSession)
	if err := src.Export("org-a", session.ID, io.Discard); !errors.Is(err, ErrRefused) {
		t.Fatalf("a session exported: %v", err)
	}
}

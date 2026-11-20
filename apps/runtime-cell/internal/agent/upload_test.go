package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// shellMachine is a machine whose workspace is a directory on the test
// host: each exec runs its command with sh from there, with its env, the
// way kody-exec runs it inside a machine.
func shellMachine(t *testing.T) (string, stubTransport) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, transport.Workspace), 0o755); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(root, transport.Workspace), stubTransport{exec: func(ctx context.Context, req kodyexec.Request) (kodyexec.Result, error) {
		cmd := exec.CommandContext(ctx, "sh", "-c", req.Command)
		cmd.Dir = filepath.Join(root, req.Cwd)
		cmd.Env = append([]string{"PATH=" + os.Getenv("PATH")}, req.Env...)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		err := cmd.Run()
		code := 0
		ee := &exec.ExitError{}
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else if err != nil {
			return kodyexec.Result{}, err
		}
		return kodyexec.Result{ExitCode: code, Stderr: stderr.String()}, nil
	}}
}

// objectStore serves each object at its path to a signed GET, and counts the reads.
type objectStore struct {
	srv   *httptest.Server
	reads atomic.Int64
}

func newObjectStore(t *testing.T, objects map[string][]byte) *objectStore {
	t.Helper()
	s := &objectStore{}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.reads.Add(1)
		body, ok := objects[strings.TrimPrefix(r.URL.Path, "/")]
		if r.Method != http.MethodGet || !ok || r.URL.Query().Get("sig") == "" {
			http.Error(w, "", http.StatusNotFound)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(s.srv.Close)
	return s
}

func (s *objectStore) url(key string) string {
	return s.srv.URL + "/" + key + "?exp=1&sig=SIGNATURE-VALUE"
}

func uploadHarness(t *testing.T, objects map[string][]byte) (*harness, *objectStore, string) {
	t.Helper()
	store := newObjectStore(t, objects)
	dir, tr := shellMachine(t)
	h := newHarness(t, func(c *Config) { c.Transport = tr; c.EvidenceHTTP = store.srv.Client() })
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	return h, store, dir
}

func digest(b []byte) *string { s := sha256.Sum256(b); h := hex.EncodeToString(s[:]); return &h }

func modeOf(m int64) *int64 { return &m }

const fixtureRef = "org-a/run-1/base/0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d/output"

func TestAnUploadWritesEachObjectAtItsPathWithItsMode(t *testing.T) {
	big := bytes.Repeat([]byte("0123456789abcdef"), 20_000) // 320 KB: several execs
	small := []byte("#!/bin/sh\necho hi\n")
	h, store, dir := uploadHarness(t, map[string][]byte{"big": big, "small": small, "empty": {}})
	b := &protocol.UploadBody{StepID: "0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d", Files: []protocol.UploadFile{
		{Path: "fixtures/deep/big.bin", ContentRef: fixtureRef, URL: store.url("big"), Sha256: digest(big)},
		{Path: "bin/run.sh", ContentRef: fixtureRef, URL: store.url("small"), Mode: modeOf(0o755)},
		{Path: "empty.txt", ContentRef: fixtureRef, URL: store.url("empty")},
	}}
	if err := h.handle("claim-1", protocol.MessageTypeUpload, b); err != nil {
		t.Fatalf("upload: %v", err)
	}
	res := h.conn.next(t, isResult(b.StepID)).(*protocol.StepResultBody)
	if res.VMHealth != protocol.VMHealthOk || res.Exec != nil {
		t.Fatalf("result %+v exec %+v", res, res.Exec)
	}
	for name, want := range map[string][]byte{"fixtures/deep/big.bin": big, "bin/run.sh": small, "empty.txt": {}} {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s: %d bytes, err %v; want %d bytes", name, len(got), err, len(want))
		}
	}
	if st, _ := os.Stat(filepath.Join(dir, "bin", "run.sh")); st.Mode().Perm() != 0o755 {
		t.Fatalf("mode %o", st.Mode().Perm())
	}
	if st, _ := os.Stat(filepath.Join(dir, "empty.txt")); st.Mode().Perm() != 0o644 {
		t.Fatalf("default mode %o", st.Mode().Perm())
	}
	if leftovers, _ := filepath.Glob(filepath.Join(dir, "fixtures", "deep", ".*")); len(leftovers) != 0 {
		t.Fatalf("staging files left: %v", leftovers)
	}
	if strings.Contains(h.logs.String(), "SIGNATURE-VALUE") {
		t.Fatalf("a read grant reached the log:\n%s", h.logs.String())
	}
	// The same step sent again with a freshly signed grant is the same step: acked, never run twice.
	reads := store.reads.Load()
	again := *b
	again.Files = append([]protocol.UploadFile(nil), b.Files...)
	again.Files[0].URL = store.url("big") + "&fresh=1"
	if err := h.handle("claim-1", protocol.MessageTypeUpload, &again); err != nil {
		t.Fatalf("upload again: %v", err)
	}
	if store.reads.Load() != reads {
		t.Fatal("a duplicate upload fetched again")
	}
}

func TestAnUploadWhoseBytesAreNotTheDigestOrOverTheBoundWritesNothing(t *testing.T) {
	over := bytes.Repeat([]byte("x"), MaxUploadFileBytes+1)
	h, store, dir := uploadHarness(t, map[string][]byte{"a": []byte("tampered"), "over": over})
	for i, f := range []protocol.UploadFile{
		{Path: "a.json", ContentRef: fixtureRef, URL: store.url("a"), Sha256: digest([]byte("original"))},
		{Path: "over.bin", ContentRef: fixtureRef, URL: store.url("over")},
		{Path: "missing.bin", ContentRef: fixtureRef, URL: store.url("missing")},
	} {
		b := &protocol.UploadBody{StepID: []string{"1b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d", "2b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d", "3b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d"}[i], Files: []protocol.UploadFile{f}}
		if err := h.handle("claim-1", protocol.MessageTypeUpload, b); err != nil {
			t.Fatalf("upload %s: %v", f.Path, err)
		}
		res := h.conn.next(t, isResult(b.StepID)).(*protocol.StepResultBody)
		if res.Exec == nil || res.Exec.ExitCode == 0 {
			t.Fatalf("%s: a failed upload reads as done: %+v", f.Path, res)
		}
		if strings.Contains(res.Exec.Stderr, "SIGNATURE-VALUE") || strings.Contains(res.Exec.Stderr, store.srv.URL) {
			t.Fatalf("%s: the result names the grant: %q", f.Path, res.Exec.Stderr)
		}
		if _, err := os.Stat(filepath.Join(dir, f.Path)); !os.IsNotExist(err) {
			t.Fatalf("%s was written: %v", f.Path, err)
		}
	}
}

func TestAnUploadIsRefusedBeforeItRunsOnAPathOrGrantTheCellDoesNotTake(t *testing.T) {
	h, store, _ := uploadHarness(t, map[string][]byte{"a": []byte("a")})
	for name, f := range map[string]protocol.UploadFile{
		"git dir":          {Path: "sub/.git/hooks/pre-commit", ContentRef: fixtureRef, URL: store.url("a")},
		"cell file":        {Path: ".kodus-compose.yml", ContentRef: fixtureRef, URL: store.url("a")},
		"absolute":         {Path: "/etc/passwd", ContentRef: fixtureRef, URL: store.url("a")},
		"dot dot":          {Path: "a/../../x", ContentRef: fixtureRef, URL: store.url("a")},
		"file url":         {Path: "a.txt", ContentRef: fixtureRef, URL: "file:///etc/passwd"},
		"credentials":      {Path: "a.txt", ContentRef: fixtureRef, URL: "https://u:p@evidence.example/a?sig=x"},
		"mode out of band": {Path: "a.txt", ContentRef: fixtureRef, URL: store.url("a"), Mode: modeOf(0o4755)},
	} {
		b := &protocol.UploadBody{StepID: "4b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d", Files: []protocol.UploadFile{f}}
		if code := nackCode(h.handle("claim-1", protocol.MessageTypeUpload, b)); code != "invalid_body" {
			t.Fatalf("%s: %q", name, code)
		}
	}
	if store.reads.Load() != 0 {
		t.Fatal("a refused upload fetched")
	}
}

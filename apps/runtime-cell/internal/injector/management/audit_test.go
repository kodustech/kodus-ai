package management

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
)

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}
func (b *lockedBuffer) String() string { b.mu.Lock(); defer b.mu.Unlock(); return b.buf.String() }

type failingVault struct {
	injector.RefusingVault
	err error
}

func (v failingVault) ListVersions(context.Context, injector.SecretScope) ([]injector.SecretVersionInfo, error) {
	return nil, v.err
}
func TestManagementAuditsOnlyClosedOperationOutcomeAndDuration(t *testing.T) {
	for _, expected := range []struct {
		err    error
		code   string
		status int
	}{{errors.New("synthetic-private-provider-detail"), "unavailable", 503}, {injector.ErrVaultDenied, "denied", 403}, {injector.ErrVaultCapacity, "capacity", 503}, {&Error{Code: "synthetic-private-code", Status: 418}, "unavailable", 503}} {
		t.Run(expected.code, func(t *testing.T) {
			var logs lockedBuffer
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			path := filepath.Join(privateDir(t), "admin.sock")
			ready := make(chan struct{})
			done := make(chan error, 1)
			go func() {
				done <- serve(ctx, path, failingVault{err: expected.err}, slog.New(slog.NewJSONHandler(&logs, nil)), ready)
			}()
			select {
			case <-ready:
			case <-time.After(time.Second):
				t.Fatal("startup timed out")
			}
			status, body, _ := rawCall(t, path, "/v1/vault/list", `{"organizationId":"org-a","environmentId":"env-a"}`)
			if status != expected.status || !strings.Contains(body, expected.code) || strings.Contains(body, "synthetic") {
				t.Fatalf("unsafe error response %d", status)
			}
			cancel()
			if e := <-done; e != nil {
				t.Fatal(e)
			}
			text := logs.String()
			if strings.Contains(text, "synthetic") || strings.Contains(text, "org-a") || strings.Contains(text, path) || !strings.Contains(text, `"operation":"list"`) || !strings.Contains(text, `"code":"`+expected.code+`"`) || !strings.Contains(text, `"duration_ms":`) {
				t.Fatalf("unsafe or missing audit metadata: %s", text)
			}
		})
	}
}
func TestManagementRejectsParentAliasesAndExistingSocketWithoutRemovingIt(t *testing.T) {
	base := privateDir(t)
	v := newVault(t, base)
	child := filepath.Join(base, "private")
	if e := os.Mkdir(child, 0700); e != nil {
		t.Fatal(e)
	}
	alias := filepath.Join(base, "alias")
	if e := os.Symlink(child, alias); e != nil {
		t.Fatal(e)
	}
	for _, p := range []string{filepath.Join(alias, "admin.sock"), "relative.sock", base + "/private/../admin.sock"} {
		if e := Serve(context.Background(), p, v, nil); e == nil {
			t.Fatal("noncanonical parent accepted")
		}
	}
	path := filepath.Join(child, "existing.sock")
	l, e := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if e != nil {
		t.Fatal(e)
	}
	l.SetUnlinkOnClose(false)
	defer l.Close()
	_ = os.Chmod(path, 0600)
	before, e := os.Lstat(path)
	if e != nil {
		t.Fatal(e)
	}
	if e = Serve(context.Background(), path, v, nil); e == nil {
		t.Fatal("existing socket accepted")
	}
	after, e := os.Lstat(path)
	if e != nil || !os.SameFile(before, after) {
		t.Fatal("foreign socket changed")
	}
}
func TestServerEnforcesMediaMethodPathAndTypedScalars(t *testing.T) {
	base := privateDir(t)
	socket, _, _ := startServer(t, newVault(t, base), base)
	cases := []struct {
		method, path, media, body string
		status                    int
	}{{"GET", "/v1/vault/list", "application/json", `{}`, 405}, {"POST", "/v1/vault/list?x=synthetic-secret", "application/json", `{}`, 404}, {"POST", "/v1/vault/list", "text/plain", `{}`, 400}, {"POST", "/v1/vault/put", "application/json", `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":1e0,"value":"synthetic","expiresAt":"2030-01-01T00:00:00Z"}`, 400}, {"POST", "/v1/vault/put", "application/json", `{"organizationId":"org-a","environmentId":"env-a","id":"payments","version":true,"value":"synthetic","expiresAt":"2030-01-01T00:00:00Z"}`, 400}, {"POST", "/v1/vault/list", "application/json", string([]byte{'{', '"', 0xff, '"', ':', '1', '}'}), 400}}
	for _, x := range cases {
		tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}}
		c := &http.Client{Transport: tr, Timeout: time.Second}
		r, e := http.NewRequest(x.method, "http://unix"+x.path, strings.NewReader(x.body))
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Content-Type", x.media)
		response, e := c.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		b, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		tr.CloseIdleConnections()
		if response.StatusCode != x.status || bytes.Contains(b, []byte("synthetic")) {
			t.Fatalf("media/method/path/scalar response %d", response.StatusCode)
		}
	}
}

func TestListenerPostBindGuardFailurePreservesOriginalIdentity(t *testing.T) {
	for _, replace := range []bool{false, true} {
		base := privateDir(t)
		path := filepath.Join(base, "admin.sock")
		_, e := listenValidated(path, func(path string, parent os.FileInfo) (os.FileInfo, error) {
			if replace {
				if e := os.Remove(path); e != nil {
					t.Fatal(e)
				}
				if e := os.WriteFile(path, []byte("foreign replacement"), 0600); e != nil {
					t.Fatal(e)
				}
			} else if e := os.Chmod(base, 0755); e != nil {
				t.Fatal(e)
			}
			return privateSocket(path, parent)
		})
		if e == nil {
			t.Fatal("post-bind guard mutation accepted")
		}
		_ = os.Chmod(base, 0700)
		if replace {
			b, e := os.ReadFile(path)
			if e != nil || string(b) != "foreign replacement" {
				t.Fatal("failed guard removed foreign node")
			}
		} else if _, e := os.Lstat(path); !os.IsNotExist(e) {
			t.Fatal("failed guard left its original socket")
		}
	}
}

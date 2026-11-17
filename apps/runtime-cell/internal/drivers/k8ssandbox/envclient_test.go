package k8ssandbox

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The client reaches the environment namespace's objects at their API
// paths (core for claims and logs, networking.k8s.io for policies), with
// the bearer token.
func TestTheClientReachesTheEnvironmentObjects(t *testing.T) {
	var mu sync.Mutex
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Method+" "+r.URL.Path+"?"+r.URL.RawQuery+" "+r.Header.Get("Authorization"))
		mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/log"):
			_, _ = w.Write([]byte("2026-11-17T10:00:00Z hello\n"))
		case r.Method == http.MethodPost && strings.Contains(r.URL.Path, "conflict"):
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"kind":"Status","reason":"AlreadyExists","message":"exists"}`))
		case r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"a"}}]}`))
		default:
			_, _ = w.Write([]byte(`{"metadata":{"name":"a"}}`))
		}
	}))
	defer srv.Close()
	c := &Client{Base: srv.URL, HTTP: srv.Client(), Token: func() (string, error) { return "tok", nil }}
	ctx := context.Background()
	if _, err := c.CreateObject(ctx, "envs", ResourceNetworkPolicies, Object{"metadata": map[string]any{"name": "a"}}); err != nil {
		t.Fatal(err)
	}
	if items, err := c.ListObjects(ctx, "envs", ResourceVolumeClaims, map[string]string{"kodus.io/claim": "c1", "kodus.io/cell": "x"}); err != nil || len(items) != 1 {
		t.Fatalf("%v %v", items, err)
	}
	if err := c.DeleteObject(ctx, "envs", ResourceVolumeClaims, "a"); err != nil {
		t.Fatal(err)
	}
	if out, err := c.PodLogs(ctx, "envs", "p", "web", time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC), 50); err != nil || !strings.Contains(string(out), "hello") {
		t.Fatalf("%q %v", out, err)
	}
	if _, err := c.CreateObject(ctx, "conflict", ResourceVolumeClaims, Object{}); !IsConflict(err) {
		t.Errorf("409: %v", err)
	}
	if _, err := c.CreateObject(ctx, "envs", Resource("secrets"), Object{}); err == nil {
		t.Error("a resource the cell does not make")
	}
	want := []string{
		"POST /apis/networking.k8s.io/v1/namespaces/envs/networkpolicies? Bearer tok",
		"GET /api/v1/namespaces/envs/persistentvolumeclaims?labelSelector=kodus.io%2Fcell%3Dx%2Ckodus.io%2Fclaim%3Dc1 Bearer tok",
		"DELETE /api/v1/namespaces/envs/persistentvolumeclaims/a? Bearer tok",
		"GET /api/v1/namespaces/envs/pods/p/log?container=web&sinceTime=2026-11-17T10%3A00%3A00Z&tailLines=50&timestamps=true Bearer tok",
	}
	for i, w := range want {
		if seen[i] != w {
			t.Errorf("request %d\n got %s\nwant %s", i, seen[i], w)
		}
	}
}

// RunCommand writes stdin then closes it (v5), keeps stdout and stderr up to
// the bound, and reads the exit code from the status channel.
func TestRunCommandReadsTheExitCodeAndClosesStdin(t *testing.T) {
	var gotStdin []byte
	var closed bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{execProtoV5}})
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		c.SetReadLimit(1 << 20)
		ctx := r.Context()
		if r.URL.Query().Get("stdin") == "true" {
			for {
				_, msg, err := c.Read(ctx)
				if err != nil {
					return
				}
				if len(msg) == 2 && msg[0] == chanClose {
					closed = true
					break
				}
				gotStdin = append(gotStdin, msg[1:]...)
			}
		}
		_ = c.Write(ctx, websocket.MessageBinary, append([]byte{chanStdout}, []byte(strings.Repeat("o", 40))...))
		_ = c.Write(ctx, websocket.MessageBinary, append([]byte{chanStderr}, []byte("bad thing")...))
		st, _ := json.Marshal(map[string]any{"status": "Failure", "reason": "NonZeroExitCode", "details": map[string]any{"causes": []any{map[string]any{"reason": "ExitCode", "message": "7"}}}})
		_ = c.Write(ctx, websocket.MessageBinary, append([]byte{chanStatus}, st...))
	}))
	defer srv.Close()
	c := &Client{Base: srv.URL, HTTP: srv.Client()}
	res, err := c.RunCommand(context.Background(), "envs", "p", "kodus-init", []string{"tar", "-x"}, []byte(strings.Repeat("d", 70<<10)), 16)
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 7 || len(res.Stdout) != 16 || !res.Truncated || string(res.Stderr) != "bad thing" {
		t.Errorf("%+v", res)
	}
	if len(gotStdin) != 70<<10 || !closed {
		t.Errorf("stdin %d bytes, closed %v", len(gotStdin), closed)
	}
	if exitCode([]byte(`{"status":"Success"}`)) != 0 || exitCode([]byte(`nope`)) != -1 {
		t.Error("status parse")
	}
}

// StreamCommand hands every line as it comes, stdout's and stderr's, a
// line split across messages whole and one past the bound cut, and returns
// the exit code.
func TestStreamCommandHandsEachLineAsItComes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{execProtoV5}})
		if err != nil {
			return
		}
		defer func() { _ = c.CloseNow() }()
		ctx := r.Context()
		for _, m := range [][]byte{
			append([]byte{chanStderr}, "#1 [internal] load build definition\n#1 DO"...),
			append([]byte{chanStderr}, "NE 0.1s\r\n"...),
			append([]byte{chanStdout}, "out line\n"...),
			append([]byte{chanStderr}, strings.Repeat("x", maxStreamLine+10)+"\nlast"...),
		} {
			_ = c.Write(ctx, websocket.MessageBinary, m)
		}
		st, _ := json.Marshal(map[string]any{"status": "Failure", "details": map[string]any{"causes": []any{map[string]any{"reason": "ExitCode", "message": "1"}}}})
		_ = c.Write(ctx, websocket.MessageBinary, append([]byte{chanStatus}, st...))
	}))
	defer srv.Close()
	c := &Client{Base: srv.URL, HTTP: srv.Client()}
	var lines []string
	code, err := c.StreamCommand(context.Background(), "envs", "p", "buildkitd", []string{"buildctl", "build"}, func(l string) { lines = append(lines, l) })
	if err != nil || code != 1 {
		t.Fatalf("code %d err %v", code, err)
	}
	if len(lines) != 5 || lines[0] != "#1 [internal] load build definition" || lines[1] != "#1 DONE 0.1s" || lines[2] != "out line" ||
		len(lines[3]) != maxStreamLine || lines[4] != "last" {
		t.Errorf("lines %q", lines)
	}
}

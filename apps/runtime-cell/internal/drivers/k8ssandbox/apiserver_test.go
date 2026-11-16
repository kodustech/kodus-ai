package k8ssandbox

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

// apiServer is the part of a Kubernetes API server the driver uses, in
// memory: pods in namespaces (create with dry run, get, list by label,
// merge-patch, delete), a kubelet that runs every created pod at once, and
// pods/exec over WebSocket (channel.k8s.io) that echoes stdin to stdout.
type apiServer struct {
	mu sync.Mutex
	// pods by ns/name.
	pods map[string]Object
	// paths every request asked for, and its Authorization header.
	paths []string
	auth  []string
	// admit, when set, answers a create before it is stored: a status code
	// (403 for admission) and its message; 0 admits.
	admit func(pod Object, dryRun bool) (int, string)
	// kubelet sets a created pod's status; nil: Running with an address.
	kubelet func(pod Object) map[string]any
	// execs are the commands exec ran, and closed counts v5 stdin closes.
	execs  [][]string
	closed int
	next   int
}

func newAPIServer() *apiServer { return &apiServer{pods: map[string]Object{}} }

func (s *apiServer) client(t *testing.T) *Client {
	t.Helper()
	srv := httptest.NewServer(s)
	t.Cleanup(srv.Close)
	return &Client{Base: srv.URL, HTTP: srv.Client(), Token: func() (string, error) { return "sa-token", nil }}
}

func writeStatus(w http.ResponseWriter, code int, reason, msg string) {
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"kind": "Status", "status": "Failure", "reason": reason, "message": msg, "code": code})
}

func labelsOf(o Object) map[string]any {
	l, _ := meta(o)["labels"].(map[string]any)
	return l
}

func matches(o Object, selector string) bool {
	if selector == "" {
		return true
	}
	have := labelsOf(o)
	for _, kv := range strings.Split(selector, ",") {
		k, v, _ := strings.Cut(kv, "=")
		if fmt.Sprint(have[k]) != v {
			return false
		}
	}
	return true
}

func (s *apiServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.paths = append(s.paths, r.Method+" "+r.URL.Path)
	s.auth = append(s.auth, r.Header.Get("Authorization"))
	s.mu.Unlock()
	// /api/v1/namespaces/{ns}/pods[/{name}[/exec]]
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 5 || parts[0] != "api" || parts[2] != "namespaces" || parts[4] != "pods" {
		writeStatus(w, http.StatusNotFound, "NotFound", "no such path")
		return
	}
	ns := parts[3]
	switch {
	case len(parts) == 5 && r.Method == http.MethodPost:
		s.create(w, r, ns)
	case len(parts) == 5 && r.Method == http.MethodGet:
		s.mu.Lock()
		var items []Object
		for _, p := range s.pods {
			if meta(p)["namespace"] == ns && matches(p, r.URL.Query().Get("labelSelector")) {
				items = append(items, p)
			}
		}
		s.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
	case len(parts) == 7 && parts[6] == "exec":
		s.exec(r.Context(), w, r, ns, parts[5])
	case len(parts) == 6:
		s.one(w, r, ns, parts[5])
	default:
		writeStatus(w, http.StatusNotFound, "NotFound", "no such path")
	}
}

func (s *apiServer) create(w http.ResponseWriter, r *http.Request, ns string) {
	var pod Object
	if err := json.NewDecoder(r.Body).Decode(&pod); err != nil {
		writeStatus(w, http.StatusBadRequest, "BadRequest", err.Error())
		return
	}
	dry := r.URL.Query().Get("dryRun") == "All"
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.admit != nil {
		if code, msg := s.admit(pod, dry); code != 0 {
			writeStatus(w, code, "Forbidden", msg)
			return
		}
	}
	if dry {
		_ = json.NewEncoder(w).Encode(pod)
		return
	}
	md := meta(pod)
	md["namespace"] = ns
	key := ns + "/" + fmt.Sprint(md["name"])
	if _, ok := s.pods[key]; ok {
		writeStatus(w, http.StatusConflict, "AlreadyExists", "pod exists")
		return
	}
	s.next++
	if s.kubelet != nil {
		pod["status"] = s.kubelet(pod)
	} else {
		pod["status"] = map[string]any{"phase": "Running", "podIP": fmt.Sprintf("10.244.0.%d", s.next)}
	}
	s.pods[key] = pod
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(pod)
}

func (s *apiServer) one(w http.ResponseWriter, r *http.Request, ns, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := ns + "/" + name
	p, ok := s.pods[key]
	if !ok {
		writeStatus(w, http.StatusNotFound, "NotFound", "pod not found")
		return
	}
	switch r.Method {
	case http.MethodGet:
		_ = json.NewEncoder(w).Encode(p)
	case http.MethodDelete:
		delete(s.pods, key)
		_, _ = w.Write([]byte("{}"))
	case http.MethodPatch:
		if r.Header.Get("Content-Type") != "application/merge-patch+json" {
			writeStatus(w, http.StatusUnsupportedMediaType, "UnsupportedMediaType", "merge patch only")
			return
		}
		var patch Object
		_ = json.NewDecoder(r.Body).Decode(&patch)
		ann, _ := meta(patch)["annotations"].(map[string]any)
		cur, _ := meta(p)["annotations"].(map[string]any)
		if cur == nil {
			cur = map[string]any{}
			meta(p)["annotations"] = cur
		}
		for k, v := range ann {
			cur[k] = v
		}
		_ = json.NewEncoder(w).Encode(p)
	}
}

// exec echoes every stdin message back on stdout until the client closes
// stdin (v5) or the connection.
func (s *apiServer) exec(ctx context.Context, w http.ResponseWriter, r *http.Request, ns, name string) {
	s.mu.Lock()
	_, ok := s.pods[ns+"/"+name]
	s.execs = append(s.execs, append([]string{r.URL.Query().Get("container")}, r.URL.Query()["command"]...))
	s.mu.Unlock()
	if !ok {
		writeStatus(w, http.StatusNotFound, "NotFound", "pod not found")
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{execProtoV5, execProtoV4}})
	if err != nil {
		return
	}
	defer func() { _ = c.CloseNow() }()
	for {
		_, msg, err := c.Read(ctx)
		if err != nil {
			return
		}
		if len(msg) == 2 && msg[0] == chanClose && msg[1] == chanStdin {
			s.mu.Lock()
			s.closed++
			s.mu.Unlock()
			_ = c.Write(ctx, websocket.MessageBinary, append([]byte{chanStatus}, []byte(`{"status":"Success"}`)...))
			return
		}
		if len(msg) > 0 && msg[0] == chanStdin {
			_ = c.Write(ctx, websocket.MessageBinary, append([]byte{chanStderr}, []byte("guest: frame")...))
			_ = c.Write(ctx, websocket.MessageBinary, append([]byte{chanStdout}, msg[1:]...))
		}
	}
}

func (s *apiServer) pod(ns, name string) Object {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pods[ns+"/"+name]
}

func (s *apiServer) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.pods)
}

var _ io.Closer = (*execStream)(nil)

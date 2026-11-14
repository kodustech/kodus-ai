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

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/reaper"
)

// apiServer is the part of a Kubernetes API server the reaper uses.
type apiServer struct {
	mu      sync.Mutex
	pods    map[string]Object // ns/name
	deleted []string
	auth    []string
}

func (s *apiServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.auth = append(s.auth, r.Header.Get("Authorization"))
	if r.URL.Path == "/api/v1/pods" && r.Method == http.MethodGet {
		var items []Object
		for _, p := range s.pods {
			items = append(items, p)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
		return
	}
	// /api/v1/namespaces/{ns}/pods/{name}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 6 || parts[2] != "namespaces" || parts[4] != "pods" {
		http.NotFound(w, r)
		return
	}
	ns, name := parts[3], parts[5]
	p, ok := s.pods[ns+"/"+name]
	if !ok {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodGet:
		_ = json.NewEncoder(w).Encode(p)
	case http.MethodDelete:
		delete(s.pods, ns+"/"+name)
		s.deleted = append(s.deleted, ns+"/"+name)
		_, _ = w.Write([]byte("{}"))
	}
}

func pod(ns, name, cell, hard string) Object {
	return Object{"metadata": map[string]any{
		"namespace": ns, "name": name,
		"labels":      map[string]any{label(driver.TagCell): cell, label(driver.TagClaim): "claim-1"},
		"annotations": map[string]any{label(driver.TagHardExpires): hard},
	}}
}

// The chart's reaper runs -driver k8s-sandbox: it lists this cell's pods
// and deletes the ones past kodus:hard-expires, with its own token.
func TestReaperOnKubernetesDeletesOnlyThisCellsExpiredPods(t *testing.T) {
	now := time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)
	api := &apiServer{pods: map[string]Object{
		"kodus-claim-1/old":   pod("kodus-claim-1", "old", "cell-1", driver.FormatTime(now.Add(-time.Minute))),
		"kodus-claim-1/young": pod("kodus-claim-1", "young", "cell-1", driver.FormatTime(now.Add(time.Hour))),
	}}
	srv := httptest.NewServer(api)
	defer srv.Close()
	k := &PodClient{Base: srv.URL, HTTP: srv.Client(), Token: func() (string, error) { return "sa-token", nil }}
	r := &reaper.Reaper{CellID: "cell-1", Driver: NewForReaper(k, "cell-1"), Now: func() time.Time { return now }}
	rep, err := r.Run(context.Background())
	if err != nil || rep.Seen != 2 || len(rep.Terminated) != 1 {
		t.Fatalf("%+v %v", rep, err)
	}
	if len(api.deleted) != 1 || api.deleted[0] != "kodus-claim-1/old" || api.auth[0] != "Bearer sa-token" {
		t.Fatalf("deleted %v auth %v", api.deleted, api.auth)
	}
	if err := k.Apply(context.Background(), Object{}); err == nil {
		t.Fatal("the reaper's client created something")
	}
}

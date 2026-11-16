package injector

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

const inspectedHost = "public.example"

// inspectedRig is the rig with public.example on the inspected tier (no
// credential) and registry.private both credentialed and inspected.
func inspectedRig(t *testing.T, opts ...func(*Injector)) *rig {
	t.Helper()
	r := newRig(t, opts...)
	pol, _ := r.inj.Policies.ForClaim("claim-1")
	pol.Inspected = []policy.InspectRule{
		{Host: host, Paths: []string{"/"}},
		{Host: inspectedHost, Paths: []string{"/pkg/"}},
	}
	pol.InspectSources, pol.IssuedAt = []string{"127.0.0.1"}, time.Now()
	if err := r.inj.Policies.Put(pol); err != nil {
		t.Fatal(err)
	}
	return r
}

func (r *rig) do(t *testing.T, method, url string, body io.Reader) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, url, body)
	resp, err := r.vm.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// S-56 Inspected tier, end to end through the proxy and the injector: POST,
// PUT and a path outside the prefix are refused before anything leaves; the
// GET under the prefix goes out with no credential.
func TestS56InspectedTierLetsOnlyReadsOut(t *testing.T) {
	r := inspectedRig(t)
	code, body := r.do(t, http.MethodGet, "https://"+inspectedHost+"/pkg/a.tgz", nil)
	if code != http.StatusOK {
		t.Fatalf("GET under the path: %d %q", code, body)
	}
	if got := (<-r.seen).Get("Authorization"); got != "" {
		t.Fatalf("an inspected-only host got a credential: %q", got)
	}
	for _, c := range []struct {
		method, path string
		body         io.Reader
		reason       string
	}{
		{http.MethodPost, "/pkg/a", strings.NewReader("x"), policy.InspectMethod},
		{http.MethodPut, "/pkg/a", strings.NewReader("{}"), policy.InspectMethod},
		{http.MethodGet, "/other", nil, policy.InspectPath},
	} {
		code, body := r.do(t, c.method, "https://"+inspectedHost+c.path, c.body)
		if code != http.StatusForbidden || !strings.Contains(body, c.reason) {
			t.Fatalf("%s %s: %d %q, want 403 %s", c.method, c.path, code, body, c.reason)
		}
	}
	select {
	case h := <-r.seen:
		t.Fatalf("a refused request reached the upstream: %v", h)
	default:
	}
}

// Host ≠ SNI on an inspected host is refused like on a credentialed one.
func TestS56InspectedHostWithAnotherHostHeaderIsRefused(t *testing.T) {
	r := inspectedRig(t)
	req, _ := http.NewRequest(http.MethodGet, "https://"+inspectedHost+"/pkg/a", nil)
	req.Host = "other.example"
	resp, err := r.vm.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMisdirectedRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

// S-53 on a credentialed registry the tier inspects: npm publish (a PUT)
// never reaches the upstream, even with the token the injector holds.
func TestS53PublishToAnInspectedCredentialedRegistryIsRefused(t *testing.T) {
	r := inspectedRig(t)
	code, body := r.do(t, http.MethodPut, "https://"+host+"/left-pad", bytes.NewReader([]byte(`{"_attachments":{}}`)))
	if code != http.StatusForbidden || !strings.Contains(body, policy.InspectMethod) {
		t.Fatalf("publish: %d %q", code, body)
	}
	select {
	case h := <-r.seen:
		t.Fatalf("the publish reached the registry: %v", h)
	default:
	}
	// A read still gets the credential.
	if code, _ := r.do(t, http.MethodGet, "https://"+host+"/left-pad", nil); code != http.StatusOK {
		t.Fatalf("read: %d", code)
	}
	if got := (<-r.seen).Get("Authorization"); got != secret {
		t.Fatalf("read went without its credential: %q", got)
	}
}

// A read on the inspected tier is a download (an image layer, a toolchain):
// nothing in it is masked or held, and the egress budget is on what leaves.
// The credentialed cap cut a Docker Hub layer at 256 MiB; the inspected tier
// has a cap of its own, past any real artifact.
func TestAnInspectedDownloadIsNotCutAtTheCredentialedCap(t *testing.T) {
	r := inspectedRig(t, func(in *Injector) { in.MaxResponse = 1024 })
	code, body := r.do(t, http.MethodGet, "https://"+inspectedHost+"/pkg/big", nil)
	<-r.seen
	if code != http.StatusOK || len(body) != 4096 {
		t.Fatalf("an inspected download past the credentialed cap: %d, %d bytes", code, len(body))
	}
	if defaultMaxInspectedResponse < 8<<30 {
		t.Fatalf("the inspected cap %d is below a large image layer", defaultMaxInspectedResponse)
	}

	cut := inspectedRig(t, func(in *Injector) { in.MaxInspectedResponse = 1024 })
	resp, err := cut.vm.Get("https://" + inspectedHost + "/pkg/big")
	if err == nil {
		_, err = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	<-cut.seen
	if err == nil {
		t.Fatal("a response past the inspected cap read as complete")
	}
}

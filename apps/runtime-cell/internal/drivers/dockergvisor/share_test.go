package dockergvisor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
)

// shareRegistry is the org's registry in memory, the part of the
// distribution API remotecache uses: blobs checked on upload, manifests by
// tag and by digest. down answers 503 to everything; tamper rewrites a
// manifest's bytes on GET (a registry that serves other bytes than the
// digest the hub recorded).
type shareRegistry struct {
	mu        sync.Mutex
	blobs     map[string][]byte
	manifests map[string][]byte
	uploads   int
	gets      int
	down      bool
	tamper    bool
}

func digestOfBytes(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}

func (f *shareRegistry) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.down {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	if f.blobs == nil {
		f.blobs, f.manifests = map[string][]byte{}, map[string][]byte{}
	}
	p := strings.TrimPrefix(r.URL.Path, "/v2/")
	switch {
	case strings.Contains(p, "/blobs/uploads/") && r.Method == http.MethodPost:
		repo, _, _ := strings.Cut(p, "/blobs/uploads/")
		f.uploads++
		w.Header().Set("Location", "/v2/"+repo+"/blobs/uploads/u"+strings.Repeat("x", f.uploads))
		w.WriteHeader(http.StatusAccepted)
	case strings.Contains(p, "/blobs/uploads/") && r.Method == http.MethodPut:
		repo, _, _ := strings.Cut(p, "/blobs/uploads/")
		body, _ := io.ReadAll(r.Body)
		d := r.URL.Query().Get("digest")
		if digestOfBytes(body) != d {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.blobs[repo+"@"+d] = body
		w.WriteHeader(http.StatusCreated)
	case strings.Contains(p, "/blobs/"):
		i := strings.Index(p, "/blobs/")
		b, ok := f.blobs[p[:i]+"@"+p[i+len("/blobs/"):]]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if r.Method != http.MethodHead {
			_, _ = w.Write(b)
		}
	case strings.Contains(p, "/manifests/"):
		i := strings.Index(p, "/manifests/")
		key := p[:i] + ":" + p[i+len("/manifests/"):]
		if r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			f.manifests[key] = body
			f.manifests[p[:i]+":"+digestOfBytes(body)] = body
			w.Header().Set("Docker-Content-Digest", digestOfBytes(body))
			w.WriteHeader(http.StatusCreated)
			return
		}
		f.gets++
		b, ok := f.manifests[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if f.tamper {
			b = append([]byte{' '}, b...)
		}
		_, _ = w.Write(b)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *shareRegistry) manifestGets() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gets
}

// serve is reg on a loopback URL, as the cell's flag names it.
func serve(t *testing.T, reg http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(reg)
	t.Cleanup(srv.Close)
	return srv
}

func shareStore(t *testing.T, srv *httptest.Server) *remotecache.Registry {
	t.Helper()
	r, err := remotecache.New(remotecache.Config{URL: srv.URL + "/kodus-bake"})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// cell is one cell of the org: its own Docker, catalog and work directory,
// pushing to push and pulling from pull (nil: no store).
func cell(t *testing.T, id string, push, pull *remotecache.Registry) (*Driver, *memDocker) {
	t.Helper()
	d, docker := bakeDriver(t)
	d.cfg.CellID = id
	if push != nil {
		d.share = push
	}
	if pull != nil {
		d.sharePull = pull
	}
	return d, docker
}

func cellMachine(cellID, org, claim string) driver.MachineRef {
	return driver.MachineRef{MachineID: "kodus-" + claim + "-workload", Tags: map[string]string{
		driver.TagCell: cellID, driver.TagOrg: org, driver.TagEnv: bakeEnv, driver.TagClaim: claim,
	}}
}

// bakeOn bakes what a setup claim built on d and returns what the bake
// reported shared, once its push is done (nil: it reported nothing).
func bakeOn(t *testing.T, d *Driver, dir string, secrets ...string) *driver.SharedBake {
	t.Helper()
	ctx := context.Background()
	setup := cellMachine(d.cfg.CellID, bakeOrg, "claim-setup")
	boot(t, d, setup, sandbox.Build{Service: "api", Context: dir, Dockerfile: "Dockerfile"})
	if err := d.PinBakeSource(ctx, setup); err != nil {
		t.Fatal(err)
	}
	spec := bakeSpec(setup)
	spec.CellID, spec.Secrets = d.cfg.CellID, secrets
	var mu sync.Mutex
	var got *driver.SharedBake
	spec.Shared = func(b driver.SharedBake) { mu.Lock(); got = &b; mu.Unlock() }
	img, err := d.Bake(ctx, spec)
	if err != nil {
		t.Fatalf("the bake failed: %v", err)
	}
	if err := d.AcknowledgeBake(ctx, img.ImageID); err != nil {
		t.Fatal(err)
	}
	d.WaitRemotePushes()
	mu.Lock()
	defer mu.Unlock()
	return got
}

func bootShared(t *testing.T, d *Driver, ref driver.MachineRef, shared []driver.SharedImage, dir string) map[string]string {
	t.Helper()
	built, _, err := d.build(context.Background(), ref, []sandbox.Build{{Service: "api", Context: dir, Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, shared)
	if err != nil {
		t.Fatal(err)
	}
	return built
}

// The goal of shared bakes: cell A bakes the environment and pushes its
// image to the org's registry; cell B, which never baked it, boots a claim
// from it by the digest the hub recorded, without building, and holds A's
// image under its own name. A second claim on B takes B's copy and pulls
// nothing more.
func TestASecondCellBootsFromTheFirstCellsBakeWithoutBuilding(t *testing.T) {
	reg := &shareRegistry{}
	store := shareStore(t, serve(t, reg))
	dir := project(t)
	a, dockerA := cell(t, "cell-a", store, store)
	shared := bakeOn(t, a, dir)
	if shared == nil || len(shared.Images) != 1 || shared.OrgID != bakeOrg || shared.EnvironmentID != bakeEnv || shared.SHA != strings.Repeat("a", 40) {
		t.Fatalf("shared %+v", shared)
	}
	baked := bakedImageOf(t, a, dockerA)

	b, dockerB := cell(t, "cell-b", store, store)
	built := bootShared(t, b, cellMachine("cell-b", bakeOrg, "claim-base"), shared.Images, dir)
	if len(dockerB.builds) != 0 {
		t.Fatalf("cell B built %d times", len(dockerB.builds))
	}
	if got := dockerB.layers[built["api"]]; got == "" || got != dockerA.layers[baked] {
		t.Fatalf("cell B's image holds %q, A baked %q", got, dockerA.layers[baked])
	}
	gets := reg.manifestGets()
	bootShared(t, b, cellMachine("cell-b", bakeOrg, "claim-pr"), shared.Images, dir)
	if len(dockerB.builds) != 0 || reg.manifestGets() != gets {
		t.Fatalf("the second claim built %d times or pulled again (%d gets, was %d)", len(dockerB.builds), reg.manifestGets(), gets)
	}
}

// bakedImageOf is the one image d's environment baked.
func bakedImageOf(t *testing.T, d *Driver, docker *memDocker) string {
	t.Helper()
	repo, _ := bakeRepo(d.cfg.CellID, bakeOrg, bakeEnv)
	refs, _ := docker.ImageRefs(context.Background(), repo)
	if len(refs) != 1 {
		t.Fatalf("baked %v", refs)
	}
	return refs[0]
}

// A push that fails is logged and the bake stands: the registry down, or an
// image that carries one of the setup claim's secret values (never pushed).
func TestAPushThatFailsLeavesTheBakeDone(t *testing.T) {
	t.Run("registry down", func(t *testing.T) {
		reg := &shareRegistry{down: true}
		store := shareStore(t, serve(t, reg))
		a, _ := cell(t, "cell-a", store, store)
		if got := bakeOn(t, a, project(t)); got != nil {
			t.Fatalf("reported %+v", got)
		}
	})
	t.Run("a secret in a layer", func(t *testing.T) {
		reg := &shareRegistry{}
		store := shareStore(t, serve(t, reg))
		a, dockerA := cell(t, "cell-a", store, store)
		dir := project(t)
		// The setup's build wrote the database password into the image.
		dockerA.layerPrefix = "PGPASSWORD=s3cr3t-db-password\n"
		if got := bakeOn(t, a, dir, "s3cr3t-db-password"); got != nil {
			t.Fatalf("an image with a secret was shared: %+v", got)
		}
		if reg.uploads != 0 {
			t.Fatalf("%d blobs reached the registry", reg.uploads)
		}
	})
}

// Every failure of the pull leaves cell B where it was before shared bakes:
// it builds the service itself. The registry down; a registry serving other
// bytes than the digest the hub recorded; another org's digest, which names
// nothing in this org's repository.
func TestAFailedPullBuildsLocally(t *testing.T) {
	dir := project(t)
	for name, c := range map[string]struct {
		org  string
		prep func(*shareRegistry)
	}{
		"registry down":   {bakeOrg, func(r *shareRegistry) { r.down = true }},
		"digest mismatch": {bakeOrg, func(r *shareRegistry) { r.tamper = true }},
		"another org":     {"org-b", func(*shareRegistry) {}},
	} {
		t.Run(name, func(t *testing.T) {
			reg := &shareRegistry{}
			store := shareStore(t, serve(t, reg))
			a, _ := cell(t, "cell-a", store, store)
			shared := bakeOn(t, a, dir)
			if shared == nil {
				t.Fatal("nothing shared")
			}
			c.prep(reg)
			b, dockerB := cell(t, "cell-b", store, store)
			built := bootShared(t, b, cellMachine("cell-b", c.org, "claim-base"), shared.Images, dir)
			if len(dockerB.builds) != 1 || !dockerB.images[built["api"]] {
				t.Fatalf("cell B built %d times, holds %v", len(dockerB.builds), dockerB.images[built["api"]])
			}
		})
	}
}

// A cell may pull from a mirror near it (-gvisor-bake-share-pull: a
// pull-through cache, a read-only replica) while pushes go to the org's
// registry. The digest pin holds on that path: the mirror answers the pull,
// the origin is never asked; a mirror that misses or is down leaves the cell
// building locally, with no fallback to the origin.
func TestPullsGoToTheMirrorAndAMirrorMissBuildsLocally(t *testing.T) {
	dir := project(t)
	origin := &shareRegistry{}
	originStore := shareStore(t, serve(t, origin))
	a, _ := cell(t, "cell-a", originStore, originStore)
	shared := bakeOn(t, a, dir)
	if shared == nil {
		t.Fatal("nothing shared")
	}

	t.Run("from the mirror", func(t *testing.T) {
		mirror := &pullThrough{origin: origin}
		b, dockerB := cell(t, "cell-b", originStore, shareStore(t, serve(t, mirror)))
		before := origin.manifestGets()
		bootShared(t, b, cellMachine("cell-b", bakeOrg, "claim-base"), shared.Images, dir)
		if len(dockerB.builds) != 0 || mirror.served == 0 || origin.manifestGets() != before {
			t.Fatalf("built %d, mirror served %d, origin asked %d times", len(dockerB.builds), mirror.served, origin.manifestGets()-before)
		}
	})
	for name, mirror := range map[string]*shareRegistry{"mirror misses": {}, "mirror down": {down: true}} {
		t.Run(name, func(t *testing.T) {
			b, dockerB := cell(t, "cell-b", originStore, shareStore(t, serve(t, mirror)))
			before := origin.manifestGets()
			bootShared(t, b, cellMachine("cell-b", bakeOrg, "claim-base"), shared.Images, dir)
			if len(dockerB.builds) != 1 || origin.manifestGets() != before {
				t.Fatalf("built %d, origin asked %d times", len(dockerB.builds), origin.manifestGets()-before)
			}
		})
	}
}

// pullThrough is a mirror that serves what origin holds, reading origin's
// storage directly (as a cache already filled would), and counts what it served.
type pullThrough struct {
	origin *shareRegistry
	mu     sync.Mutex
	served int
}

func (p *pullThrough) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	p.mu.Lock()
	p.served++
	p.mu.Unlock()
	o := p.origin
	o.mu.Lock()
	defer o.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, "/v2/")
	var b []byte
	var ok bool
	if i := strings.Index(path, "/manifests/"); i >= 0 {
		b, ok = o.manifests[path[:i]+":"+path[i+len("/manifests/"):]]
	} else if i := strings.Index(path, "/blobs/"); i >= 0 {
		b, ok = o.blobs[path[:i]+"@"+path[i+len("/blobs/"):]]
	}
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	_, _ = w.Write(b)
}

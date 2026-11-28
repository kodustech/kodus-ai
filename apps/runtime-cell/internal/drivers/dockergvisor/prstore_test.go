package dockergvisor

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// The PR image in the shared store (docs/runtime/shared-image-store.md section 5), at the driver: what
// the PR side pushes, what a shard pulls instead of building, and what leaves a claim building as before.

const prToken = "bearer-token-of-the-claim"

// scopedStore is the store's registry as the hub's tokens scope it: every request carries the claim's bearer token
// and names only a repository the token lists, a write only where it has the push right. Anything else is a 401 or 403.
type scopedStore struct {
	inner  *shareRegistry
	mu     sync.Mutex
	denied []string
	pull   map[string]bool
	push   map[string]bool
	token  func() string
}

func (s *scopedStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+s.token() {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	p := strings.TrimPrefix(r.URL.Path, "/v2/")
	repo := p
	for _, cut := range []string{"/blobs/", "/manifests/"} {
		if i := strings.Index(p, cut); i >= 0 {
			repo = p[:i]
		}
	}
	write := r.Method == http.MethodPut || r.Method == http.MethodPost
	if (write && !s.push[repo]) || (!write && !s.pull[repo] && !s.push[repo]) {
		s.mu.Lock()
		s.denied = append(s.denied, r.Method+" "+repo)
		s.mu.Unlock()
		w.WriteHeader(http.StatusForbidden)
		return
	}
	s.inner.ServeHTTP(w, r)
}

type prFixture struct {
	reg  *shareRegistry
	srv  *scopedStore
	url  string
	repo string
}

func newPRFixture(t *testing.T) *prFixture {
	t.Helper()
	reg := &shareRegistry{}
	f := &prFixture{reg: reg, repo: "kodus-ci/o-aaa/e-bbb/pr-ccc"}
	f.srv = &scopedStore{inner: reg, pull: map[string]bool{}, push: map[string]bool{f.repo: true}, token: func() string { return prToken }}
	f.url = serve(t, f.srv).URL
	return f
}

func (f *prFixture) creds(push bool, expires time.Time) *driver.StoreCreds {
	return driver.NewStoreCreds(driver.StoreGrant{
		Endpoint: f.url, Prefix: "kodus-ci", Token: prToken, ExpiresAt: expires,
		Repos: []driver.StoreRepo{{Scope: "pr", Name: f.repo, Pull: true, Push: push}},
	})
}

// builderPush boots the PR side as Up does (bind, build, push) and returns what its push said.
func builderPush(t *testing.T, d *Driver, creds *driver.StoreCreds, dir string, secrets ...string) driver.PRPush {
	t.Helper()
	got := make(chan driver.PRPush, 1)
	ref := cellMachine(d.cfg.CellID, bakeOrg, "claim-pr-side")
	d.bindPRStore(ref, driver.UpRequest{Ref: ref, ImageStore: creds, PRPushed: func(p driver.PRPush) { got <- p }, BuildSecrets: map[string]string{"npm": "placeholder-1"}})
	if _, _, err := d.build(context.Background(), ref, []sandbox.Build{{Service: "api", Context: dir, Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil); err != nil {
		t.Fatal(err)
	}
	d.startPRPush(ref)
	d.WaitRemotePushes()
	select {
	case p := <-got:
		return p
	case <-time.After(5 * time.Second):
		t.Fatal("the push said nothing")
		return driver.PRPush{}
	}
}

// shardBoot boots a suite shard as Up does and returns what it built.
func shardBoot(t *testing.T, d *Driver, creds *driver.StoreCreds, images []driver.SharedImage, dir string) map[string]string {
	t.Helper()
	ref := cellMachine(d.cfg.CellID, bakeOrg, "claim-shard-0")
	d.bindPRStore(ref, driver.UpRequest{Ref: ref, ImageStore: creds, PRImages: images})
	built, _, err := d.build(context.Background(), ref, []sandbox.Build{{Service: "api", Context: dir, Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	return built
}

func asShared(p driver.PRPush) []driver.SharedImage {
	var out []driver.SharedImage
	for _, im := range p.Images {
		out = append(out, driver.SharedImage{Fingerprint: im.Fingerprint, Digest: im.Digest})
	}
	return out
}

// The goal: the PR side builds once and pushes its image by digest; a shard on another host, which never built it,
// pulls that digest instead of building, and the registry only ever saw the claim's own token on its own repository.
func TestAShardPullsThePRImageTheBuilderPushedAndDoesNotBuild(t *testing.T) {
	f := newPRFixture(t)
	dir := project(t)
	pr, dockerPR := cell(t, "cell-pr", nil, nil)
	pushed := builderPush(t, pr, f.creds(true, time.Now().Add(time.Hour)), dir)
	if !pushed.OK || len(pushed.Images) != 1 || len(dockerPR.builds) != 1 {
		t.Fatalf("push %+v, builds %d", pushed, len(dockerPR.builds))
	}

	shard, dockerShard := cell(t, "cell-shard", nil, nil)
	built := shardBoot(t, shard, f.creds(false, time.Now().Add(time.Hour)), asShared(pushed), dir)
	if len(dockerShard.builds) != 0 {
		t.Fatalf("the shard built %d times", len(dockerShard.builds))
	}
	if got := dockerShard.layers[built["api"]]; got == "" || got != dockerPR.layers[builtTag("kodus-claim-pr-side-workload", "api")] {
		t.Fatalf("the shard's image holds %q", got)
	}
	if len(f.srv.denied) != 0 {
		t.Fatalf("the registry refused %v", f.srv.denied)
	}
}

// A shard whose digest is not the registry's bytes, whose token expired, or whose store is down builds the image
// itself: the store only makes a boot faster and never fails one.
func TestAShardThatCannotPullTheImageBuildsItItself(t *testing.T) {
	dir := project(t)
	for name, c := range map[string]struct {
		prep    func(*prFixture)
		expires time.Duration
	}{
		"store down":        {func(f *prFixture) { f.reg.down = true }, time.Hour},
		"digest mismatch":   {func(f *prFixture) { f.reg.tamper = true }, time.Hour},
		"token expired":     {func(*prFixture) {}, -time.Minute},
		"the token refused": {func(f *prFixture) { f.srv.token = func() string { return "another" } }, time.Hour},
	} {
		t.Run(name, func(t *testing.T) {
			f := newPRFixture(t)
			pr, _ := cell(t, "cell-pr", nil, nil)
			pushed := builderPush(t, pr, f.creds(true, time.Now().Add(time.Hour)), dir)
			c.prep(f)
			shard, dockerShard := cell(t, "cell-shard", nil, nil)
			built := shardBoot(t, shard, f.creds(false, time.Now().Add(c.expires)), asShared(pushed), dir)
			if len(dockerShard.builds) != 1 || !dockerShard.images[built["api"]] {
				t.Fatalf("the shard built %d times, holds %v", len(dockerShard.builds), dockerShard.images[built["api"]])
			}
		})
	}
}

// A shard offered no digest for its build (the builder pushed another fingerprint, or none) builds it.
func TestAShardWithNoDigestForItsBuildBuildsIt(t *testing.T) {
	f := newPRFixture(t)
	shard, dockerShard := cell(t, "cell-shard", nil, nil)
	other := []driver.SharedImage{{Fingerprint: strings.Repeat("9", 64), Digest: "sha256:" + strings.Repeat("8", 64)}}
	shardBoot(t, shard, f.creds(false, time.Now().Add(time.Hour)), other, project(t))
	if len(dockerShard.builds) != 1 {
		t.Fatalf("built %d times", len(dockerShard.builds))
	}
}

// A claim whose grant has no push right on the PR repository pushes nothing, even when it built.
func TestAClaimWithoutAPushRightPushesNothing(t *testing.T) {
	f := newPRFixture(t)
	pr, _ := cell(t, "cell-pr", nil, nil)
	ref := cellMachine("cell-pr", bakeOrg, "claim-pr-side")
	told := false
	pr.bindPRStore(ref, driver.UpRequest{Ref: ref, ImageStore: f.creds(false, time.Now().Add(time.Hour)), PRPushed: func(driver.PRPush) { told = true }})
	if _, _, err := pr.build(context.Background(), ref, []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil); err != nil {
		t.Fatal(err)
	}
	pr.startPRPush(ref)
	pr.WaitRemotePushes()
	if told || f.reg.uploads != 0 {
		t.Fatalf("told %v, %d blobs reached the store", told, f.reg.uploads)
	}
}

// An image with one of the claim's secret values in a layer is never pushed, and the push says why.
func TestAnImageWithASecretInALayerIsNotPushed(t *testing.T) {
	f := newPRFixture(t)
	pr, docker := cell(t, "cell-pr", nil, nil)
	docker.layerPrefix = "NPM_TOKEN=placeholder-1\n"
	got := builderPush(t, pr, f.creds(true, time.Now().Add(time.Hour)), project(t))
	if got.OK || got.Reason != "secret_in_image" || f.reg.uploads != 0 {
		t.Fatalf("push %+v, %d blobs reached the store", got, f.reg.uploads)
	}
}

// A store that is down at push time leaves the builder's boot as it was: the push reports failed, and the hub
// tells the shards to build.
func TestAPushToAStoreThatIsDownReportsFailed(t *testing.T) {
	f := newPRFixture(t)
	f.reg.down = true
	pr, docker := cell(t, "cell-pr", nil, nil)
	got := builderPush(t, pr, f.creds(true, time.Now().Add(time.Hour)), project(t))
	if got.OK || got.Reason != "push_failed" || len(docker.builds) != 1 {
		t.Fatalf("push %+v, builds %d", got, len(docker.builds))
	}
}

// A grant never reaches a log line: its String says no token.
func TestAGrantFormatsWithoutItsToken(t *testing.T) {
	g := driver.StoreGrant{Token: prToken}
	if s := g.String(); strings.Contains(s, prToken) {
		t.Fatal(s)
	}
	c := driver.NewStoreCreds(g)
	if strings.Contains(c.String(), prToken) {
		t.Fatal("creds")
	}
}

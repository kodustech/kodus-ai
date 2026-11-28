package dockergvisor

import (
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const (
	cacheToken   = "canary-token-7f3a9c1d"
	cacheRepo    = "kodus-ci/o-aaa/e-bbb/cache"
	cacheMainRep = "kodus-ci/o-aaa/e-bbb/main"
)

// cacheCreds is a grant naming main and the cache repository; push is the right on the cache.
func cacheCreds(token string, push bool) *driver.StoreCreds {
	return driver.NewStoreCreds(driver.StoreGrant{
		Endpoint: "https://store.example:5000", Prefix: "kodus-ci", Token: token, ExpiresAt: time.Now().Add(10 * time.Minute),
		Repos: []driver.StoreRepo{{Scope: "main", Name: cacheMainRep, Pull: true}, {Scope: "cache", Name: cacheRepo, Pull: true, Push: push}},
	})
}

// bootWithGrant boots a machine that holds creds, as Up does, and returns the build the builder was asked for.
func bootWithGrant(t *testing.T, d *Driver, docker *memDocker, claim string, creds *driver.StoreCreds, seeding bool) dockercli.BuildRun {
	t.Helper()
	ref := machine(claim, bakeEnv)
	if seeding {
		asSetup(d, ref, true)
	}
	d.bindPRStore(ref, driver.UpRequest{Ref: ref, ImageStore: creds})
	boot(t, d, ref, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	return docker.builds[len(docker.builds)-1]
}

// The goal: the cache reference is the hub's cache repository on the grant's registry host, with one tag per
// service, and a reference that could add an attribute to BuildKit's list is refused.
func TestTheCacheRefIsTheGrantsCacheRepositoryWithATagPerService(t *testing.T) {
	g := cacheCreds(cacheToken, true).Current()
	host, api, insecure, err := cacheRefOf(g, cacheRepo, "api")
	if err != nil || host != "store.example:5000" || insecure || !strings.HasPrefix(api, "store.example:5000/"+cacheRepo+":s-") {
		t.Fatalf("host %q ref %q insecure %v err %v", host, api, insecure, err)
	}
	_, web, _, _ := cacheRefOf(g, cacheRepo, "web")
	if web == api {
		t.Fatal("two services share one cache tag")
	}
	g.Endpoint = "http://127.0.0.1:5000"
	if _, _, insecure, err := cacheRefOf(g, cacheRepo, "api"); err != nil || !insecure {
		t.Fatalf("a loopback http store: insecure %v err %v", insecure, err)
	}
	g.Endpoint = "ftp://x"
	if _, _, _, err := cacheRefOf(g, cacheRepo, "api"); err == nil {
		t.Fatal("a non-http endpoint gave a reference")
	}
	if _, _, _, err := cacheRefOf(cacheCreds(cacheToken, true).Current(), "kodus-ci/o-a/cache,ref=evil", "api"); err == nil {
		t.Fatal("a repository with a comma gave a reference")
	}
}

// The goal: a PR side imports main's cache and never exports, even when its grant carried a push right on the cache.
func TestAPRSideImportsMainsCacheAndNeverExportsIt(t *testing.T) {
	d, docker := bakeDriver(t)
	got := bootWithGrant(t, d, docker, "claim-pr", cacheCreds(cacheToken, true), false)
	if got.RemoteCacheFrom == "" || got.RemoteCacheTo != "" {
		t.Fatalf("PR side: import %q export %q, want an import and no export", got.RemoteCacheFrom, got.RemoteCacheTo)
	}
}

// The goal: the default branch's seeding setup both imports and exports the cache, to the same reference, when its
// grant holds the push right; a setup whose grant is read-only exports nothing.
func TestASeedingSetupExportsOnlyWithThePushRight(t *testing.T) {
	d, docker := bakeDriver(t)
	got := bootWithGrant(t, d, docker, "claim-setup", cacheCreds(cacheToken, true), true)
	if got.RemoteCacheTo == "" || got.RemoteCacheTo != got.RemoteCacheFrom {
		t.Fatalf("seeding setup: import %q export %q", got.RemoteCacheFrom, got.RemoteCacheTo)
	}
	got = bootWithGrant(t, d, docker, "claim-setup-ro", cacheCreds(cacheToken, false), true)
	if got.RemoteCacheTo != "" {
		t.Fatalf("a read-only grant exported to %q", got.RemoteCacheTo)
	}
	// A setup that does not seed (a bake's build) keeps its cache on the cell, push right or not.
	ref := machine("claim-noseed", bakeEnv)
	asSetup(d, ref, false)
	d.bindPRStore(ref, driver.UpRequest{Ref: ref, ImageStore: cacheCreds(cacheToken, true)})
	boot(t, d, ref, sandbox.Build{Service: "api", Context: project(t), Dockerfile: "Dockerfile"})
	if c := docker.builds[len(docker.builds)-1]; c.RemoteCacheTo != "" {
		t.Fatalf("a setup that does not seed exported to %q", c.RemoteCacheTo)
	}
}

// The goal: a claim whose grant has no cache repository, or none at all, uses no registry cache and no docker config.
func TestAClaimWithoutACacheGrantUsesNoRegistryCache(t *testing.T) {
	d, docker := bakeDriver(t)
	prOnly := driver.NewStoreCreds(driver.StoreGrant{Endpoint: "https://s", Token: cacheToken, ExpiresAt: time.Now().Add(time.Minute),
		Repos: []driver.StoreRepo{{Scope: "pr", Name: "kodus-ci/o-aaa/e-bbb/pr-ccc", Pull: true}}})
	for name, creds := range map[string]*driver.StoreCreds{"a grant with no cache scope": prOnly, "no grant": nil} {
		got := bootWithGrant(t, d, docker, "claim-"+strings.ReplaceAll(name, " ", "-"), creds, false)
		if got.RemoteCacheFrom != "" || got.RemoteCacheTo != "" || got.DockerConfig != "" {
			t.Fatalf("%s: %+v", name, got)
		}
	}
}

// The goal: with a cache grant the cell's own transfer of the cache (the flag's static credential) is not used, and
// without one the flag's path still works as before.
func TestTheGrantReplacesTheCellsOwnTransferAndTheFlagStillWorksWithoutOne(t *testing.T) {
	d, docker := bakeDriver(t)
	remote := &fakeRemote{}
	d.remote = remote
	bootWithGrant(t, d, docker, "claim-granted", cacheCreds(cacheToken, true), true)
	d.WaitRemotePushes()
	if len(remote.pushes)+len(remote.pulls) != 0 {
		t.Fatalf("a granted claim used the cell's transfer: pushes %v pulls %v", remote.pushes, remote.pulls)
	}
	bootWithGrant(t, d, docker, "claim-flag", nil, true)
	d.WaitRemotePushes()
	if len(remote.pushes) == 0 {
		t.Fatal("the flag's path no longer pushes when the claim has no grant")
	}
}

// The goal: the builder reads the token from a config.json in a directory of its own, and the directory is gone when the
// build ends, whether it succeeded or failed.
func TestTheTokenFileIsRemovedWhenTheBuildEnds(t *testing.T) {
	for _, fail := range []bool{false, true} {
		d, docker := bakeDriver(t)
		var seen string
		docker.duringBuild = func(b dockercli.BuildRun) {
			raw, err := os.ReadFile(filepath.Join(b.DockerConfig, "config.json"))
			if err != nil || !strings.Contains(string(raw), cacheToken) || !strings.Contains(string(raw), "store.example:5000") {
				t.Errorf("the builder's config: %q %v", raw, err)
			}
			seen = b.DockerConfig
		}
		if fail {
			docker.buildErr = fmt.Errorf("compile failed")
		}
		ref := machine("claim-rm", bakeEnv)
		d.bindPRStore(ref, driver.UpRequest{Ref: ref, ImageStore: cacheCreds(cacheToken, false)})
		_, _, _ = d.build(context.Background(), ref, []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, "net", "resolv", bakeSubnet, nil, nil)
		if seen == "" {
			t.Fatalf("fail=%v: the builder was given no docker config", fail)
		}
		if _, err := os.Stat(seen); !os.IsNotExist(err) {
			t.Fatalf("fail=%v: the token directory is still there (%v)", fail, err)
		}
	}
}

// The goal: a token renewed while the build runs reaches the file the builder reads, so the export at the end of a
// build longer than the token's life still carries a valid one.
func TestARenewedTokenReachesTheFileOfABuildInFlight(t *testing.T) {
	d, docker := bakeDriver(t)
	creds := cacheCreds("token-one", true)
	var after string
	docker.duringBuild = func(b dockercli.BuildRun) {
		next := creds.Current()
		next.Token, next.ExpiresAt = "token-two", next.ExpiresAt.Add(10*time.Minute)
		creds.Renew(next)
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
			raw, _ := os.ReadFile(filepath.Join(b.DockerConfig, "config.json"))
			if after = string(raw); strings.Contains(after, "token-two") {
				return
			}
		}
	}
	bootWithGrant(t, d, docker, "claim-rotate", creds, true)
	if !strings.Contains(after, "token-two") || strings.Contains(after, "token-one") {
		t.Fatalf("after the renewal the builder's file says %q", after)
	}
}

// The goal: the token appears in no log line, in nothing the builder's command line says, and in no file of the build
// context or the build's output (where the image comes from).
func TestTheTokenIsNeverInLogsArgsContextOrOutput(t *testing.T) {
	d, docker := bakeDriver(t)
	var logs bytes.Buffer
	d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ctxDir := project(t)
	var outDir string
	docker.duringBuild = func(b dockercli.BuildRun) { outDir = b.Out }
	ref := machine("claim-canary", bakeEnv)
	asSetup(d, ref, true)
	creds := cacheCreds(cacheToken, true)
	d.bindPRStore(ref, driver.UpRequest{Ref: ref, ImageStore: creds})
	d.log().Info("a grant formats redacted", "grant", creds.Current(), "creds", creds)
	boot(t, d, ref, sandbox.Build{Service: "api", Context: ctxDir, Dockerfile: "Dockerfile"})
	if strings.Contains(logs.String(), cacheToken) {
		t.Fatalf("the token is in the logs:\n%s", logs.String())
	}
	run := docker.builds[len(docker.builds)-1]
	run.DockerConfig = "" // the path of the directory is the one place the builder is told to look
	if strings.Contains(fmt.Sprintf("%+v", run), cacheToken) {
		t.Fatalf("the token is in the build request: %+v", run)
	}
	for _, root := range []string{ctxDir, outDir} {
		_ = filepath.WalkDir(root, func(p string, e fs.DirEntry, err error) error {
			if err == nil && e.Type().IsRegular() {
				if b, _ := os.ReadFile(p); strings.Contains(string(b), cacheToken) {
					t.Errorf("the token is in %s", p)
				}
			}
			return nil
		})
	}
}

// The goal: a build's facts say how long BuildKit's cache import and export took and what share of its steps came
// from a cache, and a build with no remote cache says none of it.
func TestBuildTimingSaysTheRemoteCacheImportExportAndHitRate(t *testing.T) {
	d, docker := bakeDriver(t)
	var logs bytes.Buffer
	d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	docker.buildOutput = []string{
		"#1 importing cache manifest from store.example:5000/x", "#1 DONE 2.5s",
		"#2 [1/3] FROM docker.io/library/node:22", "#2 CACHED",
		"#3 [2/3] RUN npm ci", "#3 CACHED",
		"#4 [3/3] RUN npm run build", "#4 DONE 10.0s",
		"#5 exporting cache to registry", "#5 DONE 4.0s",
	}
	bootWithGrant(t, d, docker, "claim-facts", cacheCreds(cacheToken, true), true)
	ev := buildEvents(t, &logs, "build.timing")
	if len(ev) != 1 {
		t.Fatalf("build.timing events: %d", len(ev))
	}
	e := ev[0]
	if e["cacheRemoteImport"] != true || e["cacheRemoteExport"] != true || e["cacheImportMs"] != float64(2500) || e["cacheExportMs"] != float64(4000) ||
		e["layersCached"] != float64(2) || e["layerHitRate"] != "0.40" {
		t.Fatalf("remote cache facts: %+v", e)
	}
	logs.Reset()
	bootWithGrant(t, d, docker, "claim-nofacts", nil, false)
	if e := buildEvents(t, &logs, "build.timing")[0]; e["cacheRemoteImport"] != nil || e["cacheImportMs"] != nil || e["cacheExportMs"] != nil {
		t.Fatalf("a build with no remote cache reported remote facts: %+v", e)
	}
}

// The goal: every build, remote cache or not, says which cache input it started from and what share of its steps a
// cache answered, so a PR build that ran cold shows as input "cold" with a hit rate of 0 and not as silence.
func TestBuildTimingAlwaysSaysTheCacheInputAndTheLayerHitRate(t *testing.T) {
	d, docker := bakeDriver(t)
	var logs bytes.Buffer
	d.cfg.Log = slog.New(slog.NewJSONHandler(&logs, nil))
	docker.buildOutput = []string{
		"#1 [1/3] FROM docker.io/library/node:22", "#1 DONE 1.0s",
		"#2 [2/3] RUN npm ci", "#2 DONE 60.0s",
		"#3 [3/3] RUN npm run build", "#3 DONE 10.0s",
	}
	bootWithGrant(t, d, docker, "claim-cold", nil, false)
	e := buildEvents(t, &logs, "build.timing")[0]
	if e["cacheInput"] != "cold" || e["layersCached"] != float64(0) || e["layersTotal"] != float64(3) || e["layerHitRate"] != "0.00" {
		t.Fatalf("a cold build: %+v", e)
	}
	if e["cacheRemoteImport"] != nil {
		t.Fatalf("a build with no remote cache reported one: %+v", e)
	}
}

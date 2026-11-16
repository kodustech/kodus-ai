package dockergvisor

import (
	"maps"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
)

func TestEveryBuildGetsTheMirrorsAndTheProjectsOwnValueWins(t *testing.T) {
	cfg := Config{MirrorGoProxy: "http://mirror.cell.internal:8080/go,off", MirrorNPM: "http://mirror.cell.internal:8080/npm/", MirrorPyPI: "http://mirror.cell.internal:8080/pypi/simple/"}
	got := mirrorBuildArgs(map[string]string{"NODE_ENV": "production"}, cfg)
	want := map[string]string{
		"NODE_ENV": "production", "GOPROXY": cfg.MirrorGoProxy, "npm_config_registry": cfg.MirrorNPM, "pnpm_config_registry": cfg.MirrorNPM,
		"YARN_NPM_REGISTRY_SERVER": "http://mirror.cell.internal:8080/npm", "YARN_UNSAFE_HTTP_WHITELIST": "mirror.cell.internal",
		"PIP_INDEX_URL": cfg.MirrorPyPI, "PIP_TRUSTED_HOST": "mirror.cell.internal",
		"UV_DEFAULT_INDEX": cfg.MirrorPyPI, "UV_INSECURE_HOST": "mirror.cell.internal",
	}
	if !maps.Equal(got, want) {
		t.Fatalf("%v", got)
	}
	own := map[string]string{"npm_config_registry": "https://npm.corp.example/", "PIP_INDEX_URL": "https://pypi.corp.example/simple/"}
	got = mirrorBuildArgs(own, cfg)
	if got["npm_config_registry"] != own["npm_config_registry"] || got["PIP_INDEX_URL"] != own["PIP_INDEX_URL"] {
		t.Fatalf("the project's registry was replaced: %v", got)
	}
	if _, set := got["PIP_TRUSTED_HOST"]; set {
		t.Fatal("the mirror is trusted for an index the project chose")
	}
	if args := mirrorBuildArgs(nil, Config{}); args != nil {
		t.Fatalf("no mirror, args %v", args)
	}
}

// Every name the cell passes is one the shared list gives, the list Kody's
// recipe author declares in the Dockerfiles it writes.
func TestTheBuildArgsAreTheSharedListsNames(t *testing.T) {
	cfg := Config{MirrorGoProxy: "http://m:8080/go,off", MirrorNPM: "http://m:8080/npm/", MirrorPyPI: "http://m:8080/pypi/simple/"}
	npm, pypi, goproxy := netguard.MirrorBuildArgNames()
	want := map[string]bool{}
	for _, n := range append(append(npm, pypi...), goproxy...) {
		want[n] = true
	}
	got := mirrorBuildArgs(nil, cfg)
	for k := range got {
		if !want[k] {
			t.Errorf("%s is passed but not in the shared list", k)
		}
	}
	for k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("%s is in the shared list but not passed", k)
		}
	}
}

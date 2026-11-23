package buildmirror

import (
	"maps"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
)

func TestEveryBuildGetsTheMirrorsAndTheProjectsOwnValueWins(t *testing.T) {
	m := Mirror{GoProxy: "http://mirror.cell.internal:8080/go,off", NPM: "http://mirror.cell.internal:8080/npm/", PyPI: "http://mirror.cell.internal:8080/pypi/simple/", Artifacts: "http://mirror.cell.internal:8080/artifacts/"}
	got := m.Args(map[string]string{"NODE_ENV": "production"})
	want := map[string]string{
		"NODE_ENV": "production", "GOPROXY": m.GoProxy, "npm_config_registry": m.NPM, "pnpm_config_registry": m.NPM,
		"YARN_NPM_REGISTRY_SERVER": "http://mirror.cell.internal:8080/npm", "YARN_UNSAFE_HTTP_WHITELIST": "mirror.cell.internal",
		"PIP_INDEX_URL": m.PyPI, "PIP_TRUSTED_HOST": "mirror.cell.internal",
		"UV_DEFAULT_INDEX": m.PyPI, "UV_INSECURE_HOST": "mirror.cell.internal",
		"PRISMA_ENGINES_MIRROR": "http://mirror.cell.internal:8080/artifacts/prisma", "MONGOMS_DOWNLOAD_MIRROR": "http://mirror.cell.internal:8080/artifacts/mongodb",
	}
	if !maps.Equal(got, want) {
		t.Fatalf("%v", got)
	}
	own := map[string]string{"npm_config_registry": "https://npm.corp.example/", "PIP_INDEX_URL": "https://pypi.corp.example/simple/"}
	got = m.Args(own)
	if got["npm_config_registry"] != own["npm_config_registry"] || got["PIP_INDEX_URL"] != own["PIP_INDEX_URL"] {
		t.Fatalf("the project's registry was replaced: %v", got)
	}
	if _, set := got["PIP_TRUSTED_HOST"]; set {
		t.Fatal("the mirror is trusted for an index the project chose")
	}
	if args := (Mirror{}).Args(nil); args != nil {
		t.Fatalf("no mirror, args %v", args)
	}
}

// Every name the cell passes is one the shared list gives, the list Kody's
// recipe author declares in the Dockerfiles it writes.
func TestTheBuildArgsAreTheSharedListsNames(t *testing.T) {
	m := Mirror{GoProxy: "http://m:8080/go,off", NPM: "http://m:8080/npm/", PyPI: "http://m:8080/pypi/simple/", Artifacts: "http://m:8080/artifacts/"}
	npm, pypi, goproxy := netguard.MirrorBuildArgNames()
	want := map[string]bool{}
	for _, n := range append(append(append(npm, pypi...), goproxy...), netguard.MirrorArtifactBuildArgNames()...) {
		want[n] = true
	}
	got := m.Args(nil)
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

func TestAMirrorBaseGivesEveryEcosystemUnderTheEgressPaths(t *testing.T) {
	m, err := At("http://mirror.cell.internal:8080")
	if err != nil {
		t.Fatal(err)
	}
	want := Mirror{GoProxy: "http://mirror.cell.internal:8080/go,off", NPM: "http://mirror.cell.internal:8080/npm/", PyPI: "http://mirror.cell.internal:8080/pypi/simple/", Artifacts: "http://mirror.cell.internal:8080/artifacts/", Registry: "mirror.cell.internal:8080"}
	if m != want {
		t.Fatalf("%+v", m)
	}
	if m, err := At(""); err != nil || m != (Mirror{}) {
		t.Fatalf("no base: %+v %v", m, err)
	}
	for _, bad := range []string{"https://mirror.cell.internal:8080", "http://mirror.cell.internal", "http://mirror.cell.internal:8080/npm/", "http://u:p@mirror.cell.internal:8080", "mirror.cell.internal:8080"} {
		if _, err := At(bad); err == nil {
			t.Errorf("%q was taken", bad)
		}
	}
}

func TestTheRegistryConfigPullsDockerHubThroughTheMirrorOverHTTP(t *testing.T) {
	conf, err := RegistryConfig("mirror.cell.internal:8080")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`[registry."docker.io"]`, `mirrors = ["mirror.cell.internal:8080"]`, `[registry."mirror.cell.internal:8080"]`, "http = true"} {
		if !strings.Contains(string(conf), want) {
			t.Fatalf("missing %q in\n%s", want, conf)
		}
	}
	if _, err := RegistryConfig("mirror\"]\n[x]"); err == nil {
		t.Fatal("a value that breaks out of the TOML string was taken")
	}
}

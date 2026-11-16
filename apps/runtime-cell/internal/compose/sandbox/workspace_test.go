package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// workspace is a claim of two repositories: ws/shop (the project) beside
// ws/billing, and a directory outside the workspace.
func workspace(t *testing.T) (root, shop, outside string) {
	t.Helper()
	base := t.TempDir()
	root = filepath.Join(base, "ws")
	shop = filepath.Join(root, "shop")
	outside = filepath.Join(base, "outside")
	for _, d := range []string{filepath.Join(shop, "src"), filepath.Join(root, "billing", "conf"), outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, f := range []string{filepath.Join(root, "billing", "Dockerfile"), filepath.Join(shop, "Dockerfile"), filepath.Join(outside, "Dockerfile"), filepath.Join(root, "billing", ".env")} {
		if err := os.WriteFile(f, []byte("FROM scratch\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root, shop, outside
}

func wsOpts(root, shop string) Options {
	o := opts(shop)
	o.Root = root
	return o
}

const twoRepos = `
services:
  api:
    build: .
    volumes: ["./src:/app/src"]
  billing:
    build: { context: ../billing }
    env_file: ../billing/.env
    volumes:
      - ../billing/conf:/etc/billing
      - type: bind
        source: ../billing/conf
        target: /etc/billing2
`

// A project of a workspace may build and bind another repository's
// directory (../<alias>): it resolves inside the workspace, and the cell's
// rewrite names it by its absolute path.
func TestAWorkspaceProjectReachesItsOtherRepositories(t *testing.T) {
	root, shop, _ := workspace(t)
	builds, err := Builds([]byte(twoRepos), wsOpts(root, shop))
	if err != nil {
		t.Fatal(err)
	}
	resolved, _ := filepath.EvalSymlinks(root)
	if len(builds) != 2 || builds[0].Service != "api" || builds[0].Context != filepath.Join(resolved, "shop") || builds[1].Context != filepath.Join(resolved, "billing") {
		t.Fatalf("builds %+v", builds)
	}
	o := wsOpts(root, shop)
	o.Built = map[string]string{"api": "kodus-build/api", "billing": "kodus-build/billing"}
	out, err := Apply([]byte(twoRepos), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	vols := doc["services"].(map[string]any)["billing"].(map[string]any)["volumes"].([]any)
	for _, v := range vols {
		m := v.(map[string]any)
		if m["source"] != filepath.Join(resolved, "billing", "conf") || m["read_only"] != true {
			t.Fatalf("bind %v", m)
		}
	}
}

// One repository keeps its rule: ../billing is outside the project.
func TestOneRepositoryStillRefusesItsParent(t *testing.T) {
	root, shop, _ := workspace(t)
	_ = root
	_, err := Builds([]byte(twoRepos), opts(shop))
	var refused *RefusedError
	if !errors.As(err, &refused) || !strings.Contains(err.Error(), "services.billing.build.context: bind outside the project") {
		t.Fatalf("err %v", err)
	}
	if _, err := Apply([]byte(twoRepos), opts(shop)); !errors.As(err, &refused) {
		t.Fatalf("apply %v", err)
	}
}

// Nothing leaves the workspace: not by "..", not by an absolute path, not
// through a symlink inside it, not through another repository that is a
// symlink, and not from a project directory outside it.
func TestAWorkspaceRefusesWhatLeavesIt(t *testing.T) {
	root, shop, outside := workspace(t)
	if err := os.Symlink(outside, filepath.Join(root, "billing", "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "evil")); err != nil {
		t.Fatal(err)
	}
	for name, file := range map[string]string{
		"dotdot":         "services:\n  a: { image: x, volumes: [\"../../outside:/x\"] }\n",
		"dotdot build":   "services:\n  a: { build: ../../outside }\n",
		"absolute":       "services:\n  a: { image: x, volumes: [\"" + outside + ":/x\"] }\n",
		"link in a repo": "services:\n  a: { image: x, volumes: [\"../billing/link:/x\"] }\n",
		"link build":     "services:\n  a: { build: ../billing/link }\n",
		"repo is a link": "services:\n  a: { build: ../evil }\n",
		"env file out":   "services:\n  a: { image: x, env_file: ../../outside/Dockerfile }\n",
	} {
		t.Run(name, func(t *testing.T) {
			o := wsOpts(root, shop)
			o.Built = map[string]string{"a": "kodus-build/a"}
			var refused *RefusedError
			// A build section is Builds' to check; Apply then swaps it for
			// the image the cell built.
			if strings.Contains(file, "build:") {
				if _, err := Builds([]byte(file), o); !errors.As(err, &refused) {
					t.Fatalf("builds accepted it: %v", err)
				}
				return
			}
			if _, err := Apply([]byte(file), o); !errors.As(err, &refused) {
				t.Fatalf("apply accepted it: %v", err)
			}
		})
	}
	// A project directory that is not in the workspace is refused whole.
	if _, err := Apply([]byte(good), wsOpts(root, outside)); err == nil || !strings.Contains(err.Error(), "outside the workspace") {
		t.Fatalf("project outside: %v", err)
	}
	// A project directory that is a symlink inside the workspace too.
	if err := os.Symlink(shop, filepath.Join(root, "shoplink")); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveWithin(root, filepath.Join(root, "shoplink"), "src"); err == nil {
		t.Fatal("a project directory reached through a symlink")
	}
}

// The second reader holds the same line on what compose will run.
func TestVerifyCanonicalHoldsTheWorkspace(t *testing.T) {
	root, shop, outside := workspace(t)
	resolved, _ := filepath.EvalSymlinks(root)
	bind := func(src string) []byte {
		return []byte(`{"services":{"a":{"image":"x","runtime":"runsc","networks":{"kodus-claim":{}},"security_opt":["no-new-privileges:true"],"pids_limit":2048,"mem_limit":"4g","cpus":"2","cap_drop":["ALL"],"labels":{"kodus.claim":"claim-1","kodus.hard-expires":"2026-10-29T13:00:00Z"},"volumes":[{"type":"bind","source":"` + src + `","target":"/x","read_only":true}]}},"networks":{"kodus-claim":{"name":"kodus-claim-1","external":true}}}`)
	}
	o := wsOpts(root, shop)
	err := VerifyCanonical(bind(filepath.Join(resolved, "billing", "conf")), o)
	if err != nil && strings.Contains(err.Error(), "outside the project") {
		t.Fatalf("a bind of another repository: %v", err)
	}
	if err := VerifyCanonical(bind(outside), o); err == nil || !strings.Contains(err.Error(), "outside the project") {
		t.Fatalf("a bind outside the workspace: %v", err)
	}
}

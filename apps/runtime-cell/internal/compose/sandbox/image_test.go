package sandbox

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// F3-01: a service the cell did not build ran whatever its image: named,
// so another org's bake tag or a 4-hex prefix of any image ID on the shared
// Docker booted that image under the PR's claim, and the host's daemon pulled
// any registry the file named. Apply accepted both unchanged.
func TestAServiceTheCellDidNotBuildNamesOnlyARegistryImage(t *testing.T) {
	dir := checkout(t)
	refusedImages := []string{
		"484e",                  // a short image ID
		"sha256:484e",           // an ID by its algorithm
		"DEADBEEF",              // hex in any case
		strings.Repeat("a", 64), // a whole ID
		"kodus-bake/c/otherorg/env:gen-fp",
		"docker.io/kodus-bake/c/otherorg/env:gen-fp", // the same image, by Docker Hub's name
		"index.docker.io/kodus-shared/otherorg/env:fp",
		"library/kodus-build/claim-2-api:claim",
		"kodus-build/claim-2-api:claim",
		"ghcr.io/kodus-build/x:1",                                  // the cell's namespace on any registry
		"127.0.0.1:5000/kodus/x@sha256:" + strings.Repeat("b", 64), // a loopback transfer
		"localhost:5000/app:1",
		"10.0.0.5:5000/app:1",
		"[::1]:5000/app:1",
		"registry:5000/app:1", // a single-label host
		"registry.internal/app:1",
		"Postgres:16",         // not a reference compose reads the same way
		"postgres@sha256:abc", // a digest that is not one
		"postgres:",           // an empty tag
		" postgres",
	}
	for _, img := range refusedImages {
		compose := "services:\n  db:\n    image: " + strings.TrimSpace(yamlQuote(img)) + "\n"
		_, err := Apply([]byte(compose), opts(dir))
		var re *RefusedError
		if !errors.As(err, &re) {
			t.Errorf("image %q accepted (err %v)", img, err)
		}
	}
	for _, img := range []string{
		"postgres:16", "pgvector/pgvector:pg16", "ghcr.io/acme/node:22", "docker.io/library/redis:7",
		"registry.example/api@sha256:" + strings.Repeat("c", 64), "public.ecr.aws/docker/library/node:22-alpine", "quay.io/kodustech/x:1",
	} {
		compose := "services:\n  db:\n    image: " + yamlQuote(img) + "\n"
		if _, err := Apply([]byte(compose), opts(dir)); err != nil {
			t.Errorf("image %q refused: %v", img, err)
		}
	}
	// A service with neither a build the cell made nor an image runs nothing
	// the cell can name.
	if _, err := Apply([]byte("services:\n  db:\n    command: [sleep, '1']\n"), opts(dir)); err == nil {
		t.Error("a service with no image accepted")
	}
}

// F3-01: compose pulled every image it did not find, on the host's daemon:
// outside the claim's egress, with the cell's registry logins, with no image
// bound. Now every service runs with pull_policy never, whatever the file
// asked, and the driver pulls (PullImages).
func TestComposeNeverPulls(t *testing.T) {
	dir := checkout(t)
	compose := "services:\n  db:\n    image: postgres:16\n    pull_policy: always\n  web:\n    image: nginx\n"
	out, err := Apply([]byte(compose), opts(dir))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	for name, s := range doc["services"].(map[string]any) {
		if pp := s.(map[string]any)["pull_policy"]; pp != "never" {
			t.Errorf("%s: pull_policy %v", name, pp)
		}
	}
}

// The second reader refuses what the first would: a canonical config whose
// service names a local image or may pull.
func TestVerifyCanonicalRefusesLocalImagesAndPulls(t *testing.T) {
	dir := checkout(t)
	ok := canonical(``)
	if err := VerifyCanonical([]byte(ok), opts(dir)); err != nil {
		t.Fatal(err)
	}
	for name, cfg := range map[string]string{
		"short id":        strings.Replace(ok, `"image":"x"`, `"image":"484e"`, 1),
		"another's bake":  strings.Replace(ok, `"image":"x"`, `"image":"kodus-bake/c/otherorg/env:gen"`, 1),
		"pull missing":    strings.Replace(ok, `"pull_policy":"never"`, `"pull_policy":"missing"`, 1),
		"no pull policy":  strings.Replace(ok, `,"pull_policy":"never"`, ``, 1),
		"loopback source": strings.Replace(ok, `"image":"x"`, `"image":"127.0.0.1:5000/x:1"`, 1),
	} {
		var re *RefusedError
		if err := VerifyCanonical([]byte(cfg), opts(dir)); !errors.As(err, &re) {
			t.Errorf("%s accepted: %v", name, err)
		}
	}
	// The cell's own build keeps its kodus-build name.
	o := opts(dir)
	o.Built = map[string]string{"api": "kodus-build/claim-1-api:claim"}
	built := strings.Replace(ok, `"image":"x"`, `"image":"kodus-build/claim-1-api:claim"`, 1)
	if err := VerifyCanonical([]byte(built), o); err != nil {
		t.Fatalf("the cell's own image refused: %v", err)
	}
}

// What the driver pulls is every image compose will run that the cell did
// not build, once each.
func TestPullImagesAreTheImagesTheCellDidNotBuild(t *testing.T) {
	cfg := `{"services":{"api":{"image":"kodus-build/claim-1-api:claim"},"db":{"image":"postgres:16"},"db2":{"image":"postgres:16"},"web":{"image":"nginx"}}}`
	got, err := PullImages([]byte(cfg), Options{Built: map[string]string{"api": "kodus-build/claim-1-api:claim"}})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"postgres:16", "nginx"}) {
		t.Fatalf("pulls %v", got)
	}
}

func yamlQuote(s string) string {
	b, _ := yaml.Marshal(s)
	return strings.TrimSuffix(string(b), "\n")
}

const sharedImageCompose = `
x-build: &build
  context: .
services:
  app:
    build: *build
    image: shop-e2e
  cypress:
    image: shop-e2e
    pull_policy: never
    depends_on:
      app:
        condition: service_healthy
  other:
    image: redis:7
`

// An image-only service whose image is the image: of a service this project
// builds is never pulled: the build satisfies it, compose starts it after the
// build, and the cell gives it the image it built. An unrelated image-only
// service is still pulled. pull_policy: never on it is honored (compose never
// pulls anything: Apply sets it on every service).
func TestAnImageAnotherServiceBuildsIsNeverPulled(t *testing.T) {
	const tag = "kodus-build/claim-1-app:claim"
	for _, tc := range []struct {
		name    string
		compose string
		pulls   []string
		cypress string
	}{
		{"the shared ref is not pulled, an unrelated one is", sharedImageCompose, []string{"redis:7"}, tag},
		{"an implicit :latest names the same image",
			strings.Replace(sharedImageCompose, "    image: shop-e2e\n    pull_policy", "    image: shop-e2e:latest\n    pull_policy", 1), []string{"redis:7"}, tag},
		{"a different tag is another image and is pulled",
			strings.Replace(sharedImageCompose, "    image: shop-e2e\n    pull_policy", "    image: shop-e2e:v2\n    pull_policy", 1), []string{"shop-e2e:v2", "redis:7"}, "shop-e2e:v2"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := checkout(t)
			o := opts(dir)
			o.Built = map[string]string{"app": tag}
			out, err := Apply([]byte(tc.compose), o)
			if err != nil {
				t.Fatal(err)
			}
			var doc struct {
				Services map[string]map[string]any `yaml:"services"`
			}
			if err := yaml.Unmarshal(out, &doc); err != nil {
				t.Fatal(err)
			}
			if got := doc.Services["cypress"]["image"]; got != tc.cypress {
				t.Errorf("cypress image %v, want %s", got, tc.cypress)
			}
			for name, s := range doc.Services {
				if s["pull_policy"] != "never" {
					t.Errorf("%s: pull_policy %v", name, s["pull_policy"])
				}
			}
			canonical, err := json.Marshal(map[string]any{"services": doc.Services})
			if err != nil {
				t.Fatal(err)
			}
			got, err := PullImages(canonical, o)
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(got, tc.pulls) {
				t.Errorf("pulls %v, want %v", got, tc.pulls)
			}
		})
	}
}

// The admission check on the canonical config treats the shared ref as the
// cell's built image: it passes with the built tag, and an image that is not
// the cell's build is still judged as an external one.
func TestVerifyCanonicalReadsASharedImageAsBuilt(t *testing.T) {
	dir := checkout(t)
	o := opts(dir)
	o.Built = map[string]string{"api": "kodus-build/claim-1-api:claim"}
	ok := canonical(``)
	for name, tc := range map[string]struct {
		cfg  string
		fail bool
	}{
		"the built tag on a second service": {strings.Replace(ok, `"image":"x"`, `"image":"kodus-build/claim-1-api:claim"`, 1), false},
		"a local image that is not built":   {strings.Replace(ok, `"image":"x"`, `"image":"kodus-build/other:claim"`, 1), true},
	} {
		err := VerifyCanonical([]byte(tc.cfg), o)
		var re *RefusedError
		if got := errors.As(err, &re); got != tc.fail {
			t.Errorf("%s: refused=%v err=%v", name, got, err)
		}
	}
}

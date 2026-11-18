package dockercli

import (
	"archive/tar"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const builtTag = "kodus-build/m1-api:claim"

type tarEntry struct {
	name, body string
	typ        byte
	link       string
}

func writeTarball(t *testing.T, entries ...tarEntry) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), BuildTarball)
	f, err := os.Create(p)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(f)
	for _, e := range entries {
		typ := e.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		h := &tar.Header{Name: e.name, Typeflag: typ, Mode: 0o644, Size: int64(len(e.body)), Linkname: e.link}
		if typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	return p
}

// What BuildKit's docker exporter writes for one image.
func goodImage(repoTag, containerdName, refName string) []tarEntry {
	return []tarEntry{
		{name: "blobs/", typ: tar.TypeDir},
		{name: "blobs/sha256/", typ: tar.TypeDir},
		{name: "blobs/sha256/aaaa", body: "layer"},
		{name: "blobs/sha256/bbbb", body: "{}"},
		{name: "oci-layout", body: `{"imageLayoutVersion":"1.0.0"}`},
		{name: "index.json", body: `{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:cccc","size":1,` +
			`"annotations":{"io.containerd.image.name":"` + containerdName + `","org.opencontainers.image.ref.name":"` + refName + `"}}]}`},
		{name: "manifest.json", body: `[{"Config":"blobs/sha256/bbbb","RepoTags":["` + repoTag + `"],"Layers":["blobs/sha256/aaaa"]}]`},
	}
}

func TestCheckImageTarballTakesTheImageItAskedFor(t *testing.T) {
	p := writeTarball(t, goodImage(builtTag, "docker.io/"+builtTag, "claim")...)
	if err := CheckImageTarball(ImageLoad{Tarball: p, Tag: builtTag}); err != nil {
		t.Fatal(err)
	}
}

// A builder's tarball went to docker load unread: a RUN step that wrote one
// naming postgres:16 (or another claim's image) replaced that image on the
// host. Every way of naming another image is refused before the load.
func TestCheckImageTarballRefusesATarballNamingAnotherImage(t *testing.T) {
	two := goodImage(builtTag, "docker.io/"+builtTag, "claim")
	two[len(two)-1].body = `[{"RepoTags":["` + builtTag + `"]},{"RepoTags":["postgres:16"]}]`
	twoIndex := goodImage(builtTag, "docker.io/"+builtTag, "claim")
	twoIndex[5].body = `{"manifests":[{"annotations":{"io.containerd.image.name":"docker.io/` + builtTag + `"}},{"annotations":{"io.containerd.image.name":"docker.io/library/postgres:16"}}]}`
	cases := map[string][]tarEntry{
		"another repo tag":        goodImage("postgres:16", "docker.io/"+builtTag, "claim"),
		"a second repo tag":       append(goodImage(builtTag, "docker.io/"+builtTag, "claim")[:6], tarEntry{name: "manifest.json", body: `[{"RepoTags":["` + builtTag + `","postgres:16"]}]`}),
		"two images":              two,
		"another containerd name": goodImage(builtTag, "docker.io/library/postgres:16", "claim"),
		"a full ref name":         goodImage(builtTag, "docker.io/"+builtTag, "docker.io/library/postgres:16"),
		"two index manifests":     twoIndex,
		"another claim's image":   goodImage("kodus-build/m2-api:claim", "docker.io/kodus-build/m2-api:claim", "claim"),
		"a repositories file":     append(goodImage(builtTag, "docker.io/"+builtTag, "claim"), tarEntry{name: "repositories", body: `{"postgres":{"16":"abc"}}`}),
		"no manifest":             goodImage(builtTag, "docker.io/"+builtTag, "claim")[:6],
		"two manifests":           append(goodImage(builtTag, "docker.io/"+builtTag, "claim"), tarEntry{name: "./manifest.json", body: `[{"RepoTags":["postgres:16"]}]`}),
		"a symlink":               append(goodImage(builtTag, "docker.io/"+builtTag, "claim"), tarEntry{name: "blobs/sha256/dddd", typ: tar.TypeSymlink, link: "/etc/shadow"}),
		"a hard link":             append(goodImage(builtTag, "docker.io/"+builtTag, "claim"), tarEntry{name: "blobs/sha256/dddd", typ: tar.TypeLink, link: "blobs/sha256/aaaa"}),
		"outside the archive":     append(goodImage(builtTag, "docker.io/"+builtTag, "claim"), tarEntry{name: "../evil", body: "x"}),
		"not json":                append(goodImage(builtTag, "docker.io/"+builtTag, "claim")[:6], tarEntry{name: "manifest.json", body: "nope"}),
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			p := writeTarball(t, entries...)
			if err := CheckImageTarball(ImageLoad{Tarball: p, Tag: builtTag}); !errors.Is(err, driver.ErrImageLoad) {
				t.Fatalf("taken: %v", err)
			}
		})
	}
}

func TestCheckImageTarballBoundsSizeAndEntries(t *testing.T) {
	entries := goodImage(builtTag, "docker.io/"+builtTag, "claim")
	p := writeTarball(t, append(entries, tarEntry{name: "blobs/sha256/big", body: strings.Repeat("x", 64<<10)})...)
	if err := CheckImageTarball(ImageLoad{Tarball: p, Tag: builtTag, MaxBytes: 32 << 10}); !errors.Is(err, driver.ErrImageTooLarge) {
		t.Fatalf("an image past the bound: %v", err)
	}
	if err := CheckImageTarball(ImageLoad{Tarball: p, Tag: builtTag, MaxEntries: 4}); !errors.Is(err, driver.ErrImageLoad) || !strings.Contains(err.Error(), "entries") {
		t.Fatalf("too many entries: %v", err)
	}
	link := filepath.Join(t.TempDir(), "link.tar")
	if err := os.Symlink(p, link); err != nil {
		t.Fatal(err)
	}
	if err := CheckImageTarball(ImageLoad{Tarball: link, Tag: builtTag}); !errors.Is(err, driver.ErrImageLoad) {
		t.Fatalf("a symlinked tarball: %v", err)
	}
}

func TestParseRefSpellsANameAsDockerDoes(t *testing.T) {
	same := [][2]string{
		{"kodus-build/m-a:claim", "docker.io/kodus-build/m-a:claim"},
		{"postgres", "docker.io/library/postgres:latest"},
		{"index.docker.io/library/postgres:16", "postgres:16"},
		{"docker.io/postgres:16", "postgres:16"},
	}
	for _, p := range same {
		a, err1 := parseRef(p[0])
		b, err2 := parseRef(p[1])
		if err1 != nil || err2 != nil || a != b {
			t.Errorf("%s and %s: %v %v %v %v", p[0], p[1], a, b, err1, err2)
		}
	}
	other := [][2]string{{"kodus-build/m-a:claim", "kodus-build/m-b:claim"}, {"registry.example:5000/a:1", "a:1"}, {"localhost/a:1", "a:1"}}
	for _, p := range other {
		a, _ := parseRef(p[0])
		b, _ := parseRef(p[1])
		if a == b {
			t.Errorf("%s and %s are one name", p[0], p[1])
		}
	}
	for _, bad := range []string{"", "a@sha256:abc", "a:", ":b", "a b:c"} {
		if _, err := parseRef(bad); err == nil {
			t.Errorf("%q taken", bad)
		}
	}
}

// docker load runs only for a tarball the check took; its failure is a load failure.
func TestLoadImageChecksBeforeItLoads(t *testing.T) {
	var ran [][]string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		ran = append(ran, args)
		return nil, nil
	}}
	bad := writeTarball(t, goodImage("postgres:16", "docker.io/library/postgres:16", "16")...)
	if err := c.LoadImage(context.Background(), ImageLoad{Tarball: bad, Tag: builtTag}); !errors.Is(err, driver.ErrImageLoad) || len(ran) != 0 {
		t.Fatalf("refused tarball: %v, ran %v", err, ran)
	}
	good := writeTarball(t, goodImage(builtTag, "docker.io/"+builtTag, "claim")...)
	if err := c.LoadImage(context.Background(), ImageLoad{Tarball: good, Tag: builtTag}); err != nil || len(ran) != 1 || strings.Join(ran[0], " ") != "load -q -i "+good {
		t.Fatalf("good tarball: %v, ran %v", err, ran)
	}
	c.Run = func(context.Context, []byte, string, ...string) ([]byte, error) {
		return nil, &ExitError{Command: "docker load", Code: 1}
	}
	if err := c.LoadImage(context.Background(), ImageLoad{Tarball: good, Tag: builtTag}); !errors.Is(err, driver.ErrImageLoad) {
		t.Fatalf("a failed load: %v", err)
	}
}

package toollayer_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/toollayer"
)

var imageA = "sha256:" + strings.Repeat("a", 64)
var imageB = "sha256:" + strings.Repeat("b", 64)

func baseKey() toollayer.KeyInput {
	return toollayer.KeyInput{
		Installer:   "npm",
		Argv:        []string{"npm", "install", "--ignore-scripts", "-g", "foo@1.2.3"},
		Binary:      "foo",
		ImageDigest: imageA,
		Arch:        "arm64",
		Registry:    "registry.npmjs.org",
	}
}

func mustKey(t *testing.T, in toollayer.KeyInput) string {
	t.Helper()
	k, err := toollayer.ComputeKey(in)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestKeyIsStableAndChangesWithEachInput(t *testing.T) {
	base := mustKey(t, baseKey())
	if len(base) != 64 {
		t.Fatalf("key = %q, want 64 hex", base)
	}
	if again := mustKey(t, baseKey()); again != base {
		t.Fatal("same input, different key")
	}
	changes := map[string]func(*toollayer.KeyInput){
		"a package pin": func(k *toollayer.KeyInput) {
			k.Argv = []string{"npm", "install", "--ignore-scripts", "-g", "foo@1.2.4"}
		},
		"--ignore-scripts": func(k *toollayer.KeyInput) { k.Argv = []string{"npm", "install", "-g", "foo@1.2.3"} },
		"the installer":    func(k *toollayer.KeyInput) { k.Installer = "pnpm" },
		"the binary":       func(k *toollayer.KeyInput) { k.Binary = "bar" },
		"the image":        func(k *toollayer.KeyInput) { k.ImageDigest = imageB },
		"the arch":         func(k *toollayer.KeyInput) { k.Arch = "amd64" },
		"the registry":     func(k *toollayer.KeyInput) { k.Registry = "registry.example.com" },
	}
	for name, mutate := range changes {
		in := baseKey()
		mutate(&in)
		if got := mustKey(t, in); got == base {
			t.Errorf("key did not change with %s", name)
		}
	}
}

func TestKeyArgvBoundariesAreNotAmbiguous(t *testing.T) {
	a, b := baseKey(), baseKey()
	a.Argv = []string{"npm", "install", "a b", "c"}
	b.Argv = []string{"npm", "install", "a", "b c"}
	if mustKey(t, a) == mustKey(t, b) {
		t.Fatal("different argv, same key")
	}
}

func TestKeyRefusesWithoutAnImageDigest(t *testing.T) {
	for _, d := range []string{"", "latest", "sha256:abc", "sha256:" + strings.Repeat("A", 64), strings.Repeat("a", 64), imageA + "x"} {
		in := baseKey()
		in.ImageDigest = d
		if _, err := toollayer.ComputeKey(in); !errors.Is(err, toollayer.ErrNoImageDigest) {
			t.Errorf("digest %q: err = %v, want ErrNoImageDigest", d, err)
		}
	}
}

func TestKeyRefusesIncompleteInput(t *testing.T) {
	for name, mutate := range map[string]func(*toollayer.KeyInput){
		"no installer": func(k *toollayer.KeyInput) { k.Installer = "" },
		"no argv":      func(k *toollayer.KeyInput) { k.Argv = nil },
		"no binary":    func(k *toollayer.KeyInput) { k.Binary = "" },
		"no arch":      func(k *toollayer.KeyInput) { k.Arch = "" },
		"no registry":  func(k *toollayer.KeyInput) { k.Registry = "" },
	} {
		in := baseKey()
		mutate(&in)
		if _, err := toollayer.ComputeKey(in); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

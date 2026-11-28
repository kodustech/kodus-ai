package rootfs

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
)

type file struct {
	name     string
	typ      byte
	mode     int64
	uid, gid int
	body     string
	link     string
}

func layerOf(t *testing.T, files ...file) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, f := range files {
		typ := f.typ
		if typ == 0 {
			typ = tar.TypeReg
		}
		mode := f.mode
		if mode == 0 {
			mode = 0o644
		}
		h := &tar.Header{Name: f.name, Typeflag: typ, Mode: mode, Uid: f.uid, Gid: f.gid, Linkname: f.link, Size: int64(len(f.body))}
		if typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if typ == tar.TypeReg {
			_, _ = tw.Write([]byte(f.body))
		}
	}
	_ = tw.Close()
	return buf.Bytes()
}

func mem(b []byte) Layer {
	return func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(b)), nil }
}

func flatten(t *testing.T, p guestinit.Profile, layers ...[]byte) (map[string]*tar.Header, map[string][]byte) {
	t.Helper()
	var ls []Layer
	for _, l := range layers {
		ls = append(ls, mem(l))
	}
	var out bytes.Buffer
	if err := Flatten(ls, &out, Options{Profile: p, Guest: []byte("guest-binary")}); err != nil {
		t.Fatal(err)
	}
	h, d, err := List(&out)
	if err != nil {
		t.Fatal(err)
	}
	return h, d
}

// An upper layer's whiteout hides a lower file, an opaque directory hides
// everything the lower layers had in it (not what its own layer adds), and
// a file written over a directory hides the directory's content.
func TestLayersApplyAsTheOCISpecSays(t *testing.T) {
	base := layerOf(t,
		file{name: "etc/", typ: tar.TypeDir, mode: 0o755},
		file{name: "etc/keep", body: "base"},
		file{name: "etc/gone", body: "base"},
		file{name: "opt/app/", typ: tar.TypeDir, mode: 0o755},
		file{name: "opt/app/old.js", body: "old"},
		file{name: "srv/data/", typ: tar.TypeDir, mode: 0o755},
		file{name: "srv/data/inside", body: "x"},
	)
	upper := layerOf(t,
		file{name: "etc/.wh.gone"},
		file{name: "etc/keep", body: "upper"},
		file{name: "opt/app/new.js", body: "new"},
		file{name: "opt/app/.wh..wh..opq"},
		file{name: "srv/data", body: "now a file"},
	)
	h, d := flatten(t, guestinit.EnvironmentProfile, base, upper)
	for _, gone := range []string{"etc/gone", "opt/app/old.js", "srv/data/inside", "etc/.wh.gone", "opt/app/.wh..wh..opq"} {
		if _, ok := h[gone]; ok {
			t.Errorf("%s is still there", gone)
		}
	}
	for p, want := range map[string]string{"etc/keep": "upper", "opt/app/new.js": "new", "srv/data": "now a file"} {
		if got := string(d[p]); got != want {
			t.Errorf("%s = %q, want %q", p, got, want)
		}
	}
}

// Every rootfs has the guest agent as its init, its profile and the
// resolver link, over what the image had at those paths, and the mount
// points init needs on a read-only root.
func TestEveryRootfsCarriesTheGuestAgentItsProfileAndTheResolverLink(t *testing.T) {
	img := layerOf(t,
		file{name: "etc/resolv.conf", body: "nameserver 8.8.8.8"},
		file{name: "usr/local/bin/kody-guest", body: "an old agent", mode: 0o4755},
	)
	for _, p := range []guestinit.Profile{guestinit.SandboxProfile, guestinit.EnvironmentProfile} {
		h, d := flatten(t, p, img)
		if string(d[GuestPath]) != "guest-binary" || h[GuestPath].Mode != 0o755 || h[GuestPath].Uid != 0 {
			t.Fatalf("%s: guest agent %+v", p.Name, h[GuestPath])
		}
		got, err := guestinit.ParseProfile(d["etc/kody-guest/profile.json"])
		if err != nil || got != p {
			t.Fatalf("%s: profile %+v %v", p.Name, got, err)
		}
		if r := h["etc/resolv.conf"]; r.Typeflag != tar.TypeSymlink || r.Linkname != guestinit.ResolvPath {
			t.Fatalf("%s: resolv.conf %+v", p.Name, r)
		}
		for _, dir := range []string{"proc", "sys", "dev", "run", "tmp", "workspace", "usr", "usr/local", "usr/local/bin"} {
			if e, ok := h[dir]; !ok || e.Typeflag != tar.TypeDir {
				t.Errorf("%s: no directory %s", p.Name, dir)
			}
		}
		if _, ok := h[strings.TrimPrefix(guestinit.DataMount, "/")]; ok != (p.DataDevice != "") {
			t.Errorf("%s: data mount point present %v", p.Name, ok)
		}
	}
}

// A sandbox rootfs has no set-id file and no device node, so nothing in it
// makes its user root; an environment keeps its image's modes. Owners are
// kept as the image had them.
func TestASandboxRootfsHasNoSetIDFileOrDeviceNode(t *testing.T) {
	img := layerOf(t,
		file{name: "usr/bin/sudo", body: "x", mode: 0o4755},
		file{name: "usr/bin/wall", body: "x", mode: 0o2755, gid: 5},
		file{name: "dev-copy/mem", typ: tar.TypeChar, mode: 0o666},
		file{name: "home/node/.npmrc", body: "x", uid: 1000, gid: 1000, mode: 0o600},
	)
	h, _ := flatten(t, guestinit.SandboxProfile, img)
	for p, e := range h {
		if e.Mode&0o6000 != 0 || e.Typeflag == tar.TypeChar || e.Typeflag == tar.TypeBlock {
			t.Errorf("sandbox keeps %s mode %o type %c", p, e.Mode, e.Typeflag)
		}
	}
	if n := h["home/node/.npmrc"]; n.Uid != 1000 || n.Gid != 1000 || n.Mode != 0o600 {
		t.Fatalf("owner lost: %+v", n)
	}
	h, _ = flatten(t, guestinit.EnvironmentProfile, img)
	if h["usr/bin/sudo"].Mode != 0o4755 || h["usr/bin/wall"].Gid != 5 {
		t.Fatalf("environment modes: %o", h["usr/bin/sudo"].Mode)
	}
}

// A layer path that climbs out of the root, a hard link to nothing, or a
// path below a file is refused rather than written.
func TestALayerThatWouldEscapeOrBreakTheTreeIsRefused(t *testing.T) {
	for name, l := range map[string][]byte{
		"climbs":     layerOf(t, file{name: "../../etc/passwd", body: "x"}),
		"dangling":   layerOf(t, file{name: "bin/a", typ: tar.TypeLink, link: "bin/missing"}),
		"below file": layerOf(t, file{name: "a", body: "x"}, file{name: "a/b", body: "y"}),
	} {
		var out bytes.Buffer
		if err := Flatten([]Layer{mem(l)}, &out, Options{Profile: guestinit.SandboxProfile, Guest: []byte("g")}); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// A hard link is written after the file it names, so the file system
// builder finds it.
func TestAHardLinkIsWrittenAfterItsTarget(t *testing.T) {
	img := layerOf(t, file{name: "bin/b", typ: tar.TypeLink, link: "bin/a"}, file{name: "bin/a", body: "x"})
	var out bytes.Buffer
	if err := Flatten([]Layer{mem(img)}, &out, Options{Profile: guestinit.EnvironmentProfile, Guest: []byte("g")}); err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(&out)
	seenA := false
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		switch strings.TrimPrefix(h.Name, "./") {
		case "bin/a":
			seenA = true
		case "bin/b":
			if !seenA || h.Linkname != "./bin/a" {
				t.Fatalf("link %+v before its target (%v)", h, seenA)
			}
		}
	}
}

// writeLayout writes an OCI layout of a two-platform index whose amd64
// image is base+upper (gzip) and whose arm64 image is something else.
func writeLayout(t *testing.T, dir string, base, upper []byte) {
	t.Helper()
	blob := func(b []byte) string {
		s := sha256.Sum256(b)
		d := hex.EncodeToString(s[:])
		if err := os.MkdirAll(filepath.Join(dir, "blobs", "sha256"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "blobs", "sha256", d), b, 0o644); err != nil {
			t.Fatal(err)
		}
		return "sha256:" + d
	}
	gz := func(b []byte) []byte {
		var buf bytes.Buffer
		z := gzip.NewWriter(&buf)
		_, _ = z.Write(b)
		_ = z.Close()
		return buf.Bytes()
	}
	jsonBlob := func(v any) (string, int) {
		b, _ := json.Marshal(v)
		return blob(b), len(b)
	}
	bg, ug := gz(base), gz(upper)
	man, manN := jsonBlob(map[string]any{"schemaVersion": 2, "mediaType": mtOCIManifest, "layers": []map[string]any{
		{"mediaType": mtLayerGzip, "digest": blob(bg), "size": len(bg)},
		{"mediaType": mtLayerTar, "digest": blob(upper), "size": len(upper)},
	}})
	_ = ug
	other := layerOf(t, file{name: "arm", body: "arm"})
	armMan, armN := jsonBlob(map[string]any{"schemaVersion": 2, "mediaType": mtOCIManifest, "layers": []map[string]any{
		{"mediaType": mtLayerTar, "digest": blob(other), "size": len(other)},
	}})
	idx, idxN := jsonBlob(map[string]any{"schemaVersion": 2, "mediaType": mtOCIIndex, "manifests": []map[string]any{
		{"mediaType": mtOCIManifest, "digest": man, "size": manN, "platform": map[string]string{"os": "linux", "architecture": "amd64"}},
		{"mediaType": mtOCIManifest, "digest": armMan, "size": armN, "platform": map[string]string{"os": "linux", "architecture": "arm64"}},
	}})
	top, _ := json.Marshal(map[string]any{"schemaVersion": 2, "manifests": []map[string]any{{"mediaType": mtOCIIndex, "digest": idx, "size": idxN}}})
	if err := os.WriteFile(filepath.Join(dir, "index.json"), top, 0o644); err != nil {
		t.Fatal(err)
	}
}

// An OCI layout of several platforms gives the layers of the asked
// platform, base first, from a directory or a tar of one.
func TestAnOCILayoutGivesTheLayersOfTheAskedPlatform(t *testing.T) {
	dir := t.TempDir()
	writeLayout(t, dir, layerOf(t, file{name: "etc/os", body: "base"}), layerOf(t, file{name: "etc/os", body: "upper"}, file{name: "app", body: "a"}))
	tarPath := filepath.Join(t.TempDir(), "image.tar")
	tarDir(t, dir, tarPath)
	for _, src := range []string{dir, tarPath} {
		l, err := OpenLayout(src, t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		layers, err := l.Layers("linux/amd64")
		if err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := Flatten(layers, &out, Options{Profile: guestinit.SandboxProfile, Guest: []byte("g")}); err != nil {
			t.Fatal(err)
		}
		_, d, _ := List(&out)
		if string(d["etc/os"]) != "upper" || string(d["app"]) != "a" || d["arm"] != nil {
			t.Fatalf("%s: %q %q %q", src, d["etc/os"], d["app"], d["arm"])
		}
	}
}

// A layer whose bytes are not its digest fails the build, and a zstd layer
// is refused by name.
func TestALayerThatDoesNotMatchItsDigestFailsTheBuild(t *testing.T) {
	dir := t.TempDir()
	writeLayout(t, dir, layerOf(t, file{name: "etc/os", body: "base"}), layerOf(t, file{name: "x", body: "upper"}))
	// Swap the bytes of the uncompressed upper layer for another layer.
	entries, _ := os.ReadDir(filepath.Join(dir, "blobs", "sha256"))
	swapped := false
	for _, e := range entries {
		p := filepath.Join(dir, "blobs", "sha256", e.Name())
		b, _ := os.ReadFile(p)
		if bytes.Contains(b, []byte("upper")) && !bytes.HasPrefix(b, []byte("{")) {
			_ = os.WriteFile(p, layerOf(t, file{name: "x", body: "tampered"}), 0o644)
			swapped = true
		}
	}
	if !swapped {
		t.Fatal("no layer to tamper with")
	}
	l, _ := OpenLayout(dir, "")
	layers, err := l.Layers("linux/amd64")
	if err != nil {
		t.Fatal(err)
	}
	if err := Flatten(layers, io.Discard, Options{Profile: guestinit.SandboxProfile, Guest: []byte("g")}); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("a tampered layer: %v", err)
	}
}

func tarDir(t *testing.T, dir, out string) {
	t.Helper()
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(f)
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	_ = filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err != nil || fi.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		b, _ := root.ReadFile(rel)
		_ = tw.WriteHeader(&tar.Header{Name: filepath.ToSlash(rel), Mode: 0o644, Size: int64(len(b)), Typeflag: tar.TypeReg})
		_, _ = tw.Write(b)
		return nil
	})
	_ = tw.Close()
	_ = f.Close()
}

// Only an mke2fs that builds from a tar is accepted, and the refusal names
// the version that does.
func TestOnlyAnMke2fsThatReadsATarIsAccepted(t *testing.T) {
	for out, ok := range map[string]bool{
		"mke2fs 1.47.2 (1-Jan-2025)\n\tUsing EXT2FS Library version 1.47.2": true,
		"mke2fs 1.47.1 (20-May-2024)":                                       true,
		"mke2fs 1.48 (1-Jan-2026)":                                          true,
		"mke2fs 1.47.0 (5-Feb-2023)":                                        false,
		"mke2fs 1.46.5 (30-Dec-2021)":                                       false,
		"something else entirely here":                                      false,
	} {
		err := checkVersion(out)
		if (err == nil) != ok {
			t.Errorf("%q: %v", out, err)
		}
		if err != nil && strings.Contains(out, "mke2fs") && !strings.Contains(err.Error(), "1.47.1") {
			t.Errorf("%q: the refusal does not name the version that works: %v", out, err)
		}
	}
}

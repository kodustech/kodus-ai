package releasesig

import (
	"archive/tar"
	"bytes"
	"crypto/ed25519"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	builderRef = "ghcr.io/kodustech/kodus-runtime-builder@sha256:f4c8f1e1e94d6ab48d181cd4e07e50b667c0e7aef510bae930546454510a63b1"
	holderRef  = "docker.io/library/alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc"
)

// ociArchive is a small OCI archive whose index.json lists digest.
func ociArchive(t *testing.T, digest string) string {
	t.Helper()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	for name, body := range map[string]string{
		"oci-layout": `{"imageLayoutVersion":"1.0.0"}`,
		"index.json": `{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"` + digest + `","size":1}]}`,
	} {
		if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(body))}); err != nil {
			t.Fatal(err)
		}
		_, _ = tw.Write([]byte(body))
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "image.oci.tar")
	if err := os.WriteFile(p, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func digestOf(ref string) string { return ref[strings.Index(ref, "@")+1:] }

// releaseForBundle is a signed release with PROTOCOL and a current index.
func releaseForBundle(t *testing.T, priv ed25519.PrivateKey) string {
	t.Helper()
	dir := signedRelease(t, priv, "v1.4.0", map[string]string{
		"cell-linux-amd64": "cell amd64", "egress-linux-amd64": "egress amd64", ProtocolName: "1 2\n",
	})
	if err := signIndexFile(priv, dir, index(nil)); err != nil {
		t.Fatal(err)
	}
	return dir
}

func buildBundle(t *testing.T, priv ed25519.PrivateKey) string {
	t.Helper()
	runsc := filepath.Join(t.TempDir(), "gvisor.tar.bz2")
	if err := os.WriteFile(runsc, []byte("runsc archive"), 0o644); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "bundle")
	images := []ImageInput{
		{Component: "builder", Ref: builderRef, Archive: ociArchive(t, digestOf(builderRef))},
		{Component: "holder", Ref: holderRef, Archive: ociArchive(t, digestOf(holderRef))},
	}
	if err := BuildBundle(priv, "v1.4.0", releaseForBundle(t, priv), images, map[string]string{"x86_64": runsc}, out, t0.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	return out
}

// A bundle built from a signed release verifies offline with the pinned
// key, and names every artifact: the release's files, each image by its
// pinned reference, the runsc archive of each arch.
func TestABundleOfASignedReleaseVerifiesOfflineWithThePinnedKey(t *testing.T) {
	priv, keys := testKey(t)
	dir := buildBundle(t, priv)
	b, ix, err := VerifyBundle(dir, keys, t0.Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if b.Release != "v1.4.0" || ix.Latest != "v1.4.0" {
		t.Fatalf("bundle %s, index %+v", b.Release, ix)
	}
	got := map[string]string{}
	for _, a := range b.Artifacts {
		got[a.Path] = a.Kind + " " + a.Ref
	}
	for path, want := range map[string]string{
		"release/cell-linux-amd64":     "release -",
		"release/SHA256SUMS.sig":       "release -",
		"release/RELEASE-INDEX.sig":    "release -",
		"release/PROTOCOL":             "release -",
		"images/builder.oci.tar":       "image " + builderRef,
		"images/holder.oci.tar":        "image " + holderRef,
		"gvisor/x86_64/gvisor.tar.bz2": "runsc -",
	} {
		if got[path] != want {
			t.Errorf("%s: %q, want %q", path, got[path], want)
		}
	}
}

// Every listed file is hashed before anything loads: one changed byte, a
// missing artifact or an edited manifest refuses the whole bundle.
func TestATamperedMissingOrUnlistedArtifactRefusesTheBundle(t *testing.T) {
	priv, keys := testKey(t)
	now := t0.Add(2 * time.Hour)

	dir := buildBundle(t, priv)
	p := filepath.Join(dir, "images", "holder.oci.tar")
	b, _ := os.ReadFile(p)
	b[len(b)-1] ^= 1
	_ = os.WriteFile(p, b, 0o644)
	if _, _, err := VerifyBundle(dir, keys, now); err == nil || !strings.Contains(err.Error(), "holder.oci.tar: sha256") {
		t.Errorf("tampered image: %v", err)
	}

	dir = buildBundle(t, priv)
	_ = os.Remove(filepath.Join(dir, "gvisor", "x86_64", "gvisor.tar.bz2"))
	if _, _, err := VerifyBundle(dir, keys, now); err == nil || !strings.Contains(err.Error(), "gvisor.tar.bz2") {
		t.Errorf("missing runsc: %v", err)
	}

	dir = buildBundle(t, priv)
	m := filepath.Join(dir, BundleManifestName)
	text, _ := os.ReadFile(m)
	_ = os.WriteFile(m, []byte(strings.Replace(string(text), holderRef, strings.Replace(holderRef, "alpine", "evil", 1), 1)), 0o644)
	if _, _, err := VerifyBundle(dir, keys, now); err == nil || !strings.Contains(err.Error(), "does not verify") {
		t.Errorf("edited manifest: %v", err)
	}

	dir = buildBundle(t, priv)
	_ = os.Remove(filepath.Join(dir, BundleSignatureName))
	if _, _, err := VerifyBundle(dir, keys, now); err == nil || !strings.Contains(err.Error(), BundleSignatureName) {
		t.Errorf("unsigned bundle: %v", err)
	}
}

// A bundle signed with a key the host does not pin, or verified with no
// key at all, is refused.
func TestABundleSignedWithAnotherKeyIsRefused(t *testing.T) {
	priv, _ := testKey(t)
	_, other := testKey(t)
	dir := buildBundle(t, priv)
	if _, _, err := VerifyBundle(dir, other, t0.Add(2*time.Hour)); err == nil || !strings.Contains(err.Error(), "not pinned") {
		t.Errorf("other key: %v", err)
	}
	if _, _, err := VerifyBundle(dir, nil, t0.Add(2*time.Hour)); err == nil || !strings.Contains(err.Error(), "no release key") {
		t.Errorf("no key: %v", err)
	}
}

// The release index inside freezes a bundle: once it expires the bundle is
// refused, as `cell update` refuses the release.
func TestABundleWhoseReleaseIndexExpiredIsRefused(t *testing.T) {
	priv, keys := testKey(t)
	dir := buildBundle(t, priv)
	if _, _, err := VerifyBundle(dir, keys, t0.Add(91*24*time.Hour)); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("expired index: %v", err)
	}
}

// A release's SHA256SUMS signature never passes for a bundle's, nor a
// bundle's for a release's: the messages have their own prefixes.
func TestABundleSignatureIsNeitherAReleaseNorAnIndexSignature(t *testing.T) {
	priv, _ := testKey(t)
	pub := priv.Public().(ed25519.PublicKey)
	text := []byte("x")
	if ed25519.Verify(pub, BundleMessage("v1.4.0", text), ed25519.Sign(priv, Message("v1.4.0", text))) {
		t.Error("a release signature verified as a bundle one")
	}
	if ed25519.Verify(pub, IndexMessage(text), ed25519.Sign(priv, BundleMessage("v1.4.0", text))) {
		t.Error("a bundle signature verified as an index one")
	}
}

// The release job cannot make a bundle of a release that does not verify,
// nor pack an image archive that is not the digest it is pinned to.
func TestBuildRefusesAnUnsignedReleaseOrAnImageThatIsNotItsDigest(t *testing.T) {
	priv, _ := testKey(t)
	other, _ := testKey(t)
	now := t0.Add(time.Hour)
	if err := BuildBundle(other, "v1.4.0", releaseForBundle(t, priv), nil, nil, filepath.Join(t.TempDir(), "b"), now); err == nil || !strings.Contains(err.Error(), "not pinned") {
		t.Errorf("release of another key: %v", err)
	}
	wrong := []ImageInput{{Component: "holder", Ref: holderRef, Archive: ociArchive(t, digestOf(builderRef))}}
	if err := BuildBundle(priv, "v1.4.0", releaseForBundle(t, priv), wrong, nil, filepath.Join(t.TempDir(), "b"), now); err == nil || !strings.Contains(err.Error(), "does not list") {
		t.Errorf("image of another digest: %v", err)
	}
	notOCI := filepath.Join(t.TempDir(), "x.tar")
	_ = os.WriteFile(notOCI, []byte("not a tar"), 0o644)
	bad := []ImageInput{{Component: "holder", Ref: holderRef, Archive: notOCI}}
	if err := BuildBundle(priv, "v1.4.0", releaseForBundle(t, priv), bad, nil, filepath.Join(t.TempDir(), "b"), now); err == nil || !strings.Contains(err.Error(), "not an OCI archive") {
		t.Errorf("not an OCI archive: %v", err)
	}
}

// BUNDLE's text is canonical, and a manifest naming a path outside the
// layout or an image not pinned by digest does not parse.
func TestTheBundleManifestIsCanonicalAndRefusesPathsOutsideItsLayout(t *testing.T) {
	base := "kodus-cell-bundle v1\nrelease v1.4.0\n"
	sha := strings.Repeat("a", 64)
	var req strings.Builder
	for _, r := range bundleRequired {
		req.WriteString(sha + "\trelease\t" + r + "\trelease/" + r + "\t-\n")
	}
	for name, line := range map[string]string{
		"escape":     sha + "\trelease\t..\trelease/../../etc/passwd\t-\n",
		"tag":        sha + "\timage\tholder\timages/holder.oci.tar\tdocker.io/library/alpine:3.20\n",
		"misplaced":  sha + "\timage\tholder\timages/builder.oci.tar\t" + holderRef + "\n",
		"wrong arch": sha + "\trunsc\tamd64\tgvisor/amd64/gvisor.tar.bz2\t-\n",
	} {
		if _, err := ParseBundle([]byte(base+req.String()+line), "BUNDLE"); err == nil {
			t.Errorf("%s: parsed", name)
		}
	}
	if _, err := ParseBundle([]byte(base+sha+"\timage\tholder\timages/holder.oci.tar\t"+holderRef+"\n"), "BUNDLE"); err == nil || !strings.Contains(err.Error(), "no release/") {
		t.Errorf("no release files: %v", err)
	}
	b, err := ParseBundle([]byte(base+req.String()), "BUNDLE")
	if err != nil {
		t.Fatal(err)
	}
	again, err := MarshalBundle(b)
	if err != nil {
		t.Fatal(err)
	}
	b2, _ := ParseBundle(again, "BUNDLE")
	if out, _ := MarshalBundle(b2); !bytes.Equal(out, again) {
		t.Error("marshal is not stable")
	}
}

// The release tool makes the bundle from an image list and the runsc
// archives, and refuses a malformed list.
func TestTheReleaseToolBundlesFromAnImageList(t *testing.T) {
	priv, keys := testKey(t)
	keyFile := filepath.Join(t.TempDir(), "key")
	_ = os.WriteFile(keyFile, []byte(FormatPrivateKey(priv)), 0o600)
	now := time.Now().UTC()
	rel := signedRelease(t, priv, "v1.4.0", map[string]string{"cell-linux-amd64": "c", ProtocolName: "1 2\n"})
	if err := signIndexFile(priv, rel, Index{Issued: now.Add(-time.Hour), Expires: now.Add(24 * time.Hour), Latest: "v1.4.0", Minimum: "v1.0.0"}); err != nil {
		t.Fatal(err)
	}
	list := filepath.Join(t.TempDir(), "images.tsv")
	_ = os.WriteFile(list, []byte("# component\treference\tarchive\nholder\t"+holderRef+"\t"+ociArchive(t, digestOf(holderRef))+"\n"), 0o644)
	runsc := filepath.Join(t.TempDir(), "gvisor.tar.bz2")
	_ = os.WriteFile(runsc, []byte("r"), 0o644)
	out := filepath.Join(t.TempDir(), "bundle")
	var stdout, stderr bytes.Buffer
	if code := RunTool([]string{"bundle", "-key", keyFile, "-release", "v1.4.0", "-release-dir", rel, "-images", list, "-runsc", "aarch64=" + runsc, "-out", out}, Protocol{}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if _, _, err := VerifyBundle(out, keys, now); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(list, []byte("holder "+holderRef+"\n"), 0o644)
	if code := RunTool([]string{"bundle", "-key", keyFile, "-release", "v1.4.0", "-release-dir", rel, "-images", list, "-out", filepath.Join(t.TempDir(), "b")}, Protocol{}, &stdout, &stderr); code != 1 {
		t.Errorf("malformed list: exit %d", code)
	}
}

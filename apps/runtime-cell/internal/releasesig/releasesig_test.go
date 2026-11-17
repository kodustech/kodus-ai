package releasesig

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testKey(t *testing.T) (ed25519.PrivateKey, []PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return priv, []PublicKey{{ID: KeyID(pub), Key: pub}}
}

// signedRelease writes files and their SHA256SUMS into a new directory and
// signs it for release with priv.
func signedRelease(t *testing.T, priv ed25519.PrivateKey, release string, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	var manifest strings.Builder
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(body))
		manifest.WriteString(hex.EncodeToString(sum[:]) + "  " + name + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, ManifestName), []byte(manifest.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	sig, err := Sign(priv, release, []byte(manifest.String()))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, SignatureName), sig, 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// refusedNaming fails unless err is a refusal naming file.
func refusedNaming(t *testing.T, err error, file string) {
	t.Helper()
	var re *Error
	if !errors.As(err, &re) || re.File != file {
		t.Fatalf("got %v, want a refusal naming %s", err, file)
	}
}

func TestASignedReleaseVerifies(t *testing.T) {
	priv, keys := testKey(t)
	dir := signedRelease(t, priv, "v1.2.0", map[string]string{"cell-linux-amd64": "cell", "egress-linux-amd64": "egress"})
	m, err := Verify(dir, "v1.2.0", keys)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 2 || CheckFile(filepath.Join(dir, "cell-linux-amd64"), m["cell-linux-amd64"]) != nil {
		t.Fatalf("manifest %v", m)
	}
}

// Every way a release can be wrong is refused, naming the file that is.
func TestAReleaseThatIsNotTheSignedOneIsRefusedNamingTheFile(t *testing.T) {
	priv, keys := testKey(t)
	otherPriv, _ := testKey(t)
	files := map[string]string{"cell-linux-amd64": "cell"}
	sigOf := func(dir string) string { return filepath.Join(dir, SignatureName) }

	t.Run("no signature", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		_ = os.Remove(sigOf(dir))
		_, err := Verify(dir, "v1", keys)
		refusedNaming(t, err, sigOf(dir))
	})
	t.Run("no manifest", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		_ = os.Remove(filepath.Join(dir, ManifestName))
		_, err := Verify(dir, "v1", keys)
		refusedNaming(t, err, filepath.Join(dir, ManifestName))
	})
	t.Run("manifest changed after signing", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		evil := sha256.Sum256([]byte("evil"))
		_ = os.WriteFile(filepath.Join(dir, ManifestName), []byte(hex.EncodeToString(evil[:])+"  cell-linux-amd64\n"), 0o644)
		_, err := Verify(dir, "v1", keys)
		refusedNaming(t, err, sigOf(dir))
	})
	t.Run("a key that is not pinned", func(t *testing.T) {
		dir := signedRelease(t, otherPriv, "v1", files)
		_, err := Verify(dir, "v1", keys)
		refusedNaming(t, err, sigOf(dir))
	})
	t.Run("an older release under a newer name", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		_, err := Verify(dir, "v2", keys)
		refusedNaming(t, err, sigOf(dir))
	})
	t.Run("the signature line rewritten", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		b, _ := os.ReadFile(sigOf(dir))
		_ = os.WriteFile(sigOf(dir), bytes.Replace(b, []byte("release v1"), []byte("release v2"), 1), 0o644)
		_, err := Verify(dir, "v2", keys)
		refusedNaming(t, err, sigOf(dir))
	})
	t.Run("garbage signature", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		_ = os.WriteFile(sigOf(dir), []byte("not a signature\n"), 0o644)
		_, err := Verify(dir, "v1", keys)
		refusedNaming(t, err, sigOf(dir))
	})
	t.Run("no key pinned", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		if _, err := Verify(dir, "v1", nil); err == nil {
			t.Fatal("verified with no key pinned")
		}
	})
	t.Run("a file whose bytes changed", func(t *testing.T) {
		dir := signedRelease(t, priv, "v1", files)
		m, err := Verify(dir, "v1", keys)
		if err != nil {
			t.Fatal(err)
		}
		bin := filepath.Join(dir, "cell-linux-amd64")
		_ = os.WriteFile(bin, []byte("cel1"), 0o644)
		refusedNaming(t, CheckFile(bin, m["cell-linux-amd64"]), bin)
		refusedNaming(t, CopyChecked(bin, filepath.Join(t.TempDir(), "cell"), m["cell-linux-amd64"], 0o755), bin)
	})
}

func TestTheToolGeneratesAKeyAndSignsWhatItChecked(t *testing.T) {
	dir := t.TempDir()
	priv, pub := filepath.Join(dir, "release.key"), filepath.Join(dir, "release.pub")
	var out, errOut bytes.Buffer
	if code := RunTool([]string{"generate", "-private", priv, "-public", pub}, Protocol{}, &out, &errOut); code != 0 {
		t.Fatalf("generate: %d %s", code, errOut.String())
	}
	if fi, err := os.Stat(priv); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("private key file %v %v", fi, err)
	}
	pubText, _ := os.ReadFile(pub)
	keys, err := ParsePublicKeys(pubText)
	if err != nil || len(keys) != 1 {
		t.Fatalf("public key file %q: %v", pubText, err)
	}
	rel := t.TempDir()
	_ = os.WriteFile(filepath.Join(rel, "cell-linux-arm64"), []byte("cell"), 0o644)
	sum := sha256.Sum256([]byte("cell"))
	_ = os.WriteFile(filepath.Join(rel, ManifestName), []byte(hex.EncodeToString(sum[:])+"  cell-linux-arm64\n"), 0o644)
	if code := RunTool([]string{"sign", "-key", priv, "-release", "v3.0.0", "-dir", rel}, Protocol{}, &out, &errOut); code != 0 {
		t.Fatalf("sign: %d %s", code, errOut.String())
	}
	if _, err := Verify(rel, "v3.0.0", keys); err != nil {
		t.Fatal(err)
	}
	// A manifest whose file does not match is not signed.
	bad := t.TempDir()
	_ = os.WriteFile(filepath.Join(bad, "cell-linux-arm64"), []byte("other"), 0o644)
	_ = os.WriteFile(filepath.Join(bad, ManifestName), []byte(hex.EncodeToString(sum[:])+"  cell-linux-arm64\n"), 0o644)
	if code := RunTool([]string{"sign", "-key", priv, "-release", "v3.0.0", "-dir", bad}, Protocol{}, &out, &errOut); code != 1 {
		t.Fatalf("signed a manifest that does not match its file: %d", code)
	}
	if _, err := os.Stat(filepath.Join(bad, SignatureName)); err == nil {
		t.Fatal("a signature was written")
	}
}

// The pinned key file compiled into the cell parses; until the release
// owner pins a key it holds none, and every release is refused.
func TestThePinnedKeyFileParses(t *testing.T) {
	keys, err := Pinned()
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range keys {
		if len(k.Key) != ed25519.PublicKeySize {
			t.Fatalf("pinned key %s", k.ID)
		}
	}
}

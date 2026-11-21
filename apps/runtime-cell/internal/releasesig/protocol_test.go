package releasesig

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The release says which protocol it speaks: the tool writes PROTOCOL into
// the release directory before SHA256SUMS is made over it, so the manifest
// lists it and the signature covers it like any command.
func TestTheToolWritesPROTOCOLAndTheSignatureCoversIt(t *testing.T) {
	dir := t.TempDir()
	priv, pub := filepath.Join(dir, "release.key"), filepath.Join(dir, "release.pub")
	var out, errOut bytes.Buffer
	if code := RunTool([]string{"generate", "-private", priv, "-public", pub}, Protocol{}, &out, &errOut); code != 0 {
		t.Fatalf("generate: %d %s", code, errOut.String())
	}
	pubText, _ := os.ReadFile(pub)
	keys, _ := ParsePublicKeys(pubText)

	rel := t.TempDir()
	_ = os.WriteFile(filepath.Join(rel, "cell-linux-arm64"), []byte("cell"), 0o755)
	if code := RunTool([]string{"protocol", "-dir", rel}, Protocol{Min: 1, Max: 2}, &out, &errOut); code != 0 {
		t.Fatalf("protocol: %d %s", code, errOut.String())
	}
	if b, _ := os.ReadFile(filepath.Join(rel, ProtocolName)); string(b) != "1 2\n" {
		t.Fatalf("PROTOCOL %q", b)
	}
	// What the release workflow does next: sha256sum * > SHA256SUMS.
	var manifest strings.Builder
	for _, name := range []string{ProtocolName, "cell-linux-arm64"} {
		b, _ := os.ReadFile(filepath.Join(rel, name))
		sum := sha256.Sum256(b)
		manifest.WriteString(hex.EncodeToString(sum[:]) + "  " + name + "\n")
	}
	_ = os.WriteFile(filepath.Join(rel, ManifestName), []byte(manifest.String()), 0o644)
	if code := RunTool([]string{"sign", "-key", priv, "-release", "v3.0.0", "-dir", rel}, Protocol{}, &out, &errOut); code != 0 {
		t.Fatalf("sign: %d %s", code, errOut.String())
	}
	listed, err := Verify(rel, "v3.0.0", keys)
	if err != nil {
		t.Fatal(err)
	}
	got, ok, err := ReadProtocol(rel, listed)
	if err != nil || !ok || got != (Protocol{Min: 1, Max: 2}) {
		t.Fatalf("ReadProtocol = %+v %v %v", got, ok, err)
	}

	// A second run never replaces a PROTOCOL already there.
	if code := RunTool([]string{"protocol", "-dir", rel}, Protocol{Min: 1, Max: 3}, &out, &errOut); code != 1 {
		t.Fatalf("replaced PROTOCOL: exit %d", code)
	}
	// A build that speaks no protocol writes none.
	if code := RunTool([]string{"protocol", "-dir", t.TempDir()}, Protocol{}, &out, &errOut); code != 1 {
		t.Fatalf("wrote an empty protocol: exit %d", code)
	}
}

// A release whose manifest does not list PROTOCOL (one from before it) says
// nothing; one that lists it must match it, and read as one.
func TestReadProtocolTrustsOnlyTheSignedFile(t *testing.T) {
	rel := t.TempDir()
	if _, ok, err := ReadProtocol(rel, map[string]string{"cell-linux-amd64": strings.Repeat("0", 64)}); ok || err != nil {
		t.Fatalf("unlisted: ok %v err %v", ok, err)
	}
	// Present but unlisted: still nothing, the file is not signed.
	_ = os.WriteFile(filepath.Join(rel, ProtocolName), []byte("1 1\n"), 0o644)
	if _, ok, err := ReadProtocol(rel, map[string]string{}); ok || err != nil {
		t.Fatalf("present unlisted: ok %v err %v", ok, err)
	}
	sum := sha256.Sum256([]byte("1 1\n"))
	listed := map[string]string{ProtocolName: hex.EncodeToString(sum[:])}
	_ = os.WriteFile(filepath.Join(rel, ProtocolName), []byte("1 5\n"), 0o644)
	if _, _, err := ReadProtocol(rel, listed); err == nil || !strings.Contains(err.Error(), filepath.Join(rel, ProtocolName)) {
		t.Fatalf("changed file: %v", err)
	}
	_ = os.Remove(filepath.Join(rel, ProtocolName))
	if _, _, err := ReadProtocol(rel, listed); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("listed, missing: %v", err)
	}
}

func TestParseProtocol(t *testing.T) {
	for text, want := range map[string]Protocol{"1 1\n": {1, 1}, "1 2\n": {1, 2}, "3 3": {3, 3}} {
		if got, err := ParseProtocol([]byte(text)); err != nil || got != want {
			t.Fatalf("%q: %+v %v", text, got, err)
		}
	}
	for _, text := range []string{"", "\n", "1", "0 1", "2 1", "1 2 3", "a b", "1 2\n3 4\n", " 1 2", "1  2"} {
		if _, err := ParseProtocol([]byte(text)); err == nil {
			t.Fatalf("%q parsed", text)
		}
	}
}

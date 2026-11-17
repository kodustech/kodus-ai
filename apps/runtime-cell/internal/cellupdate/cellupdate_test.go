package cellupdate

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
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

type signer struct {
	priv ed25519.PrivateKey
	keys []releasesig.PublicKey
}

func newSigner(t *testing.T) signer {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return signer{priv, []releasesig.PublicKey{{ID: releasesig.KeyID(pub), Key: pub}}}
}

// release writes a release as the workflow publishes it, every command for
// amd64 with body "<command> <release>", signed for name.
func (s signer) release(t *testing.T, name string) string {
	t.Helper()
	return s.releaseWith(t, name, "")
}

// releaseWith is release with cellBody as the cell command (a script),
// when not empty.
func (s signer) releaseWith(t *testing.T, name, cellBody string) string {
	t.Helper()
	dir := t.TempDir()
	var manifest strings.Builder
	for _, c := range append([]string{"resolver"}, Required...) {
		file, body := c+"-linux-amd64", c+" "+name
		if c == "cell" && cellBody != "" {
			body = cellBody
		}
		if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(body))
		manifest.WriteString(hex.EncodeToString(sum[:]) + "  " + file + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, releasesig.ManifestName), []byte(manifest.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	sig, err := releasesig.Sign(s.priv, name, []byte(manifest.String()))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, releasesig.SignatureName), sig, 0o644); err != nil {
		t.Fatal(err)
	}
	// The release workflow publishes the index next to the release, naming it the latest.
	s.index(t, dir, releasesig.Index{Issued: time.Now().Add(-time.Minute), Expires: time.Now().Add(30 * 24 * time.Hour), Latest: name, Minimum: name})
	return dir
}

// index writes a signed RELEASE-INDEX into dir, replacing one there.
func (s signer) index(t *testing.T, dir string, ix releasesig.Index) {
	t.Helper()
	text, err := releasesig.MarshalIndex(ix)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := releasesig.SignIndex(s.priv, text)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, releasesig.IndexName), text, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, releasesig.IndexSignatureName), sig, 0o644); err != nil {
		t.Fatal(err)
	}
}

type state struct{ current, previous, releases string }

func stateOf(t *testing.T, root string) state {
	t.Helper()
	cur, _ := os.Readlink(filepath.Join(root, "current"))
	prev, _ := os.Readlink(filepath.Join(root, "previous"))
	entries, _ := os.ReadDir(filepath.Join(root, "releases"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return state{cur, prev, strings.Join(names, ",")}
}

func TestASignedReleaseBecomesCurrentAndTheOneBeforePrevious(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	o := Options{Root: root, Arch: "amd64", Keys: s.keys}
	o.From, o.Release = s.release(t, "v1.0.0"), "v1.0.0"
	first, err := Install(o)
	if err != nil {
		t.Fatal(err)
	}
	o.From, o.Release = s.release(t, "v1.1.0"), "v1.1.0"
	second, err := Install(o)
	if err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, root); st.current != second || st.previous != first {
		t.Fatalf("current %s previous %s, want %s and %s", st.current, st.previous, second, first)
	}
	for _, c := range append([]string{"resolver"}, Required...) {
		b, err := os.ReadFile(filepath.Join(second, "bin", c))
		if err != nil || string(b) != c+" v1.1.0" {
			t.Fatalf("%s: %q %v", c, b, err)
		}
		if fi, _ := os.Stat(filepath.Join(second, "bin", c)); fi.Mode().Perm() != 0o755 {
			t.Fatalf("%s mode %v", c, fi.Mode())
		}
	}
}

// S-17 (a): an update whose signature is missing or wrong, or one of whose
// binaries is not the signed one, is refused naming the file, and nothing
// on the host changes: current and previous stay, no release directory or
// staging is left.
func TestAnUpdateThatDoesNotVerifyChangesNothing(t *testing.T) {
	s, other := newSigner(t), newSigner(t)
	for _, tc := range []struct {
		name    string
		release func(t *testing.T) (dir, file string)
		ask     string
	}{
		{"no signature", func(t *testing.T) (string, string) {
			dir := s.release(t, "v2.0.0")
			_ = os.Remove(filepath.Join(dir, releasesig.SignatureName))
			return dir, filepath.Join(dir, releasesig.SignatureName)
		}, "v2.0.0"},
		{"a key that is not pinned", func(t *testing.T) (string, string) {
			dir := other.release(t, "v2.0.0")
			// The index is the pinned key's: the refusal is the release's own signature.
			s.index(t, dir, releasesig.Index{Issued: time.Now().Add(-time.Minute), Expires: time.Now().Add(24 * time.Hour), Latest: "v2.0.0", Minimum: "v2.0.0"})
			return dir, filepath.Join(dir, releasesig.SignatureName)
		}, "v2.0.0"},
		{"an older signed release asked as a newer one", func(t *testing.T) (string, string) {
			dir := s.release(t, "v0.9.0")
			return dir, filepath.Join(dir, releasesig.SignatureName)
		}, "v2.0.0"},
		{"one byte of a binary changed", func(t *testing.T) (string, string) {
			dir := s.release(t, "v2.0.0")
			bin := filepath.Join(dir, "egress-linux-amd64")
			b, _ := os.ReadFile(bin)
			b[0] ^= 1
			_ = os.WriteFile(bin, b, 0o755)
			return dir, bin
		}, "v2.0.0"},
		{"a binary missing", func(t *testing.T) (string, string) {
			dir := s.release(t, "v2.0.0")
			bin := filepath.Join(dir, "reaper-linux-amd64")
			_ = os.Remove(bin)
			return dir, bin
		}, "v2.0.0"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			o := Options{Root: root, Arch: "amd64", Keys: s.keys}
			for _, v := range []string{"v1.0.0", "v1.1.0"} {
				o.From, o.Release = s.release(t, v), v
				if _, err := Install(o); err != nil {
					t.Fatal(err)
				}
			}
			before := stateOf(t, root)
			dir, file := tc.release(t)
			o.From, o.Release = dir, tc.ask
			_, err := Install(o)
			var re *releasesig.Error
			if !errors.As(err, &re) || re.File != file {
				t.Fatalf("got %v, want a refusal naming %s", err, file)
			}
			if after := stateOf(t, root); after != before {
				t.Fatalf("the host changed: %+v, was %+v", after, before)
			}
		})
	}
}

// The same release asked again is reused only while its installed binaries
// are still the signed ones.
func TestAReleaseInstalledBeforeIsReusedOnlyWhenItStillMatches(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	from := s.release(t, "v1.0.0")
	o := Options{Root: root, From: from, Release: "v1.0.0", Arch: "amd64", Keys: s.keys}
	dest, err := Install(o)
	if err != nil {
		t.Fatal(err)
	}
	if again, err := Install(o); err != nil || again != dest {
		t.Fatalf("again: %s %v", again, err)
	}
	cell := filepath.Join(dest, "bin", "cell")
	_ = os.WriteFile(cell, []byte("swapped"), 0o755)
	_, err = Install(o)
	var re *releasesig.Error
	if !errors.As(err, &re) || re.File != cell {
		t.Fatalf("got %v, want a refusal naming %s", err, cell)
	}
}

func TestVerifyOnlyInstallsNothing(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	if _, err := Install(Options{Root: root, From: s.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: s.keys, VerifyOnly: true}); err != nil {
		t.Fatal(err)
	}
	if st := stateOf(t, root); st != (state{}) {
		t.Fatalf("verify-only installed %+v", st)
	}
}

// `cell update` exits 1 and names the file it refused; with no key file
// it uses the keys compiled in, and none pinned refuses every release.
func TestTheCommandRefusesNamingTheFile(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "keys.pub")
	_ = os.WriteFile(keyFile, []byte(releasesig.FormatPublicKey(s.keys[0].Key)), 0o644)
	from := s.release(t, "v1.0.0")
	bin := filepath.Join(from, "cell-linux-amd64")
	_ = os.WriteFile(bin, []byte("evil"), 0o755)
	var out, errOut bytes.Buffer
	if code := Run([]string{"-root", root, "-from", from, "-release", "v1.0.0", "-arch", "amd64", "-keys", keyFile}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), bin) {
		t.Fatalf("exit %d, stderr %q: want 1 naming %s", code, errOut.String(), bin)
	}
	good := s.release(t, "v1.0.0")
	if code := Run([]string{"-root", root, "-from", good, "-release", "v1.0.0", "-arch", "amd64", "-keys", keyFile}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	pinned, _ := releasesig.Pinned()
	if len(pinned) == 0 {
		errOut.Reset()
		if code := Run([]string{"-root", root, "-from", good, "-release", "v1.0.0", "-arch", "amd64"}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "no release key is pinned") {
			t.Fatalf("with no key pinned: exit %d, %q", code, errOut.String())
		}
	}
}

// Finding 12: a signature binds a release to its name, not to the host's
// history, so any older signed release verifies. An update lower than the
// installed release is refused, and nothing on the host changes, unless the
// operator passes -allow-downgrade.
func TestADowngradeIsRefusedUnlessAllowed(t *testing.T) {
	s := newSigner(t)
	for _, tc := range []struct {
		name, installed, ask string
		allow, refused       bool
	}{
		{"older release", "v1.2.0", "v1.1.9", false, true},
		{"older major", "v2.0.0", "v1.9.9", false, true},
		{"pre-release of the installed one", "v1.2.0", "v1.2.0-rc.1", false, true},
		{"dev build over a release", "v1.2.0", "v0.0.0-dev+0123456789ab", false, true},
		{"not semver over a release", "v1.2.0", "nightly", false, true},
		{"older release, allowed", "v1.2.0", "v1.1.9", true, false},
		{"dev build over a release, allowed", "v1.2.0", "v0.0.0-dev+0123456789ab", true, false},
		{"same release", "v1.2.0", "v1.2.0", false, false},
		{"newer patch", "v1.2.0", "v1.2.1", false, false},
		{"newer minor, numeric not lexical", "v1.9.0", "v1.10.0", false, false},
		{"release over its pre-release", "v1.2.0-rc.1", "v1.2.0", false, false},
		{"release over a dev build", "v0.0.0-dev+0123456789ab", "v1.0.0", false, false},
		{"dev build over a dev build", "v0.0.0-dev+0123456789ab", "v0.0.0-dev+ba9876543210", false, false},
		{"tag-form names", "runtime-cell/v1.2.0", "runtime-cell/v1.1.0", false, true},
		{"a local build installs anything", "dev", "v0.1.0", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			o := Options{Root: root, Arch: "amd64", Keys: s.keys, Installed: tc.installed, AllowDowngrade: tc.allow}
			o.From, o.Release = s.release(t, tc.ask), tc.ask
			_, err := Install(o)
			if !tc.refused {
				if err != nil {
					t.Fatalf("installing %s over %s: %v", tc.ask, tc.installed, err)
				}
				return
			}
			var re *releasesig.Error
			if !errors.As(err, &re) || !strings.Contains(re.Reason, "-allow-downgrade") {
				t.Fatalf("installing %s over %s: got %v, want a refusal that names -allow-downgrade", tc.ask, tc.installed, err)
			}
			if st := stateOf(t, root); st != (state{}) {
				t.Fatalf("a refused downgrade changed the host: %+v", st)
			}
		})
	}
}

// `cell update` orders the release against the cell running it and takes
// -allow-downgrade.
func TestTheCommandRefusesADowngradeWithoutTheFlag(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "keys.pub")
	_ = os.WriteFile(keyFile, []byte(releasesig.FormatPublicKey(s.keys[0].Key)), 0o644)
	saved := installedVersion
	installedVersion = func() string { return "v1.1.0" }
	t.Cleanup(func() { installedVersion = saved })
	from := s.release(t, "v1.0.0")
	args := []string{"-root", root, "-from", from, "-release", "v1.0.0", "-arch", "amd64", "-keys", keyFile}
	var out, errOut bytes.Buffer
	if code := Run(args, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "older than the installed v1.1.0") {
		t.Fatalf("exit %d, stderr %q: want 1 and a downgrade refusal", code, errOut.String())
	}
	if code := Run(append(args, "-allow-downgrade"), &out, &errOut); code != 0 {
		t.Fatalf("with -allow-downgrade: exit %d: %s", code, errOut.String())
	}
}

// cell update runs the staged release's `cell preflight` with the cell's
// config before the swap: a host the new release would refuse keeps the
// release it runs, and the staged one is left for the next try.
func TestAnUpdateWhosePreflightFailsKeepsTheCurrentRelease(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "keys.pub")
	_ = os.WriteFile(keyFile, []byte(releasesig.FormatPublicKey(s.keys[0].Key)), 0o644)
	cfg := filepath.Join(t.TempDir(), "cell.yaml")
	marker := filepath.Join(t.TempDir(), "args")
	base := []string{"-root", root, "-arch", "amd64", "-keys", keyFile, "-preflight-config", cfg}
	var out, errOut bytes.Buffer
	if code := Run(append(base, "-from", s.release(t, "v1.0.0"), "-release", "v1.0.0", "-skip-preflight"), &out, &errOut); code != 0 {
		t.Fatalf("first install: exit %d, %s", code, errOut.String())
	}
	before := stateOf(t, root)

	failing := "#!/bin/sh\necho \"$@\" > " + marker + "\necho 'fail runsc: Docker has no runtime named runsc'\nexit 1\n"
	out.Reset()
	errOut.Reset()
	if code := Run(append(base, "-from", s.releaseWith(t, "v1.1.0", failing), "-release", "v1.1.0"), &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "preflight") {
		t.Fatalf("exit %d, stderr %q", code, errOut.String())
	}
	if got := stateOf(t, root); got.current != before.current || got.previous != before.previous {
		t.Fatalf("the swap happened: %+v, was %+v", got, before)
	}
	if b, err := os.ReadFile(marker); err != nil || strings.TrimSpace(string(b)) != "preflight -config "+cfg {
		t.Fatalf("the staged cell ran with %q (%v)", b, err)
	}
	if !strings.Contains(out.String(), "fail runsc") {
		t.Fatalf("the preflight's report is not shown: %q", out.String())
	}

	passing := "#!/bin/sh\nexit 0\n"
	if code := Run(append(base, "-from", s.releaseWith(t, "v1.2.0", passing), "-release", "v1.2.0"), &out, &errOut); code != 0 {
		t.Fatalf("passing preflight: exit %d, %s", code, errOut.String())
	}
	if got := stateOf(t, root); got.current == before.current || got.previous != before.current {
		t.Fatalf("no swap after a passing preflight: %+v", got)
	}
}

// Without the cell's config there is nothing to check the host against:
// the update says so and installs as before.
func TestAnUpdateWithoutTheCellsConfigSaysItRanNoPreflight(t *testing.T) {
	t.Setenv("KODUS_CELL_CONFIG", "")
	s, root := newSigner(t), t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "keys.pub")
	_ = os.WriteFile(keyFile, []byte(releasesig.FormatPublicKey(s.keys[0].Key)), 0o644)
	var out, errOut bytes.Buffer
	if code := Run([]string{"-root", root, "-from", s.release(t, "v1.0.0"), "-release", "v1.0.0", "-arch", "amd64", "-keys", keyFile}, &out, &errOut); code != 0 || !strings.Contains(errOut.String(), "preflight does not run") {
		t.Fatalf("exit %d, stderr %q", code, errOut.String())
	}
}

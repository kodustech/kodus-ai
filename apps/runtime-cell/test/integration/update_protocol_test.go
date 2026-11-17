package integration

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/cellupdate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubprotocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

// signedRelease is a release directory as the workflow publishes it, for
// amd64, with PROTOCOL saying it speaks speaks, signed with a new key.
func signedRelease(t *testing.T, name string, speaks releasesig.Protocol) (string, []releasesig.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	files := map[string]string{releasesig.ProtocolName: releasesig.FormatProtocol(speaks)}
	for _, c := range cellupdate.Required {
		files[c+"-linux-amd64"] = c + " " + name
	}
	var manifest strings.Builder
	for file, body := range files {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte(body))
		manifest.WriteString(hex.EncodeToString(sum[:]) + "  " + file + "\n")
	}
	sig, err := releasesig.Sign(priv, name, []byte(manifest.String()))
	if err != nil {
		t.Fatal(err)
	}
	ix, err := releasesig.MarshalIndex(releasesig.Index{Issued: time.Now().Add(-time.Minute), Expires: time.Now().Add(24 * time.Hour), Latest: name, Minimum: name})
	if err != nil {
		t.Fatal(err)
	}
	ixSig, err := releasesig.SignIndex(priv, ix)
	if err != nil {
		t.Fatal(err)
	}
	for file, b := range map[string][]byte{releasesig.ManifestName: []byte(manifest.String()), releasesig.SignatureName: sig, releasesig.IndexName: ix, releasesig.IndexSignatureName: ixSig} {
		if err := os.WriteFile(filepath.Join(dir, file), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir, []releasesig.PublicKey{{ID: releasesig.KeyID(pub), Key: pub}}
}

// The whole skew guard on a host: the cell reaches the hub, which names the
// cell protocols it accepts; the agent keeps them; cell update then refuses
// a release of a protocol the hub does not accept yet, and installs one it
// does.
func TestCellUpdateRefusesAReleaseTheHubTheCellReachedWouldRefuse(t *testing.T) {
	w := newWorld(t)
	var st hubprotocol.State
	deadline := time.Now().Add(5 * time.Second)
	for {
		s, ok, err := hubprotocol.Load(w.hubState)
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			st = s
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %s after the hello:\n%s", w.hubState, w.logs.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	pv := int64(protocol.ProtocolVersion)
	if st.Version != pv || st.Accepts == nil || st.Accepts.Max != pv || st.Accepts.Min != protocol.SupportedVersions()[0] {
		t.Fatalf("state %+v", st)
	}

	root := t.TempDir()
	newer, keys := signedRelease(t, "v9.0.0", releasesig.Protocol{Min: pv, Max: pv + 1})
	_, err := cellupdate.Install(cellupdate.Options{Root: root, From: newer, Release: "v9.0.0", Arch: "amd64", Keys: keys, HubState: w.hubState})
	if err == nil || !strings.Contains(err.Error(), "cell_too_new") || !strings.Contains(err.Error(), "upgrade the hub first") {
		t.Fatalf("a release newer than the hub installed: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, "current")); err == nil {
		t.Fatal("a refused update made a release current")
	}

	same, keys := signedRelease(t, "v9.0.0", releasesig.Protocol{Min: pv, Max: pv})
	if _, err := cellupdate.Install(cellupdate.Options{Root: root, From: same, Release: "v9.0.0", Arch: "amd64", Keys: keys, HubState: w.hubState}); err != nil {
		t.Fatalf("a release the hub accepts was refused: %v", err)
	}
}

// The automatic rollback's health signal is the agent's own write: after
// `cell update` swaps with a rollback window, a hello the agent made before
// the swap does not keep the new release (the watch rolls it back once the
// window is over), and the agent's next accepted hello after the swap does.
func TestTheWatchReadsTheAgentsHelloAfterTheSwap(t *testing.T) {
	w := newWorld(t)
	waitState := func(after time.Time) hubprotocol.State {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			s, ok, err := hubprotocol.Load(w.hubState)
			if err != nil {
				t.Fatal(err)
			}
			if ok && s.At.After(after) {
				return s
			}
			if time.Now().After(deadline) {
				t.Fatalf("no hello after %s in %s:\n%s", after, w.hubState, w.logs.String())
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitState(time.Time{})
	pv := int64(protocol.ProtocolVersion)
	install := func(root, name string, window time.Duration) {
		t.Helper()
		from, keys := signedRelease(t, name, releasesig.Protocol{Min: pv, Max: pv})
		if _, err := cellupdate.Install(cellupdate.Options{Root: root, From: from, Release: name, Arch: "amd64", Keys: keys,
			HubState: w.hubState, HelloState: w.hubState, RollbackWindow: window}); err != nil {
			t.Fatal(err)
		}
	}

	// The only hello on record is from before the swap: rolled back once the window ends.
	stale := t.TempDir()
	install(stale, "v9.0.0", 0)
	install(stale, "v9.1.0", time.Minute)
	got, err := cellupdate.Watch(cellupdate.WatchOptions{Root: stale, Now: func() time.Time { return time.Now().Add(2 * time.Minute) }})
	if err != nil || got != cellupdate.RolledBack {
		t.Fatalf("a hello from before the swap kept the release: %s %v", got, err)
	}

	root := t.TempDir()
	install(root, "v9.0.0", 0)
	swapped := time.Now()
	install(root, "v9.1.0", time.Minute)
	if got, err := cellupdate.Watch(cellupdate.WatchOptions{Root: root}); err != nil || got != cellupdate.Waiting {
		t.Fatalf("before the next hello: %s %v", got, err)
	}
	w.hub.Disconnect("cell-1")
	waitState(swapped)
	if got, err := cellupdate.Watch(cellupdate.WatchOptions{Root: root, Now: func() time.Time { return time.Now().Add(time.Hour) }}); err != nil || got != cellupdate.Kept {
		t.Fatalf("after the agent's hello: %s %v", got, err)
	}
}

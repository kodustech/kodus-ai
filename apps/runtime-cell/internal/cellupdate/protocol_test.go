package cellupdate

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubprotocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

// hubState writes what the agent keeps after a hello ack into a cell state
// dir, and returns the file.
func hubState(t *testing.T, s hubprotocol.State) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), hubprotocol.StateName)
	if s.At.IsZero() {
		s.At = time.Date(2026, 11, 16, 9, 0, 0, 0, time.UTC)
	}
	if err := hubprotocol.Save(path, s); err != nil {
		t.Fatal(err)
	}
	return path
}

// installedV1 installs v1.0.0 on a fresh root and returns the root and the
// release directory, so a refused update can be seen to keep it current.
func installedV1(t *testing.T, s signer) (string, string) {
	t.Helper()
	root := t.TempDir()
	dest, err := Install(Options{Root: root, From: s.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: s.keys})
	if err != nil {
		t.Fatal(err)
	}
	return root, dest
}

func keptCurrent(t *testing.T, root, current string, err error, want ...string) {
	t.Helper()
	if err == nil {
		t.Fatal("the update was not refused")
	}
	for _, w := range want {
		if !strings.Contains(err.Error(), w) {
			t.Fatalf("refusal %q lacks %q", err, w)
		}
	}
	if st := stateOf(t, root); st.current != current || st.previous != "" || strings.Contains(st.releases, "v1.1.0") || strings.Contains(st.releases, ".staging") {
		t.Fatalf("a refused update changed the host: %+v", st)
	}
}

// A release newer than the hub the cell last reached would be refused at
// hello (cell_too_new) and leave the host with a cell that never connects:
// cell update refuses it before anything changes, naming both protocols
// and the fix.
func TestAReleaseNewerThanTheHubAcceptsIsRefusedBeforeTheSwap(t *testing.T) {
	s := newSigner(t)
	root, current := installedV1(t, s)
	from := s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "1 2\n"})
	state := hubState(t, hubprotocol.State{Version: 1, Accepts: &hubprotocol.Range{Min: 1, Max: 1}})
	_, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: state, Installed: "v1.0.0"})
	keptCurrent(t, root, current, err, "v1.1.0", "protocol v2", "v1 to v1", "cell_too_new", "upgrade the hub first", "-skip-protocol-check")
	// -verify-only says the same: it checks what an install would.
	_, err = Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: state, VerifyOnly: true})
	keptCurrent(t, root, current, err, "cell_too_new")
}

// A release older than the oldest protocol the hub accepts is refused too.
func TestAReleaseOlderThanTheHubAcceptsIsRefused(t *testing.T) {
	s := newSigner(t)
	root, current := installedV1(t, s)
	from := s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "1 1\n"})
	state := hubState(t, hubprotocol.State{Version: 2, Accepts: &hubprotocol.Range{Min: 2, Max: 3}})
	_, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: state})
	keptCurrent(t, root, current, err, "protocol v1", "v2 to v3", "cell_too_old", "a release of protocol v2 or newer")
}

// A release the hub accepts installs, with no note.
func TestAReleaseTheHubAcceptsInstalls(t *testing.T) {
	s := newSigner(t)
	root, _ := installedV1(t, s)
	from := s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "1 2\n"})
	state := hubState(t, hubprotocol.State{Version: 1, Accepts: &hubprotocol.Range{Min: 1, Max: 2}})
	var notes bytes.Buffer
	dest, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: state, Notes: &notes})
	if err != nil || stateOf(t, root).current != dest || notes.Len() != 0 {
		t.Fatalf("dest %s err %v notes %q", dest, err, notes.String())
	}
}

// A hub that named no range (one before the field, protocol 1) is taken at
// the version it chose: a release of a newer protocol is refused, saying so.
func TestAHubThatNamedNoRangeIsTakenAtTheVersionItChose(t *testing.T) {
	s := newSigner(t)
	root, current := installedV1(t, s)
	from := s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "1 2\n"})
	state := hubState(t, hubprotocol.State{Version: 1})
	_, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: state})
	keptCurrent(t, root, current, err, "cell_too_new", "named no range", "upgrade the hub first")
}

// The cases that cannot be checked install as before, each saying why the
// check did not run: a cell that never reached a hub (no state), and a
// release from before PROTOCOL (backward compatible).
func TestWhatCannotBeCheckedInstallsWithANote(t *testing.T) {
	s := newSigner(t)
	t.Run("never connected", func(t *testing.T) {
		root, _ := installedV1(t, s)
		from := s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "1 2\n"})
		var notes bytes.Buffer
		missing := filepath.Join(t.TempDir(), hubprotocol.StateName)
		dest, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: missing, Notes: &notes})
		if err != nil || stateOf(t, root).current != dest || !strings.Contains(notes.String(), "has not reached a hub") || !strings.Contains(notes.String(), missing) {
			t.Fatalf("err %v notes %q", err, notes.String())
		}
	})
	t.Run("release without PROTOCOL", func(t *testing.T) {
		root, _ := installedV1(t, s)
		var notes bytes.Buffer
		state := hubState(t, hubprotocol.State{Version: 1, Accepts: &hubprotocol.Range{Min: 1, Max: 1}})
		dest, err := Install(Options{Root: root, From: s.release(t, "v1.1.0"), Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: state, Notes: &notes})
		if err != nil || stateOf(t, root).current != dest || !strings.Contains(notes.String(), "does not say which protocol") || !strings.Contains(notes.String(), "-require-protocol") {
			t.Fatalf("err %v notes %q", err, notes.String())
		}
	})
	t.Run("release without PROTOCOL, required", func(t *testing.T) {
		root, current := installedV1(t, s)
		_, err := Install(Options{Root: root, From: s.release(t, "v1.1.0"), Release: "v1.1.0", Arch: "amd64", Keys: s.keys, RequireProtocol: true})
		keptCurrent(t, root, current, err, "does not say which protocol", releasesig.ProtocolName)
	})
}

// -skip-protocol-check installs what the check would refuse: the operator
// who upgraded the hub before this cell reconnected says so.
func TestSkippingTheProtocolCheckInstallsAndSaysSo(t *testing.T) {
	s := newSigner(t)
	root, _ := installedV1(t, s)
	from := s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "2 2\n"})
	state := hubState(t, hubprotocol.State{Version: 1, Accepts: &hubprotocol.Range{Min: 1, Max: 1}})
	var notes bytes.Buffer
	dest, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: state, SkipProtocolCheck: true, Notes: &notes})
	if err != nil || stateOf(t, root).current != dest || !strings.Contains(notes.String(), "-skip-protocol-check") {
		t.Fatalf("err %v notes %q", err, notes.String())
	}
}

// PROTOCOL is signed like every other file: one that does not match
// SHA256SUMS, or does not read, is refused naming it; a hub state that does
// not read is refused, never taken for none.
func TestAPROTOCOLOrStateThatDoesNotReadIsRefused(t *testing.T) {
	s := newSigner(t)
	root, current := installedV1(t, s)
	from := s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "1 1\n"})
	if err := os.WriteFile(filepath.Join(from, releasesig.ProtocolName), []byte("1 9\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys})
	keptCurrent(t, root, current, err, filepath.Join(from, releasesig.ProtocolName))

	from = s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "two\n"})
	_, err = Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys})
	keptCurrent(t, root, current, err, releasesig.ProtocolName)

	from = s.releaseFiles(t, "v1.1.0", "", map[string]string{releasesig.ProtocolName: "1 1\n"})
	bad := filepath.Join(t.TempDir(), hubprotocol.StateName)
	_ = os.WriteFile(bad, []byte("{"), 0o600)
	_, err = Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: s.keys, HubState: bad})
	keptCurrent(t, root, current, err, bad, "-skip-protocol-check")
}

// The command finds the hub state in the cell's state dir: -state-dir, or
// the one the cell's config gives (asked of the cell's own settings), and
// prints the refusal and its fix.
func TestTheCommandReadsTheHubStateFromTheCellsStateDir(t *testing.T) {
	t.Setenv("KODUS_CELL_CONFIG", "")
	s := newSigner(t)
	keyFile := filepath.Join(t.TempDir(), "keys.pub")
	_ = os.WriteFile(keyFile, []byte(releasesig.FormatPublicKey(s.keys[0].Key)), 0o644)
	stateDir := filepath.Dir(hubState(t, hubprotocol.State{Version: 1, Accepts: &hubprotocol.Range{Min: 1, Max: 1}}))
	from := s.releaseFiles(t, "v1.0.0", "", map[string]string{releasesig.ProtocolName: "1 2\n"})
	base := []string{"-from", from, "-release", "v1.0.0", "-arch", "amd64", "-keys", keyFile, "-skip-preflight"}
	noConfig := func(string) (string, error) { return "", errors.New("not asked") }

	var out, errOut bytes.Buffer
	if code := Run(append(base, "-root", t.TempDir(), "-state-dir", stateDir), &out, &errOut, noConfig); code != 1 || !strings.Contains(errOut.String(), "upgrade the hub first") {
		t.Fatalf("-state-dir: exit %d, stderr %q", code, errOut.String())
	}

	var asked string
	fromConfig := func(config string) (string, error) { asked = config; return stateDir, nil }
	errOut.Reset()
	if code := Run(append(base, "-root", t.TempDir(), "-preflight-config", "/etc/kodus/cell/config.yaml"), &out, &errOut, fromConfig); code != 1 || asked != "/etc/kodus/cell/config.yaml" || !strings.Contains(errOut.String(), "cell_too_new") {
		t.Fatalf("config: exit %d, asked %q, stderr %q", code, asked, errOut.String())
	}

	errOut.Reset()
	broken := func(string) (string, error) { return "", errors.New("config: unknown key") }
	if code := Run(append(base, "-root", t.TempDir()), &out, &errOut, broken); code != 1 || !strings.Contains(errOut.String(), "-state-dir") {
		t.Fatalf("unreadable config: exit %d, stderr %q", code, errOut.String())
	}

	errOut.Reset()
	root := t.TempDir()
	if code := Run(append(base, "-root", root, "-state-dir", stateDir, "-skip-protocol-check"), &out, &errOut, noConfig); code != 0 || !strings.Contains(errOut.String(), "-skip-protocol-check") || stateOf(t, root).current == "" {
		t.Fatalf("skip: exit %d, stderr %q", code, errOut.String())
	}
}

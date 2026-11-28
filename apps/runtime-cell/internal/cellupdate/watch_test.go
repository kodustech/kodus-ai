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

// swapAt is when the watched update swaps in these tests.
var swapAt = time.Now().Add(time.Hour).UTC().Truncate(time.Second)

// host is a cell host after `cell update` swapped v1.0.0 for v1.1.0 with a
// rollback window: v1.0.0 kept the settings and units it ran with (as the
// installer keeps them), /etc holds v1.1.0's.
type host struct {
	s signer
	// floor is the minimum of the index each update installs under; the
	// first release when empty, so the release before stays installable.
	floor                 string
	root, first, second   string
	hello, envFile, units string
	restarts              int
	restartErr            error
	out                   bytes.Buffer
}

func updatedHost(t *testing.T) *host {
	t.Helper()
	h := &host{s: newSigner(t), root: t.TempDir()}
	h.hello = filepath.Join(t.TempDir(), hubprotocol.StateName)
	etc := t.TempDir()
	h.envFile, h.units = filepath.Join(etc, "cell.env"), filepath.Join(etc, "systemd")
	first, err := Install(Options{Root: h.root, From: h.s.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: h.s.keys})
	if err != nil {
		t.Fatal(err)
	}
	h.first = first
	write(t, filepath.Join(first, "cell.env"), "HOLDER_IMAGE=old\n")
	write(t, filepath.Join(first, "systemd", "kodus-cell.service"), "old unit\n")
	write(t, h.envFile, "HOLDER_IMAGE=new\n")
	write(t, filepath.Join(h.units, "kodus-cell.service"), "new unit\n")
	h.second = h.update(t, Options{})
	return h
}

// update installs v1.1.0 over what runs, at swapAt, with a 10 minute window.
func (h *host) update(t *testing.T, o Options) string {
	t.Helper()
	dest, err := h.install(t, o)
	if err != nil {
		t.Fatal(err)
	}
	return dest
}

func (h *host) install(t *testing.T, o Options) (string, error) {
	t.Helper()
	if o.Release == "" {
		o.Release = "v1.1.0"
	}
	o.Root, o.From, o.Arch, o.Keys = h.root, h.s.release(t, o.Release), "amd64", h.s.keys
	floor := h.floor
	if floor == "" {
		floor = "v1.0.0"
	}
	h.s.index(t, o.From, releasesig.Index{Issued: time.Now().Add(-time.Minute), Expires: time.Now().Add(30 * 24 * time.Hour), Latest: o.Release, Minimum: floor})
	o.HelloState = h.hello
	if o.RollbackWindow == 0 {
		o.RollbackWindow = 10 * time.Minute
	}
	if o.Now == nil {
		o.Now = func() time.Time { return swapAt }
	}
	return Install(o)
}

func (h *host) watch(t *testing.T, at time.Time) (Outcome, error) {
	t.Helper()
	return Watch(WatchOptions{
		Root: h.root, Now: func() time.Time { return at }, EnvFile: h.envFile, UnitsDir: h.units, Out: &h.out,
		Restart: func() error { h.restarts++; return h.restartErr },
	})
}

// helloAt is the agent's write after an accepted hello at.
func (h *host) helloAt(t *testing.T, at time.Time) {
	t.Helper()
	if err := hubprotocol.Save(h.hello, hubprotocol.State{Version: 1, At: at}); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func pendingExists(root string) bool {
	_, err := os.Stat(filepath.Join(root, PendingName))
	return err == nil
}

// A release that completes no accepted hello within the window after the
// swap is rolled back by the watch, with no operator: current goes back to
// the release before, which gets its settings and units back, the cell
// restarts, and one line names both releases and why. Before the window
// ends nothing changes. The only hello on record was the old cell's, before
// the swap: it does not count.
func TestAReleaseWithNoHelloWithinTheWindowIsRolledBack(t *testing.T) {
	h := updatedHost(t)
	h.helloAt(t, swapAt.Add(-time.Hour))

	if got, err := h.watch(t, swapAt.Add(9*time.Minute)); err != nil || got != Waiting {
		t.Fatalf("inside the window: %s %v", got, err)
	}
	if st := stateOf(t, h.root); st.current != h.second || h.restarts != 0 {
		t.Fatalf("the watch acted inside the window: %+v, %d restarts", st, h.restarts)
	}

	h.out.Reset()
	got, err := h.watch(t, swapAt.Add(10*time.Minute+time.Second))
	if err != nil || got != RolledBack {
		t.Fatalf("after the window: %s %v", got, err)
	}
	if st := stateOf(t, h.root); st.current != h.first || st.previous != h.second {
		t.Fatalf("after the rollback current %s previous %s, want %s and %s", st.current, st.previous, h.first, h.second)
	}
	if read(t, h.envFile) != "HOLDER_IMAGE=old\n" || read(t, filepath.Join(h.units, "kodus-cell.service")) != "old unit\n" {
		t.Fatal("the release rolled back to did not get its settings and units back")
	}
	if fi, _ := os.Stat(h.envFile); fi.Mode().Perm() != 0o600 {
		t.Fatalf("cell.env restored %v, want 0600", fi.Mode().Perm())
	}
	if h.restarts != 1 || pendingExists(h.root) {
		t.Fatalf("%d restarts, marker left %v", h.restarts, pendingExists(h.root))
	}
	line := strings.TrimSpace(h.out.String())
	for _, want := range []string{"rolled back", "v1.1.0", "v1.0.0", "no accepted hello", "10m0s", "-retry-rolled-back"} {
		if !strings.Contains(line, want) {
			t.Fatalf("rollback line %q lacks %q", line, want)
		}
	}
	if strings.Count(line, "\n") != 0 {
		t.Fatalf("the rollback says more than one line: %q", line)
	}
}

// A release whose cell completed an accepted hello after the swap is never
// rolled back, however late the watch looks; the watch ends there.
func TestAReleaseThatConnectedAfterTheSwapIsKept(t *testing.T) {
	h := updatedHost(t)
	h.helloAt(t, swapAt.Add(2*time.Minute))
	if got, err := h.watch(t, swapAt.Add(time.Hour)); err != nil || got != Kept {
		t.Fatalf("got %s %v, want kept", got, err)
	}
	if st := stateOf(t, h.root); st.current != h.second || h.restarts != 0 || pendingExists(h.root) {
		t.Fatalf("a release that connected was touched: %+v, %d restarts, marker %v", st, h.restarts, pendingExists(h.root))
	}
	if got, err := h.watch(t, swapAt.Add(2*time.Hour)); err != nil || got != NothingPending {
		t.Fatalf("a second look: %s %v", got, err)
	}
}

// The new release may write a state this (older) watcher cannot parse: a
// state file written after the swap is the new cell's hello all the same.
func TestAStateTheWatcherCannotReadButWrittenAfterTheSwapCountsAsAHello(t *testing.T) {
	h := updatedHost(t)
	write(t, h.hello, `{"version":1,"at":"2026-11-17T09:02:00Z","newField":true}`+"\n")
	if err := os.Chtimes(h.hello, swapAt.Add(2*time.Minute), swapAt.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if got, err := h.watch(t, swapAt.Add(time.Hour)); err != nil || got != Kept {
		t.Fatalf("got %s %v, want kept", got, err)
	}
}

// A rolled-back release is never retried by itself: the watch never moves
// current forward, and the next `cell update` of that release is refused
// unless the operator says -retry-rolled-back. A retry that then connects
// is forgotten as rolled back.
func TestARolledBackReleaseIsNotRetried(t *testing.T) {
	h := updatedHost(t)
	if got, err := h.watch(t, swapAt.Add(11*time.Minute)); err != nil || got != RolledBack {
		t.Fatalf("rollback: %s %v", got, err)
	}
	for _, at := range []time.Duration{12 * time.Minute, 24 * time.Hour} {
		if got, err := h.watch(t, swapAt.Add(at)); err != nil || got != NothingPending {
			t.Fatalf("after the rollback: %s %v", got, err)
		}
	}
	if st := stateOf(t, h.root); st.current != h.first || h.restarts != 1 {
		t.Fatalf("the watch moved the host again: %+v, %d restarts", st, h.restarts)
	}

	before := stateOf(t, h.root)
	_, err := h.install(t, Options{Now: func() time.Time { return swapAt.Add(time.Hour) }})
	var re *releasesig.Error
	if !errors.As(err, &re) || !strings.Contains(re.Reason, "rolled back") || !strings.Contains(re.Reason, "-retry-rolled-back") {
		t.Fatalf("installing the rolled-back release again: %v", err)
	}
	if st := stateOf(t, h.root); st != before || pendingExists(h.root) {
		t.Fatalf("a refused retry changed the host: %+v", st)
	}

	retryAt := swapAt.Add(time.Hour)
	h.update(t, Options{RetryRolledBack: true, Now: func() time.Time { return retryAt }})
	if st := stateOf(t, h.root); st.current != h.second || !pendingExists(h.root) {
		t.Fatalf("-retry-rolled-back: %+v, marker %v", st, pendingExists(h.root))
	}
	h.helloAt(t, retryAt.Add(time.Minute))
	if got, err := h.watch(t, retryAt.Add(20*time.Minute)); err != nil || got != Kept {
		t.Fatalf("the retry connected: %s %v", got, err)
	}
	if b, err := os.ReadFile(filepath.Join(h.root, RolledBackName)); err == nil && strings.Contains(string(b), filepath.Base(h.second)) {
		t.Fatalf("a release that connected is still listed as rolled back: %s", b)
	}
	if _, err := h.install(t, Options{Release: "v1.1.0", Now: func() time.Time { return retryAt.Add(time.Hour) }}); err != nil {
		t.Fatalf("a release forgotten as rolled back is refused: %v", err)
	}
}

// The rollback reads and writes local files and runs the restart: nothing
// in it reaches the hub or any network, so it works with the hub gone (no
// hello was ever recorded) and no network settings at all.
func TestTheRollbackWorksWithTheHubUnreachable(t *testing.T) {
	h := updatedHost(t)
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	if _, err := os.Stat(h.hello); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the test needs no hub state: %v", err)
	}
	if got, err := h.watch(t, swapAt.Add(11*time.Minute)); err != nil || got != RolledBack {
		t.Fatalf("got %s %v", got, err)
	}
	if !strings.Contains(h.out.String(), "never") {
		t.Fatalf("the line does not say no hello was ever recorded: %q", h.out.String())
	}
}

// A rollback cut short (the restart failed) is finished by the next look,
// without swapping again.
func TestARollbackCutShortIsFinishedNextTime(t *testing.T) {
	h := updatedHost(t)
	h.restartErr = errors.New("systemctl: connection refused")
	if _, err := h.watch(t, swapAt.Add(11*time.Minute)); err == nil {
		t.Fatal("a failed restart was not an error")
	}
	if st := stateOf(t, h.root); st.current != h.first || !pendingExists(h.root) {
		t.Fatalf("after a failed restart: %+v, marker %v", st, pendingExists(h.root))
	}
	h.restartErr = nil
	if got, err := h.watch(t, swapAt.Add(12*time.Minute)); err != nil || got != RolledBack {
		t.Fatalf("finishing: %s %v", got, err)
	}
	if st := stateOf(t, h.root); st.current != h.first || st.previous != h.second || h.restarts != 2 || pendingExists(h.root) {
		t.Fatalf("finished: %+v, %d restarts, marker %v", st, h.restarts, pendingExists(h.root))
	}
}

// An operator who moved current by hand (cell-host.sh rollback, another
// update) took over: the watch drops its marker and changes nothing.
func TestAMarkerTheHostMovedPastChangesNothing(t *testing.T) {
	h := updatedHost(t)
	if err := relink(filepath.Join(h.root, "current"), h.first); err != nil {
		t.Fatal(err)
	}
	if err := relink(filepath.Join(h.root, "previous"), h.first); err != nil {
		t.Fatal(err)
	}
	if got, err := h.watch(t, swapAt.Add(time.Hour)); err != nil || got != Stale {
		t.Fatalf("got %s %v, want stale", got, err)
	}
	if st := stateOf(t, h.root); st.current != h.first || st.previous != h.first || h.restarts != 0 || pendingExists(h.root) {
		t.Fatalf("a stale marker changed the host: %+v, %d restarts", st, h.restarts)
	}
	if read(t, h.envFile) != "HOLDER_IMAGE=new\n" {
		t.Fatal("a stale marker restored settings")
	}
}

// No marker is written when there is nothing to return to (a first
// install), when the release was already current, or with no window.
func TestNoWatchWithoutAReleaseToReturnTo(t *testing.T) {
	s := newSigner(t)
	hello := filepath.Join(t.TempDir(), hubprotocol.StateName)
	root := t.TempDir()
	o := Options{Root: root, From: s.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: s.keys, HelloState: hello, RollbackWindow: time.Minute}
	if _, err := Install(o); err != nil || pendingExists(root) {
		t.Fatalf("first install: %v, marker %v", err, pendingExists(root))
	}
	if _, err := Install(o); err != nil || pendingExists(root) {
		t.Fatalf("the same release again: %v, marker %v", err, pendingExists(root))
	}
	o.From, o.Release, o.RollbackWindow = s.release(t, "v1.1.0"), "v1.1.0", 0
	if _, err := Install(o); err != nil || pendingExists(root) {
		t.Fatalf("no window: %v, marker %v", err, pendingExists(root))
	}
	o.From, o.Release, o.RollbackWindow, o.HelloState = s.release(t, "v1.2.0"), "v1.2.0", time.Minute, ""
	if _, err := Install(o); err == nil {
		t.Fatal("a window with no hello state to read was accepted")
	}
}

// While the release current has not yet connected since its swap, the
// release before it is the only one known to run: another update would
// make the unproven one previous, so it is refused until the hello comes
// (or the operator rolls back).
func TestAnUpdateOverAnUnconfirmedOneIsRefused(t *testing.T) {
	h := updatedHost(t)
	before := stateOf(t, h.root)
	_, err := h.install(t, Options{Release: "v1.2.0", Now: func() time.Time { return swapAt.Add(time.Minute) }})
	if err == nil || !strings.Contains(err.Error(), "has not completed an accepted hello") {
		t.Fatalf("an update over an unconfirmed release: %v", err)
	}
	if st := stateOf(t, h.root); st.current != before.current || st.previous != before.previous {
		t.Fatalf("the refused update swapped: %+v", st)
	}
	h.helloAt(t, swapAt.Add(2*time.Minute))
	third := h.update(t, Options{Release: "v1.2.0", Now: func() time.Time { return swapAt.Add(3 * time.Minute) }})
	if st := stateOf(t, h.root); st.current != third || st.previous != h.second {
		t.Fatalf("after the hello: %+v", st)
	}
}

// `cell update-watch` is the timer's command: it restarts with systemctl
// (daemon-reload, then the target) and prints the rollback line.
func TestTheWatchCommandRestartsWithSystemctl(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	hello := filepath.Join(t.TempDir(), hubprotocol.StateName)
	if _, err := Install(Options{Root: root, From: s.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: s.keys}); err != nil {
		t.Fatal(err)
	}
	next := s.release(t, "v1.1.0")
	s.index(t, next, releasesig.Index{Issued: time.Now().Add(-time.Second), Expires: time.Now().Add(24 * time.Hour), Latest: "v1.1.0", Minimum: "v1.0.0"})
	if _, err := Install(Options{
		Root: root, From: next, Release: "v1.1.0", Arch: "amd64", Keys: s.keys,
		HelloState: hello, RollbackWindow: time.Minute, Now: func() time.Time { return time.Now().Add(-2 * time.Minute) },
	}); err != nil {
		t.Fatal(err)
	}
	calls := filepath.Join(t.TempDir(), "calls")
	systemctl := filepath.Join(t.TempDir(), "systemctl")
	write(t, systemctl, "#!/bin/sh\necho \"$@\" >> "+calls+"\n")
	if err := os.Chmod(systemctl, 0o755); err != nil {
		t.Fatal(err)
	}
	var out, errOut bytes.Buffer
	if code := RunWatch([]string{"-root", root, "-systemctl", systemctl, "-env-file", "", "-units-dir", ""}, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if got := read(t, calls); got != "daemon-reload\nrestart kodus-cell.target\n" {
		t.Fatalf("systemctl calls %q", got)
	}
	if !strings.Contains(out.String(), "rolled back release v1.1.0") {
		t.Fatalf("stdout %q", out.String())
	}
	if code := RunWatch([]string{"-root", root, "-systemctl", systemctl}, &out, &errOut); code != 0 {
		t.Fatalf("nothing pending: exit %d", code)
	}
}

// `cell update` writes the watch's marker with the window it was given and
// says until when the new release has to connect; -rollback-window 0 writes
// none. The hello state is found under the cell's state dir even when the
// protocol check is skipped.
func TestTheCommandArmsTheWatch(t *testing.T) {
	s, root := newSigner(t), t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "keys.pub")
	_ = os.WriteFile(keyFile, []byte(releasesig.FormatPublicKey(s.keys[0].Key)), 0o644)
	stateDir := t.TempDir()
	base := []string{"-root", root, "-arch", "amd64", "-keys", keyFile, "-skip-preflight", "-skip-protocol-check", "-state-dir", stateDir}
	saved := runningCell
	t.Cleanup(func() { runningCell = saved })
	// The update runs from the installed release's own cell, as the
	// installer runs it ($OPT/current/bin/cell).
	runningCell = func() (string, error) {
		if p, err := filepath.EvalSymlinks(filepath.Join(root, "current", "bin", "cell")); err == nil {
			return p, nil
		}
		return "/first/install/cell", nil
	}
	var out, errOut bytes.Buffer
	if code := Run(append(base, "-from", s.release(t, "v1.0.0"), "-release", "v1.0.0"), &out, &errOut, nil); code != 0 {
		t.Fatalf("first: exit %d %s", code, errOut.String())
	}
	out.Reset()
	if code := Run(append(base, "-from", s.release(t, "v1.1.0"), "-release", "v1.1.0", "-rollback-window", "3m"), &out, &errOut, nil); code != 0 {
		t.Fatalf("second: exit %d %s", code, errOut.String())
	}
	p, ok, err := loadPending(root)
	if err != nil || !ok || p.Release != "v1.1.0" || p.HelloState != filepath.Join(stateDir, hubprotocol.StateName) || p.Deadline.Sub(p.SwappedAt) != 3*time.Minute {
		t.Fatalf("marker %+v %v %v", p, ok, err)
	}
	if !strings.Contains(out.String(), "3m0s") || !strings.Contains(out.String(), "v1.0.0") {
		t.Fatalf("stdout does not say the window and the release it returns to: %q", out.String())
	}
	helloAfter(t, p)

	// Run from any other binary, the release before (which runs the watch)
	// may not know update-watch: nothing is armed, and the update says so.
	runningCell = func() (string, error) { return "/usr/local/bin/cell", nil }
	errOut.Reset()
	if code := Run(append(base, "-from", s.release(t, "v1.2.0"), "-release", "v1.2.0"), &out, &errOut, nil); code != 0 || pendingExists(root) || !strings.Contains(errOut.String(), "not armed") {
		t.Fatalf("from another binary: exit %d, marker %v, stderr %q", code, pendingExists(root), errOut.String())
	}
	root2 := t.TempDir()
	base[1] = root2
	_ = Run(append(base, "-from", s.release(t, "v1.0.0"), "-release", "v1.0.0"), &out, &errOut, nil)
	if code := Run(append(base, "-from", s.release(t, "v1.1.0"), "-release", "v1.1.0", "-rollback-window", "0"), &out, &errOut, nil); code != 0 || pendingExists(root2) {
		t.Fatalf("-rollback-window 0: exit %d, marker %v", code, pendingExists(root2))
	}
}

func helloAfter(t *testing.T, p pending) {
	t.Helper()
	if err := hubprotocol.Save(p.HelloState, hubprotocol.State{Version: 1, At: p.SwappedAt.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
}

// With no cell config there is nothing to check the host against: cell
// update refuses, naming the flag, the variable and the explicit escape,
// and changes nothing; -skip-preflight installs and says so.
func TestAnUpdateWithoutTheCellsConfigIsRefused(t *testing.T) {
	t.Setenv("KODUS_CELL_CONFIG", "")
	s, root := newSigner(t), t.TempDir()
	keyFile := filepath.Join(t.TempDir(), "keys.pub")
	_ = os.WriteFile(keyFile, []byte(releasesig.FormatPublicKey(s.keys[0].Key)), 0o644)
	args := []string{"-root", root, "-from", s.release(t, "v1.0.0"), "-release", "v1.0.0", "-arch", "amd64", "-keys", keyFile, "-state-dir", t.TempDir()}
	var out, errOut bytes.Buffer
	code := Run(args, &out, &errOut, nil)
	if code != 2 {
		t.Fatalf("exit %d, want 2: %s", code, errOut.String())
	}
	for _, want := range []string{"-preflight-config", "KODUS_CELL_CONFIG", "-skip-preflight"} {
		if !strings.Contains(errOut.String(), want) {
			t.Fatalf("refusal %q lacks %q", errOut.String(), want)
		}
	}
	if st := stateOf(t, root); st != (state{}) {
		t.Fatalf("a refused update changed the host: %+v", st)
	}
	errOut.Reset()
	if code := Run(append(args, "-skip-preflight"), &out, &errOut, nil); code != 0 || !strings.Contains(errOut.String(), "-skip-preflight") || stateOf(t, root).current == "" {
		t.Fatalf("-skip-preflight: exit %d, stderr %q", code, errOut.String())
	}
	errOut.Reset()
	if code := Run([]string{"-root", root, "-from", s.release(t, "v1.0.0"), "-release", "v1.0.0", "-arch", "amd64", "-keys", keyFile, "-verify-only", "-skip-protocol-check"}, &out, &errOut, nil); code != 0 {
		t.Fatalf("-verify-only needs no config: exit %d %s", code, errOut.String())
	}
}

// A rollback never installs a release below the security floor: when the
// index the new release installed under raised its minimum above the
// release before (v1.1.0 fixes a cell escape), a missing hello keeps the
// new release, rolls nothing back, drops the marker so a fixed release can
// still be installed, and says why in one line.
func TestTheWatchNeverRollsBackBelowTheFloor(t *testing.T) {
	h := &host{s: newSigner(t), root: t.TempDir(), floor: "v1.1.0"}
	h.hello = filepath.Join(t.TempDir(), hubprotocol.StateName)
	first, err := Install(Options{Root: h.root, From: h.s.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: h.s.keys})
	if err != nil {
		t.Fatal(err)
	}
	h.first = first
	h.second = h.update(t, Options{})

	got, err := h.watch(t, swapAt.Add(11*time.Minute))
	if err != nil || got != HeldAtFloor {
		t.Fatalf("got %s %v, want %s", got, err, HeldAtFloor)
	}
	if st := stateOf(t, h.root); st.current != h.second || st.previous != h.first || h.restarts != 0 {
		t.Fatalf("the watch rolled back below the floor: %+v, %d restarts", st, h.restarts)
	}
	if pendingExists(h.root) {
		t.Fatal("the marker is left: the timer would keep looking and a fixed release would be refused")
	}
	if listed, _ := isRolledBack(h.root, h.second); listed {
		t.Fatal("a release kept at the floor is listed as rolled back")
	}
	line := strings.TrimSpace(h.out.String())
	for _, want := range []string{"v1.1.0", "v1.0.0", "below", "minimum", "kept"} {
		if !strings.Contains(line, want) {
			t.Fatalf("line %q lacks %q", line, want)
		}
	}
	// A fixed release installs after the hold, under an index that raises
	// the floor again; when it misses its hello too, the command says it
	// could not act: the timer's unit fails, visibly.
	h.floor = "v1.2.0"
	third, err := h.install(t, Options{Release: "v1.2.0", RollbackWindow: time.Nanosecond, Now: time.Now})
	if err != nil {
		t.Fatalf("a fixed release after the hold: %v", err)
	}
	var out, errOut bytes.Buffer
	if code := RunWatch([]string{"-root", h.root, "-systemctl", "", "-env-file", "", "-units-dir", ""}, &out, &errOut); code != 1 {
		t.Fatalf("held at the floor: exit %d, want 1: %s", code, out.String())
	}
	if st := stateOf(t, h.root); st.current != third {
		t.Fatalf("the command rolled back below the floor: %+v", st)
	}
}

// The floor only rises: a later index with a lower minimum does not lower
// what the watch refuses to go back to.
func TestTheFloorTheHostSawOnlyRises(t *testing.T) {
	h := &host{s: newSigner(t), root: t.TempDir(), floor: "v1.1.0"}
	h.hello = filepath.Join(t.TempDir(), hubprotocol.StateName)
	if _, err := Install(Options{Root: h.root, From: h.s.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: h.s.keys}); err != nil {
		t.Fatal(err)
	}
	h.update(t, Options{})
	h.helloAt(t, swapAt.Add(time.Minute))
	if got, err := h.watch(t, swapAt.Add(2*time.Minute)); err != nil || got != Kept {
		t.Fatalf("v1.1.0 connected: %s %v", got, err)
	}
	h.floor = "v1.0.0"
	h.update(t, Options{Release: "v1.2.0", Now: func() time.Time { return swapAt.Add(time.Hour) }})
	if s, err := loadIndexState(h.root); err != nil || s.Minimum != "v1.1.0" {
		t.Fatalf("the floor after an index with a lower minimum: %q %v", s.Minimum, err)
	}
	if got, err := h.watch(t, swapAt.Add(2*time.Hour)); err != nil || got != RolledBack {
		t.Fatalf("v1.1.0 is at the floor and may be returned to: %s %v", got, err)
	}
}

// A rollback never returns to a release signed with a key an index
// revoked after it was installed.
func TestTheWatchNeverRollsBackToAReleaseSignedWithARevokedKey(t *testing.T) {
	a, b := newSigner(t), newSigner(t)
	keys := append(append([]releasesig.PublicKey{}, a.keys...), b.keys...)
	h := &host{s: b, root: t.TempDir()}
	h.hello = filepath.Join(t.TempDir(), hubprotocol.StateName)
	first, err := Install(Options{Root: h.root, From: a.release(t, "v1.0.0"), Release: "v1.0.0", Arch: "amd64", Keys: keys})
	if err != nil {
		t.Fatal(err)
	}
	h.first = first
	from := b.release(t, "v1.1.0")
	b.index(t, from, releasesig.Index{Issued: time.Now().Add(-time.Second), Expires: time.Now().Add(24 * time.Hour), Latest: "v1.1.0", Minimum: "v1.0.0", RevokedKeys: []string{a.keys[0].ID}})
	h.second, err = Install(Options{Root: h.root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: keys, HelloState: h.hello, RollbackWindow: 10 * time.Minute, Now: func() time.Time { return swapAt }})
	if err != nil {
		t.Fatal(err)
	}
	got, err := h.watch(t, swapAt.Add(11*time.Minute))
	if err != nil || got != HeldAtFloor {
		t.Fatalf("got %s %v, want %s", got, err, HeldAtFloor)
	}
	if st := stateOf(t, h.root); st.current != h.second || h.restarts != 0 {
		t.Fatalf("the watch returned to a release signed with a revoked key: %+v", st)
	}
	if !strings.Contains(h.out.String(), "revoked") {
		t.Fatalf("line %q does not say the key is revoked", h.out.String())
	}
}

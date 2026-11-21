package cellupdate

// Automatic rollback. After `cell update` swaps current to a new release,
// the new cell has a window (Options.RollbackWindow, default 10 minutes) to
// complete one accepted hello with the hub. The health signal is the one
// the agent already writes after every accepted hello: hub-protocol.state
// (internal/hubprotocol), whose `at` must be after the swap. Until then the
// release is on probation; when the window passes without that hello,
// `cell update-watch` puts current back on the release before it, with the
// settings and units that release ran with, restarts the cell and says so
// in one line.
//
// Borrowed, and how it fits one host:
//   - systemd boot counting (systemd.io/AUTOMATIC_BOOT_ASSESSMENT): a new
//     entry is "indeterminate" until boot-complete.target blesses it, and the
//     boot loader, not the new entry, falls back to the one before. Here the
//     marker is the indeterminate state, the hello the blessing, and the
//     watch runs from the release before (/opt/kodus-cell/previous/bin/cell),
//     so a new binary that crashes at start cannot keep itself installed.
//   - Android A/B (source.android.com/docs/core/ota/ab) and ChromeOS
//     update_engine: the new slot is marked successful only after it booted
//     and passed its checks; a slot never marked falls back to the old one.
//     A slot marked successful is not rolled back, and neither is a release
//     that connected once after its swap.
//   - Teleport agent managed updates (goteleport.com/docs/reference/
//     architecture/agent-update-management): the updater watches the agent
//     after an update and returns it to the last working version when it
//     does not come back healthy, without anyone logging in to the machine.
//   - k3s system-upgrade-controller labels a node only after the upgrade job
//     succeeded and leaves recovery to the operator; the cell does better on
//     a single host because the release before is still on disk.
//
// Never a loop: a rolled-back release is listed in <root>/rolled-back.json
// and `cell update` refuses it unless -retry-rolled-back; the watch only
// ever moves current back, never forward. Never a network call: the watch
// reads two local files, swaps two links, copies local files and runs
// systemctl.

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubprotocol"
)

const (
	// PendingName is the watch's marker under the root: written by `cell
	// update` right before the swap, removed once the new release connected
	// or was rolled back. The watch's systemd unit runs only while it exists
	// (ConditionPathExists).
	PendingName = "update-pending.json"
	// RolledBackName lists the releases the watch rolled back, which `cell
	// update` refuses unless -retry-rolled-back.
	RolledBackName = "rolled-back.json"
	// DefaultRollbackWindow is how long a new release has to complete its
	// first accepted hello after the swap.
	DefaultRollbackWindow = 10 * time.Minute
)

// pending is the marker: the release on probation and the one to go back to.
type pending struct {
	Release string `json:"release"`
	// Dir is the release swapped to (current's target), Previous what
	// current pointed at before (previous's target after the swap).
	Dir      string `json:"dir"`
	Previous string `json:"previous"`
	// SwappedAt and Deadline bound the window; Window is said in the line.
	SwappedAt time.Time `json:"swappedAt"`
	Deadline  time.Time `json:"deadline"`
	// HelloState is the cell's hub-protocol.state: the health signal.
	HelloState string `json:"helloState"`
}

// rolledBack is one release the watch put back.
type rolledBack struct {
	Release  string    `json:"release"`
	Dir      string    `json:"dir"`
	Previous string    `json:"previous"`
	At       time.Time `json:"at"`
	Reason   string    `json:"reason"`
}

// Outcome is what one look of the watch did.
type Outcome string

const (
	// NothingPending: no update on probation.
	NothingPending Outcome = "none"
	// Waiting: inside the window, no hello yet; nothing changed.
	Waiting Outcome = "waiting"
	// Kept: the new release connected after the swap; the marker is gone.
	Kept Outcome = "kept"
	// RolledBack: current is back on the release before.
	RolledBack Outcome = "rolled-back"
	// HeldAtFloor: the window passed with no hello, but the release before
	// is below the security floor the host accepted (or signed with a key
	// since revoked): the new release stays current, the marker is dropped.
	HeldAtFloor Outcome = "held-at-floor"
	// Stale: current is neither release of the marker (the operator moved
	// it); the marker is dropped and nothing else changes.
	Stale Outcome = "stale"
)

// WatchOptions say where the host keeps what a rollback puts back.
type WatchOptions struct {
	// Root is the installer's directory (/opt/kodus-cell).
	Root string
	// Now is the clock; time.Now when nil.
	Now func() time.Time
	// EnvFile gets the release's own cell.env back (the installer keeps a
	// copy in each release directory); "" or no copy: not restored.
	EnvFile string
	// UnitsDir gets the release's own systemd/ units back; "" or none: not
	// restored.
	UnitsDir string
	// Restart runs the restored release (daemon-reload, restart the
	// target); nil: none.
	Restart func() error
	// Out gets the one line the watch says.
	Out io.Writer
}

// Watch looks once at the update on probation and keeps it, waits, or
// rolls it back.
func Watch(o WatchOptions) (Outcome, error) {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Out == nil {
		o.Out = io.Discard
	}
	p, ok, err := loadPending(o.Root)
	if err != nil || !ok {
		return NothingPending, err
	}
	cur, err := os.Readlink(filepath.Join(o.Root, "current"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return NothingPending, err
	}
	switch cur {
	case p.Dir:
	case p.Previous:
		// A rollback this watch started and did not finish (the restart
		// failed, or the host stopped): finish it, without swapping again.
		if listed, err := isRolledBack(o.Root, p.Dir); err != nil {
			return NothingPending, err
		} else if listed {
			return finishRollback(o, p, "finishing the rollback started before")
		}
		fallthrough
	default:
		if err := removePending(o.Root); err != nil {
			return NothingPending, err
		}
		say(o.Out, "release %s is no longer current (current is %s): the host was moved by hand; nothing rolled back", p.Release, orNone(cur))
		return Stale, nil
	}
	last, connected, err := helloSince(p)
	if err != nil {
		return NothingPending, err
	}
	if connected {
		if err := forgetRolledBack(o.Root, p.Dir); err != nil {
			return NothingPending, err
		}
		if err := removePending(o.Root); err != nil {
			return NothingPending, err
		}
		say(o.Out, "release %s completed an accepted hello with the hub at %s, %s after the swap: kept", p.Release, last.UTC().Format(time.RFC3339), last.Sub(p.SwappedAt).Round(time.Second))
		return Kept, nil
	}
	now := o.Now()
	if now.Before(p.Deadline) {
		say(o.Out, "release %s has until %s to complete an accepted hello with the hub, or the host returns to %s", p.Release, p.Deadline.UTC().Format(time.RFC3339), releaseNameOf(p.Previous))
		return Waiting, nil
	}
	seen := "never"
	if !last.IsZero() {
		seen = last.UTC().Format(time.RFC3339) + ", before the swap"
	}
	reason := fmt.Sprintf("no accepted hello with the hub within %s of the swap at %s (last accepted hello: %s)", p.Deadline.Sub(p.SwappedAt), p.SwappedAt.UTC().Format(time.RFC3339), seen)
	// Never below the security floor: a release the index raised the
	// minimum above, or signed with a key since revoked, is not returned to,
	// whatever blocked the hello (a hub outage, or an attacker on the path).
	// The new release stays; the marker goes, so a fixed release installs.
	st, err := loadIndexState(o.Root)
	if err != nil {
		return NothingPending, err
	}
	if why := belowFloor(st, releasePath(o.Root, p.Previous)); why != "" {
		if err := removePending(o.Root); err != nil {
			return NothingPending, err
		}
		say(o.Out, "release %s is kept, not rolled back: %s, but %s; fix what blocks the hello, or install a release at or above the minimum by hand", p.Release, reason, why)
		return HeldAtFloor, nil
	}
	// Remembered first: whatever stops the rollback after this, the release
	// is not taken again by itself.
	if err := addRolledBack(o.Root, rolledBack{Release: p.Release, Dir: p.Dir, Previous: p.Previous, At: now.UTC(), Reason: reason}); err != nil {
		return NothingPending, err
	}
	// previous first: a stop between the two renames leaves current on the
	// release on probation, with the marker, and the next look starts again.
	if err := relink(filepath.Join(o.Root, "previous"), p.Dir); err != nil {
		return NothingPending, err
	}
	if err := relink(filepath.Join(o.Root, "current"), p.Previous); err != nil {
		return NothingPending, err
	}
	return finishRollback(o, p, reason)
}

// finishRollback gives the release now current its settings and units
// back, restarts it and drops the marker; the line goes out last, once.
func finishRollback(o WatchOptions, p pending, reason string) (Outcome, error) {
	if err := relink(filepath.Join(o.Root, "previous"), p.Dir); err != nil {
		return NothingPending, err
	}
	prev := releasePath(o.Root, p.Previous)
	if o.EnvFile != "" {
		if err := copyIfThere(filepath.Join(prev, "cell.env"), o.EnvFile, 0o600); err != nil {
			return NothingPending, err
		}
	}
	if o.UnitsDir != "" {
		units, err := os.ReadDir(filepath.Join(prev, "systemd"))
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return NothingPending, err
		}
		for _, u := range units {
			if u.Type().IsRegular() {
				if err := copyIfThere(filepath.Join(prev, "systemd", u.Name()), filepath.Join(o.UnitsDir, u.Name()), 0o644); err != nil {
					return NothingPending, err
				}
			}
		}
	}
	if o.Restart != nil {
		if err := o.Restart(); err != nil {
			return NothingPending, fmt.Errorf("current is back on %s, but the restart failed (%w): the next look restarts it again", releaseNameOf(p.Previous), err)
		}
	}
	if err := removePending(o.Root); err != nil {
		return NothingPending, err
	}
	say(o.Out, "rolled back release %s (%s) to %s (%s): %s; `cell update` refuses %s until -retry-rolled-back", p.Release, filepath.Base(p.Dir), releaseNameOf(p.Previous), filepath.Base(p.Previous), reason, p.Release)
	return RolledBack, nil
}

// helloSince is the last accepted hello on record and whether it came
// after the swap. A state this cell cannot read (a newer release may add a
// field its strict decoder refuses) still was written by an agent after an
// accepted hello: its modification time stands for its `at`.
func helloSince(p pending) (time.Time, bool, error) {
	st, ok, err := hubprotocol.Load(p.HelloState)
	if err == nil {
		if !ok {
			return time.Time{}, false, nil
		}
		return st.At, st.At.After(p.SwappedAt), nil
	}
	fi, serr := os.Stat(p.HelloState)
	if serr != nil {
		return time.Time{}, false, err
	}
	return fi.ModTime(), fi.ModTime().After(p.SwappedAt), nil
}

// unconfirmed is the update on probation whose release is current and has
// not connected since its swap: another update would make it previous, the
// one the next rollback returns to.
func unconfirmed(root string) (pending, bool, error) {
	p, ok, err := loadPending(root)
	if err != nil || !ok {
		return pending{}, false, err
	}
	cur, _ := os.Readlink(filepath.Join(root, "current"))
	if cur != p.Dir {
		return pending{}, false, nil
	}
	_, connected, err := helloSince(p)
	if err != nil || connected {
		return pending{}, false, err
	}
	return p, true, nil
}

var releaseIDSuffix = regexp.MustCompile(`-[0-9a-f]{12}$`)

// releaseNameOf is the release a directory of the layout holds:
// releases/<release>-<id> (both cell update's and the installer's).
func releaseNameOf(dir string) string {
	if dir == "" {
		return "none"
	}
	return releaseIDSuffix.ReplaceAllString(filepath.Base(dir), "")
}

func releasePath(root, target string) string {
	if filepath.IsAbs(target) {
		return target
	}
	return filepath.Join(root, target)
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

func say(w io.Writer, format string, a ...any) {
	_, _ = fmt.Fprintf(w, "cell update-watch: "+format+"\n", a...)
}

func loadPending(root string) (pending, bool, error) {
	var p pending
	ok, err := readJSON(filepath.Join(root, PendingName), &p)
	if err != nil || !ok {
		return pending{}, false, err
	}
	if p.Dir == "" || p.Previous == "" || p.HelloState == "" || p.SwappedAt.IsZero() || p.Deadline.IsZero() {
		return pending{}, false, fmt.Errorf("%s: an incomplete marker; remove it knowingly", filepath.Join(root, PendingName))
	}
	return p, true, nil
}

func removePending(root string) error {
	err := os.Remove(filepath.Join(root, PendingName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func loadRolledBack(root string) ([]rolledBack, error) {
	var l []rolledBack
	_, err := readJSON(filepath.Join(root, RolledBackName), &l)
	return l, err
}

func isRolledBack(root, dir string) (bool, error) {
	l, err := loadRolledBack(root)
	if err != nil {
		return false, err
	}
	return slices.ContainsFunc(l, func(r rolledBack) bool { return filepath.Base(r.Dir) == filepath.Base(dir) }), nil
}

// rolledBackEntry is the record of the release in dir, if listed.
func rolledBackEntry(root, dir string) (rolledBack, bool, error) {
	l, err := loadRolledBack(root)
	if err != nil {
		return rolledBack{}, false, err
	}
	for _, r := range l {
		if filepath.Base(r.Dir) == filepath.Base(dir) {
			return r, true, nil
		}
	}
	return rolledBack{}, false, nil
}

func addRolledBack(root string, r rolledBack) error {
	l, err := loadRolledBack(root)
	if err != nil {
		return err
	}
	l = slices.DeleteFunc(l, func(o rolledBack) bool { return filepath.Base(o.Dir) == filepath.Base(r.Dir) })
	return writeJSON(filepath.Join(root, RolledBackName), append(l, r))
}

func forgetRolledBack(root, dir string) error {
	l, err := loadRolledBack(root)
	if err != nil {
		return err
	}
	kept := slices.DeleteFunc(slices.Clone(l), func(o rolledBack) bool { return filepath.Base(o.Dir) == filepath.Base(dir) })
	if len(kept) == len(l) {
		return nil
	}
	return writeJSON(filepath.Join(root, RolledBackName), kept)
}

// readJSON reads path into v; no file is ok false. A file that does not
// read is an error naming it, never taken for none: an empty rolled-back
// list would retry a release that failed.
func readJSON(path string, v any) (bool, error) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: the installer's directory
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, fmt.Errorf("%s does not read (%w): restore it or remove it knowingly", path, err)
	}
	return true, nil
}

// writeJSON writes v to path atomically (fsync, rename), 0644: release
// names, paths and times, no secret.
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp-" + strconv.Itoa(os.Getpid())
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644) //nolint:gosec // G302,G304: public release metadata in the installer's directory
	if err != nil {
		return err
	}
	if _, err := f.Write(append(b, '\n')); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

// copyIfThere copies src over dst (through a temporary file renamed over
// it) when src exists.
func copyIfThere(src, dst string, perm os.FileMode) error {
	b, err := os.ReadFile(src) //nolint:gosec // G304: a release directory of the installer's layout
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil { //nolint:gosec // G301: /etc/kodus/cell, /etc/systemd/system
		return err
	}
	tmp := dst + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(tmp, b, perm); err != nil { //nolint:gosec // G703: beside dst, a path of the installer's own layout
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// RunWatch is `cell update-watch`, run every minute by the host's
// kodus-cell-update-watch.timer from the release before the update
// (/opt/kodus-cell/previous/bin/cell) while the marker exists: exit 0
// whatever it decided, 1 when it could not act, 2 usage.
func RunWatch(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("update-watch", flag.ContinueOnError)
	fs.SetOutput(stderr)
	root := fs.String("root", "/opt/kodus-cell", "the installer's directory: releases/, current, previous, "+PendingName)
	envFile := fs.String("env-file", "/etc/kodus/cell/cell.env", "where a rolled-back-to release's own cell.env goes back (empty: not restored)")
	unitsDir := fs.String("units-dir", "/etc/systemd/system", "where a rolled-back-to release's own systemd/ units go back (empty: not restored)")
	systemctl := fs.String("systemctl", "systemctl", "the systemctl that reloads the units and restarts -restart-unit after a rollback (empty: no restart)")
	unit := fs.String("restart-unit", "kodus-cell.target", "what a rollback restarts")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	o := WatchOptions{Root: *root, EnvFile: *envFile, UnitsDir: *unitsDir, Out: stdout}
	if *systemctl != "" {
		o.Restart = func() error {
			for _, a := range [][]string{{"daemon-reload"}, {"restart", *unit}} {
				cmd := exec.CommandContext(context.Background(), *systemctl, a...) //nolint:gosec // G204: the operator's systemctl and unit
				cmd.Stdout, cmd.Stderr = stderr, stderr
				if err := cmd.Run(); err != nil {
					return fmt.Errorf("%s %s: %w", *systemctl, strings.Join(a, " "), err)
				}
			}
			return nil
		}
	}
	got, err := Watch(o)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cell update-watch:", err)
		return 1
	}
	if got == HeldAtFloor {
		// It could not act: the unit fails, so the hold is seen.
		return 1
	}
	return 0
}

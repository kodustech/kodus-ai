// Package cellupdate installs a cell release on a host only once its
// signature verifies offline against a pinned key (S-17 (a),
// docs/runtime/isolation-p3-snapshots.md), and swaps to it so that the
// release before stays one rollback away.
//
// The layout is the installer's (kodus-installer
// scripts/runtime/cell-host.sh):
//
//	<root>/releases/<release>-<id>/bin/<command>
//	<root>/current   -> the release the units run
//	<root>/previous  -> the one before, for `cell-host.sh rollback`
//	<root>/update-pending.json  the release on probation (watch.go)
//	<root>/rolled-back.json     what the watch rolled back, refused again
//
// It is run by the release already installed, not by the one it installs:
// a binary never vouches for itself. Nothing in <root> changes until every
// file was copied and matched the signed manifest; a refusal names the file.
// A release lower than the installed one is refused unless the operator says
// -allow-downgrade (order.go): a signature binds a release to its name, so an
// older, vulnerable release verifies as well as the newest. Before the swap,
// the staged release's own `cell preflight` checks the host with the cell's
// config (preflight.go): a host the new release would refuse keeps the one
// it runs. After the swap the new release has a window to complete an
// accepted hello with the hub, or `cell update-watch`, run by the release
// before, puts that one back (watch.go).
package cellupdate

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubprotocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version"
)

// Required are the commands a release must hold for the host's units.
var Required = []string{"cell", "egress", "injector", "observer", "reaper"}

// Options say what to install where.
type Options struct {
	// Root is the installer's directory (/opt/kodus-cell).
	Root string
	// From holds the release's files as the release workflow publishes
	// them: SHA256SUMS, SHA256SUMS.sig and <command>-linux-<arch>.
	From string
	// Release is the release asked for; the signature must name it.
	Release string
	// Arch is the host's (runtime.GOARCH when empty).
	Arch string
	// Keys are the pinned release keys.
	Keys []releasesig.PublicKey
	// VerifyOnly checks the release and installs nothing.
	VerifyOnly bool
	// Installed is the version of the cell that installs (the release the
	// host runs). Release is refused when it is lower (order.go), unless
	// AllowDowngrade. Empty or not semver (a local build): nothing is refused.
	Installed string
	// AllowDowngrade installs a release lower than Installed: the operator's
	// explicit choice, never a default.
	AllowDowngrade bool
	// Index is the directory of the signed release index (RELEASE-INDEX and
	// its signature, index.go); From when empty. A release installs only
	// under a current index that allows it.
	Index string
	// Now is the clock the index's expiry is read against; time.Now when nil.
	Now func() time.Time
	// Preflight checks this host with the staged release's cell (its path),
	// after every file matched and before the swap; an error refuses the
	// swap. Nil: no check. Not run with VerifyOnly.
	Preflight func(cell string) error
	// HubState is the cell's hub-protocol.state (internal/hubprotocol): what
	// the hub said at the cell's last accepted hello. A release that hub
	// would refuse is refused (protocol.go). Empty, or no file: not checked.
	HubState string
	// SkipProtocolCheck installs without checking the release's protocol
	// against HubState: the operator's explicit choice.
	SkipProtocolCheck bool
	// RequireProtocol refuses a release that does not say which protocol it
	// speaks (no PROTOCOL in its SHA256SUMS); otherwise it installs unchecked.
	RequireProtocol bool
	// Notes gets what the update could not check and why; nil discards it.
	Notes io.Writer
	// RollbackWindow is how long the new release has, after the swap, to
	// complete an accepted hello with the hub before `cell update-watch`
	// returns the host to the release before (watch.go). Zero: no watch.
	RollbackWindow time.Duration
	// HelloState is the cell's hub-protocol.state, which its agent writes
	// after every accepted hello: the watch's health signal. Required with
	// a RollbackWindow.
	HelloState string
	// RetryRolledBack installs a release the watch rolled back on this
	// host: the operator's explicit choice, never a default.
	RetryRolledBack bool
	// Updater is the cell binary running the update, symlinks resolved.
	// When set, the watch is armed only if it is the installed release's
	// own: the watch runs previous/bin/cell, which must know update-watch.
	Updater string
}

// Install verifies the release in o.From and makes it current, keeping the
// current one as previous. It returns the release's directory; with
// VerifyOnly, an empty one.
func Install(o Options) (string, error) {
	if o.Arch == "" {
		o.Arch = runtime.GOARCH
	}
	if o.Index == "" {
		o.Index = o.From
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.RollbackWindow > 0 && o.HelloState == "" && !o.VerifyOnly {
		return "", errors.New("a rollback window needs the cell's " + hubprotocol.StateName + " to watch the new release's hello in")
	}
	seen, err := loadIndexState(o.Root)
	if err != nil {
		return "", err
	}
	ix, err := releasesig.VerifyIndex(o.Index, o.Keys, seen.RevokedKeys, o.Now())
	if err != nil {
		return "", err
	}
	if ix.Issued.Before(seen.Issued) {
		return "", refuseOrder("the release index was issued %s, before the one this host already saw (%s): an old index is refused", ix.Issued.Format(time.RFC3339), seen.Issued.Format(time.RFC3339))
	}
	revoked := union(seen.RevokedKeys, ix.RevokedKeys)
	manifest, keyID, err := releasesig.VerifySigned(o.From, o.Release, unrevoked(o.Keys, revoked))
	if err != nil {
		return "", err
	}
	if slices.Contains(revoked, keyID) {
		return "", refuseOrder("release %s is signed with key %s, which is revoked", o.Release, keyID)
	}
	if err := allowedByIndex(o.Release, ix); err != nil {
		return "", err
	}
	files, err := commandsOf(manifest, o.Arch, filepath.Join(o.From, releasesig.ManifestName))
	if err != nil {
		return "", err
	}
	// Before anything changes: a release the hub would refuse never becomes current.
	if err := checkProtocol(o, manifest, o.Notes); err != nil {
		return "", err
	}
	if o.VerifyOnly {
		for _, c := range sortedKeys(files) {
			if err := releasesig.CheckFile(filepath.Join(o.From, files[c].name), files[c].sha); err != nil {
				return "", err
			}
		}
		return "", nil
	}
	// After Verify: the name being ordered is the one the key signed.
	if err := checkOrder(o.Installed, o.Release, o.AllowDowngrade); err != nil {
		return "", err
	}
	releases := filepath.Join(o.Root, "releases")
	dest := filepath.Join(releases, strings.ReplaceAll(o.Release, "/", "_")+"-"+files["cell"].sha[:12])
	if err := checkProbation(o, dest); err != nil {
		return "", err
	}
	// What this host saw only grows: written before the swap, so a release
	// that verified under this index never makes the host forget a revocation.
	// The floor and the key of this release too: the watch reads them
	// before it returns the host to the release before (watch.go).
	keys := maps.Clone(seen.ReleaseKeys)
	if keys == nil {
		keys = map[string]string{}
	}
	keys[filepath.Base(dest)] = keyID
	if err := saveIndexState(o.Root, indexState{Issued: maxTime(seen.Issued, ix.Issued), RevokedKeys: revoked, Minimum: higherFloor(seen.Minimum, ix.Minimum), ReleaseKeys: keys}); err != nil {
		return "", err
	}
	if err := os.MkdirAll(releases, 0o755); err != nil { //nolint:gosec // G301: binaries the units run, read by their users
		return "", err
	}
	if err := stage(dest, releases, o.From, files); err != nil {
		return "", err
	}
	if o.Preflight != nil {
		// The new release judges the host: its requirements may be new.
		if err := o.Preflight(filepath.Join(dest, "bin", "cell")); err != nil {
			return "", fmt.Errorf("the host preflight of %s failed (%w): the installed release stays current, and %s is kept for the next try", o.Release, err, dest)
		}
	}
	if err := armWatch(o, dest); err != nil {
		return "", err
	}
	return dest, swap(o.Root, dest)
}

// checkProbation refuses, before anything changes, a release the watch
// rolled back on this host (unless RetryRolledBack), and any other release
// while the one current has not connected since its swap: the update would
// make an unproven release the one a rollback returns to.
func checkProbation(o Options, dest string) error {
	if !o.RetryRolledBack {
		r, listed, err := rolledBackEntry(o.Root, dest)
		if err != nil {
			return err
		}
		if listed {
			return refuseOrder("release %s (%s) was rolled back on this host at %s: %s; -retry-rolled-back installs it again", o.Release, filepath.Base(dest), r.At.UTC().Format(time.RFC3339), r.Reason)
		}
	}
	p, waiting, err := unconfirmed(o.Root)
	if err != nil {
		return err
	}
	if waiting && p.Dir != dest {
		return refuseOrder("release %s, swapped in at %s, has not completed an accepted hello with the hub yet: wait for it (until %s, after which the host returns to %s by itself), or roll back by hand first", p.Release, p.SwappedAt.UTC().Format(time.RFC3339), p.Deadline.UTC().Format(time.RFC3339), releaseNameOf(p.Previous))
	}
	return nil
}

// armWatch writes the watch's marker right before the swap, when there is
// a release to return to: a stop after it and before the swap leaves a
// marker whose release is not current, which the watch drops.
func armWatch(o Options, dest string) error {
	cur, err := os.Readlink(filepath.Join(o.Root, "current"))
	if errors.Is(err, os.ErrNotExist) || cur == dest {
		return nil
	}
	if err != nil {
		return err
	}
	// The marker of the update before this one is done with: its release
	// connected (checkProbation refuses otherwise) and is about to be previous.
	if err := removePending(o.Root); err != nil {
		return err
	}
	if o.RollbackWindow <= 0 {
		return nil
	}
	if o.Updater != "" {
		installed, err := filepath.EvalSymlinks(releasePath(o.Root, cur))
		if err != nil || !strings.HasPrefix(o.Updater, installed+string(filepath.Separator)) {
			note(o.Notes, "the automatic rollback is not armed: this cell update runs from %s, not from the installed release %s, whose cell would run the watch; run it as %s", o.Updater, cur, filepath.Join(cur, "bin", "cell"))
			return nil
		}
	}
	now := o.Now().UTC()
	return writeJSON(filepath.Join(o.Root, PendingName), pending{
		Release: o.Release, Dir: dest, Previous: cur, SwappedAt: now, Deadline: now.Add(o.RollbackWindow), HelloState: o.HelloState,
	})
}

type signedFile struct{ name, sha string }

// commandsOf picks the host's architecture's files of the manifest, by
// command: cell-linux-amd64 is cell on amd64.
func commandsOf(manifest map[string]string, arch, manifestPath string) (map[string]signedFile, error) {
	suffix := "-linux-" + arch
	out := map[string]signedFile{}
	for name, sha := range manifest {
		if c, ok := strings.CutSuffix(name, suffix); ok && c != "" {
			out[c] = signedFile{name, sha}
		}
	}
	for _, c := range Required {
		if _, ok := out[c]; !ok {
			return nil, &releasesig.Error{File: manifestPath, Reason: fmt.Sprintf("lists no %s%s", c, suffix)}
		}
	}
	return out, nil
}

// stage puts the release's commands in dest. A dest already there (the
// same release installed before) is taken only when every command still
// matches the signed manifest.
func stage(dest, releases, from string, files map[string]signedFile) error {
	if _, err := os.Stat(dest); err == nil {
		for _, c := range sortedKeys(files) {
			if err := releasesig.CheckFile(filepath.Join(dest, "bin", c), files[c].sha); err != nil {
				return err
			}
		}
		return nil
	}
	tmp, err := os.MkdirTemp(releases, ".staging-")
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			_ = os.RemoveAll(tmp)
		}
	}()
	if err := os.Chmod(tmp, 0o755); err != nil { //nolint:gosec // G302: the release directory the units read
		return err
	}
	bin := filepath.Join(tmp, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil { //nolint:gosec // G301: binaries the units run
		return err
	}
	for _, c := range sortedKeys(files) {
		if err := releasesig.CopyChecked(filepath.Join(from, files[c].name), filepath.Join(bin, c), files[c].sha, 0o755); err != nil {
			return err
		}
	}
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	ok = true
	return nil
}

// swap points previous at what current was, then current at dest, each
// with an atomic rename: a stop between the two leaves current on the old
// release and a rollback that changes nothing.
func swap(root, dest string) error {
	current := filepath.Join(root, "current")
	cur, err := os.Readlink(current)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if cur == dest {
		return nil
	}
	if cur != "" {
		if err := relink(filepath.Join(root, "previous"), cur); err != nil {
			return err
		}
	}
	return relink(current, dest)
}

func relink(link, target string) error {
	tmp := link + ".tmp-" + strconv.Itoa(os.Getpid())
	_ = os.Remove(tmp)
	if err := os.Symlink(target, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, link); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// Run is `cell update`: exit 0 installed (or verified), 1 refused, 2 usage.
// stateDirOf is the cell's -state-dir under its config file ("" for none),
// as the cell itself resolves it (cmd/cell): where the agent keeps
// hub-protocol.state.
func Run(args []string, stdout, stderr io.Writer, stateDirOf func(config string) (string, error)) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	root := fs.String("root", "/opt/kodus-cell", "the installer's directory: releases/, current, previous")
	from := fs.String("from", "", "the release's files: SHA256SUMS, SHA256SUMS.sig, <command>-linux-<arch>")
	release := fs.String("release", "", "the release asked for; its signature must name it")
	keysFile := fs.String("keys", "", "the pinned release keys (the installer's copy); default: the keys compiled into this cell")
	arch := fs.String("arch", runtime.GOARCH, "the host's architecture")
	verifyOnly := fs.Bool("verify-only", false, "check the signature and every file, install nothing")
	indexDir := fs.String("index", "", "the directory of the signed release index (RELEASE-INDEX, RELEASE-INDEX.sig); default: -from")
	allowDowngrade := fs.Bool("allow-downgrade", false, "install a release older than the one running this command (a dev build over a release included)")
	preflightConfig := fs.String("preflight-config", os.Getenv("KODUS_CELL_CONFIG"), "the cell's -config file: before the swap the staged release runs `cell preflight -config` with it, and a failed check keeps the installed release (default $KODUS_CELL_CONFIG)")
	skipPreflight := fs.Bool("skip-preflight", false, "swap without the staged release's host preflight")
	stateDir := fs.String("state-dir", "", "the cell's -state-dir, where its agent keeps "+hubprotocol.StateName+" (what the hub accepted at the last hello); default: the one -preflight-config gives the cell")
	skipProtocol := fs.Bool("skip-protocol-check", false, "install without checking the release's protocol against what the hub last accepted")
	requireProtocol := fs.Bool("require-protocol", false, "refuse a release that does not say which protocol it speaks (no "+releasesig.ProtocolName+" in its "+releasesig.ManifestName+")")
	window := fs.Duration("rollback-window", DefaultRollbackWindow, "how long the new release has, after the swap, to complete an accepted hello with the hub before kodus-cell-update-watch.timer (`cell update-watch`) returns the host to the release before; 0: no watch")
	retryRolledBack := fs.Bool("retry-rolled-back", false, "install a release this host rolled back by itself ("+RolledBackName+")")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *from == "" || *release == "" {
		_, _ = fmt.Fprintln(stderr, "cell update: -from and -release are required")
		return 2
	}
	// The host preflight is not optional by omission: an update with no
	// config to judge the host by is refused, and skipping it is said.
	if !*verifyOnly && !*skipPreflight && *preflightConfig == "" {
		_, _ = fmt.Fprintln(stderr, "cell update: refused: no -preflight-config and no $KODUS_CELL_CONFIG, so the staged release's host preflight cannot run: give the cell's -config file with -preflight-config (or set KODUS_CELL_CONFIG), or pass -skip-preflight to install without it")
		return 2
	}
	if *window < 0 {
		_, _ = fmt.Fprintln(stderr, "cell update: -rollback-window must not be negative")
		return 2
	}
	keys, err := loadKeys(*keysFile)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cell update:", err)
		return 1
	}
	o := Options{Root: *root, From: *from, Release: *release, Arch: *arch, Keys: keys, VerifyOnly: *verifyOnly, Installed: installedVersion(), AllowDowngrade: *allowDowngrade, Index: *indexDir,
		SkipProtocolCheck: *skipProtocol, RequireProtocol: *requireProtocol, Notes: stderr, RetryRolledBack: *retryRolledBack}
	watch := *window > 0 && !*verifyOnly
	if !*skipProtocol || watch {
		dir := *stateDir
		if dir == "" && stateDirOf != nil {
			if dir, err = stateDirOf(*preflightConfig); err != nil {
				_, _ = fmt.Fprintf(stderr, "cell update: the cell's state dir under config %q: %v; give -state-dir (or -skip-protocol-check with -rollback-window 0)\n", *preflightConfig, err)
				return 1
			}
		}
		if dir != "" {
			if !*skipProtocol {
				o.HubState = filepath.Join(dir, hubprotocol.StateName)
			}
			if watch {
				o.HelloState, o.RollbackWindow = filepath.Join(dir, hubprotocol.StateName), *window
				if o.Updater, err = runningCell(); err != nil {
					_, _ = fmt.Fprintln(stderr, "cell update: which binary runs this update:", err)
					return 1
				}
			}
		} else if watch {
			_, _ = fmt.Fprintln(stderr, "cell update: no state dir to watch the new release's first hello in: give -state-dir, or -rollback-window 0")
			return 2
		}
	}
	switch {
	case *verifyOnly:
	case *skipPreflight:
		_, _ = fmt.Fprintln(stderr, "cell update: note: -skip-preflight: the staged release's host preflight does not run")
	default:
		o.Preflight = StagedPreflight(*preflightConfig, stdout, stderr)
	}
	dest, err := Install(o)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cell update:", err)
		return 1
	}
	if *verifyOnly {
		_, _ = fmt.Fprintf(stdout, "release %s verified\n", *release)
		return 0
	}
	_, _ = fmt.Fprintf(stdout, "release %s installed at %s; restart kodus-cell.target to run it\n", *release, dest)
	if p, ok, err := loadPending(*root); err == nil && ok && p.Dir == dest {
		_, _ = fmt.Fprintf(stdout, "release %s has %s (until %s) to complete an accepted hello with the hub; otherwise kodus-cell-update-watch.timer returns this host to %s by itself\n",
			*release, p.Deadline.Sub(p.SwappedAt), p.Deadline.Format(time.RFC3339), releaseNameOf(p.Previous))
	}
	return 0
}

// runningCell is the binary running `cell update`, symlinks resolved.
var runningCell = func() (string, error) {
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(p)
}

// installedVersion is the release running `cell update`: the installed one.
var installedVersion = func() string { return version.Version }

func loadKeys(file string) ([]releasesig.PublicKey, error) {
	if file == "" {
		return releasesig.Pinned()
	}
	b, err := os.ReadFile(file) //nolint:gosec // G304: the key file the installer names
	if err != nil {
		return nil, err
	}
	return releasesig.ParsePublicKeys(b)
}

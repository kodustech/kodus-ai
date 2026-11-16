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
//
// It is run by the release already installed, not by the one it installs:
// a binary never vouches for itself. Nothing in <root> changes until every
// file was copied and matched the signed manifest; a refusal names the file.
// A release lower than the installed one is refused unless the operator says
// -allow-downgrade (order.go): a signature binds a release to its name, so an
// older, vulnerable release verifies as well as the newest.
package cellupdate

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"time"

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
	// What this host saw only grows: written before the swap, so a release
	// that verified under this index never makes the host forget a revocation.
	if err := saveIndexState(o.Root, indexState{Issued: maxTime(seen.Issued, ix.Issued), RevokedKeys: revoked}); err != nil {
		return "", err
	}
	releases := filepath.Join(o.Root, "releases")
	if err := os.MkdirAll(releases, 0o755); err != nil { //nolint:gosec // G301: binaries the units run, read by their users
		return "", err
	}
	dest := filepath.Join(releases, strings.ReplaceAll(o.Release, "/", "_")+"-"+files["cell"].sha[:12])
	if err := stage(dest, releases, o.From, files); err != nil {
		return "", err
	}
	return dest, swap(o.Root, dest)
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
func Run(args []string, stdout, stderr io.Writer) int {
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
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *from == "" || *release == "" {
		_, _ = fmt.Fprintln(stderr, "cell update: -from and -release are required")
		return 2
	}
	keys, err := loadKeys(*keysFile)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cell update:", err)
		return 1
	}
	dest, err := Install(Options{Root: *root, From: *from, Release: *release, Arch: *arch, Keys: keys, VerifyOnly: *verifyOnly, Installed: installedVersion(), AllowDowngrade: *allowDowngrade, Index: *indexDir})
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "cell update:", err)
		return 1
	}
	if *verifyOnly {
		_, _ = fmt.Fprintf(stdout, "release %s verified\n", *release)
	} else {
		_, _ = fmt.Fprintf(stdout, "release %s installed at %s; restart kodus-cell.target to run it\n", *release, dest)
	}
	return 0
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

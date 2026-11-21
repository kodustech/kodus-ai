package cellupdate

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/releasesig"
)

func refusedUnchanged(t *testing.T, root string, err error, want string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("got %v, want a refusal saying %q", err, want)
	}
	if st := stateOf(t, root); st.current != "" || st.releases != "" {
		t.Fatalf("a refused update changed the host: %+v", st)
	}
}

// A release installs only under a signed, current index: without one, or
// under an expired one (a frozen mirror), nothing changes on the host.
func TestAReleaseInstallsOnlyUnderACurrentSignedIndex(t *testing.T) {
	s := newSigner(t)
	root := t.TempDir()
	from := s.release(t, "v1.0.0")
	_ = os.Remove(filepath.Join(from, releasesig.IndexName))
	_, err := Install(Options{Root: root, From: from, Release: "v1.0.0", Arch: "amd64", Keys: s.keys})
	refusedUnchanged(t, root, err, "release index")

	from = s.release(t, "v1.0.0")
	_, err = Install(Options{Root: root, From: from, Release: "v1.0.0", Arch: "amd64", Keys: s.keys, Now: func() time.Time { return time.Now().Add(31 * 24 * time.Hour) }})
	refusedUnchanged(t, root, err, "expired")
}

// The index bounds what may install: nothing newer than its latest, nothing
// below its minimum, not even with -allow-downgrade.
func TestTheIndexBoundsTheRelease(t *testing.T) {
	s := newSigner(t)
	ix := func(latest, minimum string) releasesig.Index {
		return releasesig.Index{Issued: time.Now().Add(-time.Minute), Expires: time.Now().Add(24 * time.Hour), Latest: latest, Minimum: minimum}
	}
	for _, tc := range []struct {
		name, release string
		index         releasesig.Index
		allow         bool
		want          string
	}{
		{"newer than latest", "v1.5.0", ix("v1.4.0", "v1.0.0"), false, "newer than the release index's latest"},
		{"below minimum", "v1.1.0", ix("v1.4.0", "v1.2.0"), false, "below the release index's minimum"},
		{"below minimum, downgrade allowed", "v1.1.0", ix("v1.4.0", "v1.2.0"), true, "below the release index's minimum"},
		{"a dev build the index does not name", "v0.0.0-dev+0123456789ab", ix("nightly", "v0.0.0"), true, "not the release index's latest"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			from := s.release(t, tc.release)
			s.index(t, from, tc.index)
			_, err := Install(Options{Root: root, From: from, Release: tc.release, Arch: "amd64", Keys: s.keys, AllowDowngrade: tc.allow})
			refusedUnchanged(t, root, err, tc.want)
		})
	}
	root := t.TempDir()
	from := s.release(t, "v1.3.0")
	s.index(t, from, ix("v1.4.0", "v1.2.0"))
	if _, err := Install(Options{Root: root, From: from, Release: "v1.3.0", Arch: "amd64", Keys: s.keys}); err != nil {
		t.Fatalf("a release inside the index's bounds: %v", err)
	}
}

// Key compromise: once an index signed by another pinned key revokes key A,
// this host refuses releases signed by A and any index signed by A, even a
// later one that leaves A out; and an index older than one it saw is refused.
func TestARevokedKeyStaysRevokedAndAnOldIndexIsRefused(t *testing.T) {
	a, b := newSigner(t), newSigner(t)
	keys := append(append([]releasesig.PublicKey{}, a.keys...), b.keys...)
	root := t.TempDir()
	now := time.Now()

	// b's index revokes a; the release itself is signed by b and installs.
	from := b.release(t, "v1.1.0")
	b.index(t, from, releasesig.Index{Issued: now.Add(-time.Minute), Expires: now.Add(24 * time.Hour), Latest: "v1.1.0", Minimum: "v1.0.0", RevokedKeys: []string{a.keys[0].ID}})
	if _, err := Install(Options{Root: root, From: from, Release: "v1.1.0", Arch: "amd64", Keys: keys}); err != nil {
		t.Fatal(err)
	}
	installed := stateOf(t, root)

	// The thief's release, signed by a, with a's own later index that revokes nothing.
	evil := a.release(t, "v1.2.0")
	a.index(t, evil, releasesig.Index{Issued: now, Expires: now.Add(24 * time.Hour), Latest: "v1.2.0", Minimum: "v1.0.0"})
	_, err := Install(Options{Root: root, From: evil, Release: "v1.2.0", Arch: "amd64", Keys: keys})
	if err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("an index signed by a revoked key: %v", err)
	}
	// A release signed by a under b's current index is refused too.
	evil2 := a.release(t, "v1.1.0")
	b.index(t, evil2, releasesig.Index{Issued: now, Expires: now.Add(24 * time.Hour), Latest: "v1.1.0", Minimum: "v1.0.0"})
	if _, err := Install(Options{Root: root, From: evil2, Release: "v1.1.0", Arch: "amd64", Keys: keys}); err == nil {
		t.Fatal("a release signed by a revoked key installed")
	}
	// An index of b older than the one this host saw is refused.
	old := b.release(t, "v1.1.0")
	b.index(t, old, releasesig.Index{Issued: now.Add(-time.Hour), Expires: now.Add(24 * time.Hour), Latest: "v1.1.0", Minimum: "v1.0.0"})
	if _, err := Install(Options{Root: root, From: old, Release: "v1.1.0", Arch: "amd64", Keys: keys}); err == nil || !strings.Contains(err.Error(), "an old index is refused") {
		t.Fatalf("an older index: %v", err)
	}
	if st := stateOf(t, root); st != installed {
		t.Fatalf("a refused update changed the host: %+v, was %+v", st, installed)
	}
	// A state the host cannot read is never taken as empty.
	_ = os.WriteFile(filepath.Join(root, IndexStateName), []byte("{"), 0o644)
	if _, err := Install(Options{Root: root, From: b.release(t, "v1.1.0"), Release: "v1.1.0", Arch: "amd64", Keys: keys}); err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Fatalf("an unreadable state: %v", err)
	}
}

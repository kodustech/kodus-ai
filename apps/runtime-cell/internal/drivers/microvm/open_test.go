package microvm

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/firecracker"
)

type countingRunner struct{ n int }

func (r *countingRunner) Run(context.Context, []byte, string, ...string) ([]byte, error) {
	r.n++
	return nil, nil
}

// A cell asked for firecracker on a host without KVM, without a kit that
// matches its pinned digest, or without the host's prerequisites refuses
// to start, naming each, and touches nothing of the host's network first.
func TestACellAskedForFirecrackerOnAHostThatCannotRunItRefusesNamingWhy(t *testing.T) {
	r := &countingRunner{}
	_, err := Open(context.Background(), Firecracker{
		CellID: "cell-1", KitDir: t.TempDir(), KitDigest: "sha256:" + strings.Repeat("0", 64), StateDir: t.TempDir(),
		Host: isolation.Host{KVM: false, Arch: "x86_64"}, Runner: r,
		Checks: &firecracker.Checks{
			EUID: func() int { return 0 }, LookPath: func(b string) (string, error) { return "/usr/sbin/" + b, nil },
			Stat:     func(string) (os.FileInfo, error) { return nil, fs.ErrNotExist },
			ReadFile: func(string) ([]byte, error) { return []byte("cpu memory pids"), nil },
			Reflink:  func(string, string) error { return nil }, Chown: func(string, int, int) error { return nil },
		},
	})
	var u *isolation.UnavailableError
	if !errors.As(err, &u) || u.Backend != isolation.Firecracker {
		t.Fatalf("err %v", err)
	}
	for _, want := range []string{"/dev/kvm", "the microVM kit: kit: " + "manifest.json", "/dev/net/tun"} {
		if !strings.Contains(u.Reason, want) {
			t.Errorf("the refusal does not name %q: %s", want, u.Reason)
		}
	}
	if r.n != 0 {
		t.Fatalf("%d host network commands ran on a host that was refused", r.n)
	}
}

// cell preflight reads what Open would refuse, the same lines, without
// opening the host's network.
func TestPrerequisitesAreWhatOpenRefusesWith(t *testing.T) {
	r := &countingRunner{}
	f := Firecracker{
		CellID: "cell-1", KitDir: t.TempDir(), KitDigest: "sha256:" + strings.Repeat("0", 64), StateDir: t.TempDir(),
		Host: isolation.Host{KVM: false, Arch: "x86_64"}, Runner: r,
		Checks: &firecracker.Checks{
			EUID: func() int { return 1000 }, LookPath: func(b string) (string, error) { return "/usr/sbin/" + b, nil },
			Stat:     func(string) (os.FileInfo, error) { return nil, fs.ErrNotExist },
			ReadFile: func(string) ([]byte, error) { return []byte("cpu memory pids"), nil },
			Reflink:  func(string, string) error { return nil }, Chown: func(string, int, int) error { return nil },
		},
	}
	missing := Prerequisites(f)
	_, err := Open(context.Background(), f)
	var u *isolation.UnavailableError
	if !errors.As(err, &u) || len(missing) < 3 || u.Reason != strings.Join(missing, "; ") {
		t.Fatalf("prerequisites %q, open %v", missing, err)
	}
	if r.n != 0 {
		t.Fatalf("%d host network commands ran", r.n)
	}
}

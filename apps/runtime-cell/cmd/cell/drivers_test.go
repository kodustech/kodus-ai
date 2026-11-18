package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/localdocker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// startOn is the start-up checks of a cell given args, on a host where
// -isolation-backend auto picks autoBackend. It returns the driver the cell
// would run.
func startOn(t *testing.T, autoBackend string, args ...string) (string, error) {
	t.Helper()
	st, err := parse(t, args...)
	if err != nil {
		return "", err
	}
	sel, _, err := selectDriver(&st, testHost(autoBackend), func(string) string { return "" })
	return sel.Kind, err
}

// testHost is a host whose -isolation-backend auto picks autoBackend.
func testHost(autoBackend string) hostFacts {
	return hostFacts{ChooseBackend: func(requested string, kit bool) (isolation.Choice, error) {
		if requested == isolation.Auto {
			return isolation.Choice{Backend: autoBackend, Why: "the test host"}, nil
		}
		return isolation.Choose(requested, isolation.Host{}, isolation.MicroVMReadiness{Kit: kit})
	}}
}

var claimLimitArgs = []string{"-gvisor-claim-limits", "required", "-gvisor-claim-cgroup-root", "/sys/fs/cgroup/kodus", "-gvisor-holder-image", "holder@sha256:1111111111111111111111111111111111111111111111111111111111111111", "-observer", "http", "-gvisor-observer-image", "observer@sha256:2222222222222222222222222222222222222222222222222222222222222222"}

// -driver auto on a host is docker-gvisor, so it takes docker-gvisor's
// claim limits. It used to be refused: the flags were checked against
// "auto" before auto was resolved.
func TestDriverAutoTakesGVisorClaimLimitsWhenItResolvesToDockerGVisor(t *testing.T) {
	kind, err := startOn(t, isolation.GVisor, append([]string{"-driver", "auto"}, claimLimitArgs...)...)
	if err != nil || kind != dockergvisor.Kind {
		t.Fatalf("%s %v", kind, err)
	}
}

// docker-gvisor on the firecracker backend runs the microvm driver, which
// builds no claim-limits manager: -gvisor-claim-limits required is refused,
// naming the flag and the driver. It used to start, and the limits were a
// silent no-op.
func TestGVisorClaimLimitsWithTheFirecrackerBackendAreRefused(t *testing.T) {
	for name, autoBackend := range map[string]string{"asked for": "", "picked by auto": isolation.Firecracker} {
		args := append([]string{"-driver", "docker-gvisor"}, claimLimitArgs...)
		if autoBackend == "" {
			args = append(args, "-isolation-backend", "firecracker")
		}
		_, err := startOn(t, autoBackend, args...)
		if err == nil || !strings.Contains(err.Error(), "-gvisor-claim-limits") || !strings.Contains(err.Error(), microvm.Kind) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Every gvisor flag is refused on the firecracker backend by name, and a
// value from the config file counts as set: the file cannot slip a flag past.
func TestEveryGVisorFlagIsRefusedOnTheFirecrackerBackend(t *testing.T) {
	for _, args := range [][]string{
		{"-gvisor-mem-limit", "8g"}, {"-gvisor-io-limits"}, {"-gvisor-sandbox-image", "s@sha256:3333333333333333333333333333333333333333333333333333333333333333"}, {"-browser-explore"},
	} {
		all := append([]string{"-driver", "docker-gvisor", "-isolation-backend", "firecracker", "-observer", "http"}, args...)
		if _, err := startOn(t, "", all...); err == nil || !strings.Contains(err.Error(), args[0]) {
			t.Errorf("%v: %v", args, err)
		}
	}
	p := filepath.Join(t.TempDir(), "cell.yaml")
	if err := os.WriteFile(p, []byte("driver: docker-gvisor\nclaimLimits: \"off\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startOn(t, "", "-config", p, "-isolation-backend", "firecracker", "-observer", "http"); err == nil || !strings.Contains(err.Error(), "-gvisor-claim-limits") {
		t.Errorf("from the file: %v", err)
	}
}

// A driver's flag is refused on another driver even at its default value,
// and a flag several drivers read is taken by each of them.
func TestAFlagIsTakenOnlyByTheDriversThatReadIt(t *testing.T) {
	if _, err := startOn(t, "", "-driver", "fake", "-dev", "-gvisor-claim-limits", "off"); err == nil || !strings.Contains(err.Error(), "docker-gvisor") {
		t.Errorf("a gvisor flag on fake: %v", err)
	}
	if _, err := startOn(t, "", "-driver", "fake", "-dev", "-sandbox-pool", "1"); err != nil {
		t.Errorf("-sandbox-pool on fake: %v", err)
	}
	if _, err := startOn(t, "", "-driver", "fake", "-dev", "-sandbox-memory-mb", "1024"); err == nil {
		t.Error("-sandbox-memory-mb on fake, which sizes no sandbox by it")
	}
	// -isolation-backend auto reads the kit to choose: a cell that gave it
	// and fell back to gVisor still starts.
	if kind, err := startOn(t, isolation.GVisor, "-driver", "docker-gvisor", "-gvisor-holder-image", "h@sha256:1111111111111111111111111111111111111111111111111111111111111111", "-observer", "http", "-gvisor-observer-image", "o@sha256:2222222222222222222222222222222222222222222222222222222222222222",
		"-firecracker-kit", "/kit", "-firecracker-kit-digest", "sha256:k"); err != nil || kind != dockergvisor.Kind {
		t.Errorf("a kit on auto that chose gvisor: %s %v", kind, err)
	}
	if _, err := startOn(t, "", "-driver", "docker-gvisor", "-isolation-backend", "gvisor", "-gvisor-holder-image", "h@sha256:1111111111111111111111111111111111111111111111111111111111111111", "-observer", "http", "-gvisor-observer-image", "o@sha256:2222222222222222222222222222222222222222222222222222222222222222",
		"-firecracker-kit", "/kit"); err == nil {
		t.Error("a kit on a cell that asked for gvisor")
	}
}

// Every driver package's kind has a registry entry that opens it.
func TestEveryDriverKindHasARegistryEntry(t *testing.T) {
	kinds := []string{dockergvisor.Kind, microvm.Kind, localdocker.Kind, fake.Kind}
	for _, k := range kinds {
		if e, ok := drivers[k]; !ok || e.Open == nil {
			t.Errorf("%s has no entry", k)
		}
	}
	if len(drivers) != len(kinds) {
		t.Errorf("drivers has %d entries, %d kinds", len(drivers), len(kinds))
	}
}

// Every driver-specific flag has owners, each a driver in the registry, and
// every entry of the ownership table names a flag the cell registers: a
// driver's flag is one whose name is of a driver family or whose help
// starts with a driver's name ("docker-gvisor: ...").
func TestEveryDriverFlagIsOwned(t *testing.T) {
	var s settings
	fs := flag.NewFlagSet("cell", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	s.register(fs)
	fs.VisitAll(func(f *flag.Flag) {
		family := false
		for _, p := range []string{"gvisor-", "firecracker-", "sandbox-"} {
			family = family || strings.HasPrefix(f.Name, p)
		}
		for _, p := range []string{"docker-gvisor:", "docker-gvisor and", "firecracker:", "firecracker and"} {
			family = family || strings.HasPrefix(f.Usage, p)
		}
		o, ok := ownerOf(f.Name)
		if family && !ok {
			t.Errorf("-%s has no owner", f.Name)
		}
		for _, d := range o.Drivers {
			if _, ok := drivers[d]; !ok {
				t.Errorf("-%s: owner %s is not a driver", f.Name, d)
			}
		}
	})
	for _, o := range flagOwners {
		if strings.HasSuffix(o.Name, "-") {
			continue
		}
		if fs.Lookup(o.Name) == nil {
			t.Errorf("flagOwners names -%s, which the cell does not register", o.Name)
		}
	}
}

// Every image the cell runs in a claim is pinned (S1-SUP-02): a tag can be
// moved upstream or in a mirror, and the observer mounts the observer's
// mTLS key. Outside -dev a tag on any image flag is refused, naming the
// flag; a digest (repo@sha256:...) or a local image id (sha256:...) runs.
func TestEveryClaimImageIsPinnedOutsideDev(t *testing.T) {
	pin := "@sha256:" + strings.Repeat("a", 64)
	base := []string{"-driver", "docker-gvisor", "-isolation-backend", "gvisor", "-gvisor-holder-image", "h" + pin, "-observer", "http", "-gvisor-observer-image", "o" + pin}
	if _, err := startOn(t, "", base...); err != nil {
		t.Fatalf("pinned images: %v", err)
	}
	for _, flag := range []string{"-gvisor-holder-image", "-gvisor-observer-image", "-gvisor-sandbox-image", "-gvisor-builder-image", "-gvisor-registry-image", "-gvisor-browser-image"} {
		_, err := startOn(t, "", append(base, flag, "alpine:3.20")...)
		if err == nil || !strings.Contains(err.Error(), flag) || !strings.Contains(err.Error(), "digest") {
			t.Fatalf("%s by tag: %v", flag, err)
		}
		if _, err := startOn(t, "", append(base, flag, "sha256:"+strings.Repeat("a", 64))...); err != nil {
			t.Fatalf("%s by image id: %v", flag, err)
		}
		// N11: a malformed pin passed the gate and failed at docker run.
		for _, bad := range []string{"s@sha256:z", "s@sha256:" + strings.Repeat("A", 64), "@sha256:" + strings.Repeat("a", 64), "s@sha256:" + strings.Repeat("a", 63), "sha256:abc"} {
			if _, err := startOn(t, "", append(base, flag, bad)...); err == nil || !strings.Contains(err.Error(), flag) {
				t.Fatalf("%s %q: %v", flag, bad, err)
			}
		}
	}
	if _, err := startOn(t, "", append(base, "-dev", "-gvisor-holder-image", "alpine:3.20")...); err != nil {
		t.Fatalf("a tag under -dev: %v", err)
	}
}

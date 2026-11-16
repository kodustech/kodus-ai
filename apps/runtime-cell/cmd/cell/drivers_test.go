package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/awsec2"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/k8ssandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/localdocker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// startOn is the start-up checks of a cell given args, on a host where
// -driver auto finds a pod (inCluster) or not, and -isolation-backend auto
// picks autoBackend. It returns the driver the cell would run.
func startOn(t *testing.T, inCluster bool, autoBackend string, args ...string) (string, error) {
	t.Helper()
	st, err := parse(t, args...)
	if err != nil {
		return "", err
	}
	sel, _, err := selectDriver(&st, testHost(inCluster, autoBackend), func(string) string { return "" })
	return sel.Kind, err
}

// testHost is a host whose -isolation-backend auto picks autoBackend.
func testHost(inCluster bool, autoBackend string) hostFacts {
	return hostFacts{InCluster: inCluster, ChooseBackend: func(requested string, kit bool) (isolation.Choice, error) {
		if requested == isolation.Auto {
			return isolation.Choice{Backend: autoBackend, Why: "the test host"}, nil
		}
		return isolation.Choose(requested, isolation.Host{}, isolation.MicroVMReadiness{Kit: kit})
	}}
}

var claimLimitArgs = []string{"-gvisor-claim-limits", "required", "-gvisor-claim-cgroup-root", "/sys/fs/cgroup/kodus", "-gvisor-holder-image", "holder@sha256:x", "-observer", "http", "-gvisor-observer-image", "observer@sha256:y"}

// -driver auto on a host is docker-gvisor, so it takes docker-gvisor's
// claim limits. It used to be refused: the flags were checked against
// "auto" before auto was resolved.
func TestDriverAutoTakesGVisorClaimLimitsWhenItResolvesToDockerGVisor(t *testing.T) {
	kind, err := startOn(t, false, isolation.GVisor, append([]string{"-driver", "auto"}, claimLimitArgs...)...)
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
		_, err := startOn(t, false, autoBackend, args...)
		if err == nil || !strings.Contains(err.Error(), "-gvisor-claim-limits") || !strings.Contains(err.Error(), microvm.Kind) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Every gvisor flag is refused on the firecracker backend by name, and a
// value from the config file counts as set: the file cannot slip a flag past.
func TestEveryGVisorFlagIsRefusedOnTheFirecrackerBackend(t *testing.T) {
	for _, args := range [][]string{
		{"-gvisor-mem-limit", "8g"}, {"-gvisor-io-limits"}, {"-gvisor-sandbox-image", "s@sha256:z"}, {"-browser-explore"},
	} {
		all := append([]string{"-driver", "docker-gvisor", "-isolation-backend", "firecracker", "-observer", "http"}, args...)
		if _, err := startOn(t, false, "", all...); err == nil || !strings.Contains(err.Error(), args[0]) {
			t.Errorf("%v: %v", args, err)
		}
	}
	p := filepath.Join(t.TempDir(), "cell.yaml")
	if err := os.WriteFile(p, []byte("driver: docker-gvisor\nclaimLimits: \"off\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startOn(t, false, "", "-config", p, "-isolation-backend", "firecracker", "-observer", "http"); err == nil || !strings.Contains(err.Error(), "-gvisor-claim-limits") {
		t.Errorf("from the file: %v", err)
	}
}

// A driver's flag is refused on another driver even at its default value,
// and a flag several drivers read is taken by each of them.
func TestAFlagIsTakenOnlyByTheDriversThatReadIt(t *testing.T) {
	if _, err := startOn(t, true, "", append(k8sArgs("-k8s-max-cpus", "4"), "-gvisor-claim-limits", "off")...); err == nil || !strings.Contains(err.Error(), "k8s-sandbox") {
		t.Errorf("a gvisor flag on k8s-sandbox: %v", err)
	}
	if _, err := startOn(t, false, "", "-driver", "fake", "-dev", "-k8s-namespace", "ns"); err == nil {
		t.Error("a k8s flag on fake")
	}
	if _, err := startOn(t, false, "", k8sArgs("-sandbox-pool", "2", "-sandbox-memory-mb", "1024")...); err != nil {
		t.Errorf("sandbox flags on k8s-sandbox: %v", err)
	}
	if _, err := startOn(t, false, "", "-driver", "fake", "-dev", "-sandbox-pool", "1"); err != nil {
		t.Errorf("-sandbox-pool on fake: %v", err)
	}
	if _, err := startOn(t, false, "", "-driver", "fake", "-dev", "-sandbox-memory-mb", "1024"); err == nil {
		t.Error("-sandbox-memory-mb on fake, which sizes no sandbox by it")
	}
	// -isolation-backend auto reads the kit to choose: a cell that gave it
	// and fell back to gVisor still starts.
	if kind, err := startOn(t, false, isolation.GVisor, "-driver", "docker-gvisor", "-gvisor-holder-image", "h@sha256:x", "-observer", "http", "-gvisor-observer-image", "o@sha256:y",
		"-firecracker-kit", "/kit", "-firecracker-kit-digest", "sha256:k"); err != nil || kind != dockergvisor.Kind {
		t.Errorf("a kit on auto that chose gvisor: %s %v", kind, err)
	}
	if _, err := startOn(t, false, "", "-driver", "docker-gvisor", "-isolation-backend", "gvisor", "-gvisor-holder-image", "h@sha256:x", "-observer", "http", "-gvisor-observer-image", "o@sha256:y",
		"-firecracker-kit", "/kit"); err == nil {
		t.Error("a kit on a cell that asked for gvisor")
	}
}

// Every driver package's kind has a registry entry that opens it.
func TestEveryDriverKindHasARegistryEntry(t *testing.T) {
	kinds := []string{awsec2.Kind, dockergvisor.Kind, microvm.Kind, k8ssandbox.Kind, localdocker.Kind, fake.Kind}
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
		for _, p := range []string{"gvisor-", "firecracker-", "k8s-", "sandbox-"} {
			family = family || strings.HasPrefix(f.Name, p)
		}
		for _, p := range []string{"docker-gvisor:", "docker-gvisor and", "firecracker:", "firecracker and", "k8s-sandbox:", "aws-ec2 driver"} {
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

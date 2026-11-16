//go:build linux

package gvisoregress

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/test/conformance"
)

// The backend conformance suite (test/conformance) on the gvisor backend:
// sandbox machines of the tool image under runsc, on claim networks the
// cell's egress joins. Opt-in, on a Linux Docker with runsc that reaches the
// internet, with the tool image built (docker buildx bake runtime-sandbox):
//
//	KODY_E2E_GVISOR=1 KODY_E2E_SANDBOX_IMAGE=<tool image> go test -run TestGVisorKeepsTheConformanceBehaviours -v ./test/gvisoregress/
func TestGVisorKeepsTheConformanceBehaviours(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	image := os.Getenv("KODY_E2E_SANDBOX_IMAGE")
	if image == "" {
		t.Skip("KODY_E2E_SANDBOX_IMAGE names the sandbox tool image (docker buildx bake runtime-sandbox)")
	}
	dir := t.TempDir()
	// The cell's injector in this process on the default bridge's gateway,
	// where the egress container reaches it: credential hosts go there.
	gateway := docker(t, "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}")
	injectorAddr := net.JoinHostPort(gateway, "18444")
	l, err := new(net.ListenConfig).Listen(context.Background(), "tcp4", injectorAddr)
	if err != nil {
		t.Fatal(err)
	}
	e := startEgress(t, dir, "kodus-egress-conf", "-injector-addr", injectorAddr)
	secrets := conformance.StartInjector(t, l, []string{ipOn(t, e.name, "bridge")}, e.push.Push, secretHost, notSecretHost)
	// Each sandbox's network is bounded low enough that the host's link is
	// never what bounds a noisy one (the neighbour behaviour).
	limits := driver.IOLimits{NetMbps: 50}
	d, err := dockergvisor.New(context.Background(), dockercli.CLI{}, dockergvisor.Config{
		IOLimits: &limits,
		CellID:   "cell-conf", HolderImage: "alpine:3.20", SandboxImage: image,
		WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name,
		MemLimit: "1g", CPUs: "1", MemMax: "2g", CPUsMax: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !d.SandboxesEnabled() {
		t.Fatal("the driver runs no sandboxes")
	}
	work := filepath.Join(dir, "cell")
	reap, err := dockergvisor.NewForReaper(dockercli.CLI{}, dockergvisor.ReaperConfig{CellID: "cell-conf", WorkDir: work, EgressContainer: e.name})
	if err != nil {
		t.Fatal(err)
	}
	conformance.Run(t, conformance.Target{
		Reaper: reap, ReaperOrphans: reap, Orphan: gvisorOrphan(work), Limits: &limits, DownloadURL: "https://" + allowed + "/alpine/v3.20/releases/x86_64/alpine-standard-3.20.3-x86_64.iso",
		Name: "gvisor", CellID: "cell-conf", Driver: d, Parts: d.Parts(), Boundary: true,
		Egress: pushedEgress{e}, AllowedHost: allowed, DeniedHost: "example.com",
		Secrets: secrets, SecretHost: secretHost, NotSecretHost: notSecretHost,
		Leftovers: dockerLeftovers, MachineMemory: containerMemory,
		// Memory snapshots are the microVM backend's (P3); gVisor keeps none.
		MaySkip: conformance.SnapshotBehaviours,
	})
}

// The secret's host and another credential host: real names the egress
// resolves; the injector answers both from a local server.
const (
	secretHost    = "example.org"
	notSecretHost = "example.net"
)

// containerMemory reads the sandbox container's cgroup, where runsc puts
// the sandbox (its sentry and gofer) under the container's memory limit.
func containerMemory(t *testing.T, ref driver.MachineRef) (int, int) {
	t.Helper()
	out, err := exec.Command("docker", "inspect", "-f", "{{.State.Pid}}", ref.MachineID).CombinedOutput()
	if err != nil {
		t.Fatalf("docker inspect %s: %v\n%s", ref.MachineID, err, out)
	}
	raw, err := os.ReadFile("/proc/" + strings.TrimSpace(string(out)) + "/cgroup")
	if err != nil {
		t.Fatal(err)
	}
	// cgroup v2: one line, "0::<path>".
	_, path, ok := strings.Cut(strings.TrimSpace(string(raw)), "::")
	if !ok {
		t.Fatalf("the container's cgroup reads %q", raw)
	}
	return conformance.CgroupMemory(t, "/sys/fs/cgroup"+filepath.Clean(path))
}

// pushedEgress pushes a claim's allow-list to the running egress, as the
// agent does after claim.ready.
type pushedEgress struct{ e egress }

func (p pushedEgress) Allow(ctx context.Context, claimID, orgID string, n driver.ClaimNetwork, sources, hosts []string) error {
	return p.e.push.Push(ctx, policy.ClaimPolicy{
		ClaimID: claimID, OrgID: orgID, Phase: policy.PhaseTest, Sources: sources, Allow: hosts,
		SteerTo: n.EgressAddress, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	})
}

// dockerLeftovers is what this Docker still holds of a machine: its
// container and its project's volumes.
func dockerLeftovers(t *testing.T, machineID string) []string {
	t.Helper()
	var left []string
	for _, args := range [][]string{
		{"ps", "-a", "--filter", "name=^/" + machineID + "$", "--format", "container {{.Names}}"},
		{"volume", "ls", "--filter", "label=com.docker.compose.project=" + machineID, "--format", "volume {{.Name}}"},
	} {
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if line != "" {
				left = append(left, line)
			}
		}
	}
	return left
}

// gvisorOrphan is a machine a cell died in the middle of destroying: its
// containers gone, its build directories (older than the orphan pass's
// grace) not.
func gvisorOrphan(work string) func(t *testing.T, ref driver.MachineRef) func() []string {
	return func(t *testing.T, ref driver.MachineRef) func() []string {
		t.Helper()
		dir := filepath.Join(work, "builds", ref.MachineID)
		if err := os.MkdirAll(filepath.Join(dir, "app"), 0o700); err != nil {
			t.Fatal(err)
		}
		old := time.Now().Add(-time.Hour)
		if err := os.Chtimes(dir, old, old); err != nil {
			t.Fatal(err)
		}
		if out, err := exec.Command("docker", "rm", "-f", ref.MachineID).CombinedOutput(); err != nil {
			t.Fatalf("docker rm: %v %s", err, out)
		}
		return func() []string {
			if _, err := os.Stat(dir); err == nil {
				return []string{dir}
			}
			return nil
		}
	}
}

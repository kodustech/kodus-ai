package dockergvisor

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

type call struct {
	args  []string
	stdin []byte
}

// recorder answers docker commands by their first words.
type recorder struct {
	calls   []call
	answers map[string]string // "ps", "inspect", "info", "run", "compose config", "network ls", "network inspect"
}

func (r *recorder) run(_ context.Context, stdin []byte, _ string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, call{args: args, stdin: stdin})
	key := args[0]
	if args[0] == "compose" || args[0] == "network" {
		for _, a := range args[1:] {
			if a == "config" || a == "ls" || a == "inspect" || (args[0] == "compose" && (a == "ps" || a == "logs")) {
				key = args[0] + " " + a
			}
		}
	}
	if strings.Contains(strings.Join(args, " "), ".IPAM.Config") {
		key = "network subnet"
	}
	if out, ok := r.answers[key]; ok {
		return []byte(out), nil
	}
	return nil, nil
}

func (r *recorder) find(prefix ...string) []string {
	for _, c := range r.calls {
		if len(c.args) >= len(prefix) && strings.Join(c.args[:len(prefix)], " ") == strings.Join(prefix, " ") {
			return c.args
		}
	}
	return nil
}

func (r *recorder) has(word string) bool {
	for _, c := range r.calls {
		if strings.Contains(strings.Join(c.args, " "), word) {
			return true
		}
	}
	return false
}

const holderJSON = `[{"Id":"c0ffee","Name":"/kodus-claim-1-workload","Config":{"Image":"h","Labels":{"kodus.cell":"cell-1","kodus.machine":"kodus-claim-1-workload","kodus.claim":"claim-1","kodus.hard-expires":"2026-10-29T13:00:00Z","kodus.expires":"2026-10-29T12:05:00Z"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.5"}}}}]`

func newDriver(t *testing.T, runtimes string) (*Driver, *recorder, error) {
	t.Helper()
	r := &recorder{answers: map[string]string{"info": runtimes, "run": "c0ffee\n", "inspect": holderJSON, "network subnet": "10.213.5.0/24 \n"}}
	d, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir()})
	return d, r, err
}

// S-10: without gVisor the cell does not start.
func TestRefusesDockerWithoutRunsc(t *testing.T) {
	if _, _, err := newDriver(t, `{"runc":{},"io.containerd.runc.v2":{}}`); !errors.Is(err, ErrNoIsolatedRuntime) {
		t.Fatalf("err %v", err)
	}
}

func spec() driver.MachineSpec {
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	return driver.MachineSpec{CellID: "cell-1", EnvironmentID: "env", Role: driver.RoleWorkload, OrgID: "org-a", ClaimID: "claim-1",
		ImageID: "img-1", ClaimGroupID: "kodus-claim-1", KMSKeyRef: "local", ExpiresAt: now.Add(5 * time.Minute), HardExpiresAt: now.Add(time.Hour)}
}

func TestHolderRunsUnderGVisorWithClaimLabels(t *testing.T) {
	d, r, err := newDriver(t, `{"runc":{},"runsc":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	if d.Capabilities().Isolation != driver.IsolationSandboxedContainer {
		t.Fatal("isolation")
	}
	net, err := d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-1"})
	if err != nil {
		t.Fatal(err)
	}
	nc := strings.Join(r.find("network", "create"), " ")
	for _, want := range []string{"--internal", "--ipv6=false", "com.docker.network.bridge.inhibit_ipv4=true"} {
		if !strings.Contains(nc, want) || !strings.HasSuffix(nc, net.WorkloadGroupID) {
			t.Fatalf("network lacks %q: %s", want, nc)
		}
	}
	ref, err := d.Create(context.Background(), spec())
	if err != nil {
		t.Fatal(err)
	}
	run := strings.Join(r.find("run"), " ")
	for _, want := range []string{"--runtime runsc", "--network kodus-claim-1", "--cap-drop ALL", "no-new-privileges:true", "--read-only", "--pids-limit", "kodus.hard-expires=2026-10-29T13:00:00Z", "kodus.org=org-a", "kodus.machine=kodus-claim-1-workload", "kodus/holder@sha256:abc sleep infinity"} {
		if !strings.Contains(run, want) {
			t.Fatalf("holder run lacks %q: %s", want, run)
		}
	}
	if ref.PrivateAddress != "172.30.0.5" || ref.DriverRef != "c0ffee" {
		t.Fatalf("ref %+v", ref)
	}
}

func TestCreateRefusesAnotherClaimsNetworkAndBadIDs(t *testing.T) {
	d, _, _ := newDriver(t, `{"runsc":{}}`)
	s := spec()
	s.ClaimGroupID = "kodus-victim"
	if _, err := d.Create(context.Background(), s); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("joined another claim's network: %v", err)
	}
	s = spec()
	s.ClaimID = "../../x"
	if _, err := d.Create(context.Background(), s); err == nil {
		t.Fatal("bad claim id accepted")
	}
}

func canonicalFor(dir string) string {
	return `{"services":{"a":{"image":"x","runtime":"runsc","security_opt":["no-new-privileges:true"],"networks":{"kodus-claim":{"ipv4_address":"10.213.5.10","mac_address":"02:42:0a:d5:05:0a"}},"extra_hosts":["a=10.213.5.10"],
"labels":{"kodus.cell":"cell-1","kodus.org":"","kodus.claim":"claim-1","kodus.role":"","kodus.hard-expires":"2026-10-29T13:00:00Z"}}},
"networks":{"kodus-claim":{"name":"kodus-claim-1","external":true}}}`
}

func TestUpRefusesBeforeAnyContainerStarts(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, _ := d.Create(context.Background(), spec())
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	_, err := d.Up(context.Background(), ref, []byte("services:\n  a:\n    image: x\n    privileged: true\n"), t.TempDir())
	var re *sandbox.RefusedError
	if !errors.As(err, &re) {
		t.Fatalf("err %v", err)
	}
	if r.find("compose") != nil {
		t.Fatal("compose ran after a refusal")
	}
	dir := t.TempDir()
	r.answers["compose config"] = canonicalFor(dir)
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/kodus-claim-1-workload-a-1","Config":{"Labels":{"kodus.cell":"cell-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.9"}}}}]`
	sources, err := d.Up(context.Background(), ref, []byte("services:\n  a:\n    image: x\n"), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 1 || sources[0] != "172.30.0.9" {
		t.Fatalf("sources %v", sources)
	}
	// The boot's phases reach claim.ready.timing (BootTimer).
	if tm, ok := d.BootTiming(ref.Tags[driver.TagClaim]); !ok || tm.Kind != "boot" || tm.TotalMs < tm.UpMs || tm.TotalMs < tm.BuildMs {
		t.Fatalf("boot timing %+v %v", tm, ok)
	}
	var up string
	for _, c := range r.calls {
		if j := strings.Join(c.args, " "); strings.Contains(j, " up ") {
			up = j
		}
	}
	if !strings.Contains(up, "--env-file "+os.DevNull) || !strings.Contains(up, "up -d --no-build --wait") {
		t.Fatalf("compose up: %s", up)
	}
	// The rewritten file is the cell's, outside the checkout.
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatalf("wrote into the checkout: %v", entries)
	}
	if f := r.find("compose", "-p", "kodus-claim-1-workload", "--project-directory"); f == nil || strings.HasPrefix(f[5], dir) {
		t.Fatalf("compose file inside the checkout: %v", f)
	}

	// Everything the driver learnt of the machine goes with it: a later
	// claim that takes its name starts from nothing of this one's.
	if _, err := d.Targets(ref.MachineID, nil); err != nil {
		t.Fatalf("the boot left no services: %v", err)
	}
	if err := d.Destroy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if _, ok := d.BootTiming(ref.Tags[driver.TagClaim]); ok {
		t.Fatal("the boot timing outlived the machine")
	}
	if _, err := d.Targets(ref.MachineID, nil); err == nil {
		t.Fatal("the services outlived the machine")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.machines) != 0 {
		t.Fatalf("machine state left after Destroy: %v", d.machines)
	}
}

// The second reader: compose's own canonical output contradicts what the
// allowlist approved (it would run on runc). Nothing starts.
func TestUpRefusesWhatComposeWouldReallyRun(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, _ := d.Create(context.Background(), spec())
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	dir := t.TempDir()
	r.answers["compose config"] = strings.Replace(canonicalFor(dir), `"runtime":"runsc"`, `"runtime":"runc"`, 1)
	_, err := d.Up(context.Background(), ref, []byte("services:\n  a:\n    image: x\n"), dir)
	var re *sandbox.RefusedError
	if !errors.As(err, &re) {
		t.Fatalf("err %v", err)
	}
	for _, c := range r.calls {
		if strings.Contains(strings.Join(c.args, " "), " up ") {
			t.Fatal("compose up ran")
		}
	}
}

func TestExpiryLivesInStateAndCeilingInLabels(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	ref, _ := d.Create(context.Background(), spec())
	r.answers["ps"] = "c0ffee\n"
	if err := d.SetExpiry(context.Background(), ref, time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	refs, err := d.List(context.Background(), map[string]string{driver.TagCell: "cell-1"})
	if err != nil || len(refs) != 1 {
		t.Fatalf("%v %v", refs, err)
	}
	if refs[0].Tags[driver.TagExpires] != "2026-10-29T13:00:00Z" || refs[0].PrivateAddress != "172.30.0.5" {
		t.Fatalf("expires not capped by the label ceiling, or no address: %+v", refs[0])
	}
	if !r.has("label=kodus.machine") {
		t.Fatal("List does not select holders only")
	}
	if err := d.Destroy(context.Background(), refs[0]); err != nil {
		t.Fatal(err)
	}
	if r.find("compose", "-p", "kodus-claim-1-workload", "down") == nil || r.find("rm", "-f", "kodus-claim-1-workload") == nil {
		t.Fatal("destroy did not remove project and holder")
	}
}

// A machine id that names another cell's containers is not destroyed.
func TestDestroyRefusesAnotherCellsMachine(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	r.answers["ps"] = "beef\n"
	r.answers["inspect"] = `[{"Id":"beef","Name":"/kodus-claim-1-workload","Config":{"Labels":{"kodus.cell":"cell-2"}}}]`
	err := d.Destroy(context.Background(), driver.MachineRef{MachineID: "kodus-claim-1-workload"})
	if !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("err %v", err)
	}
	if r.find("rm") != nil || r.find("compose") != nil {
		t.Fatal("touched another cell's containers")
	}
}

func TestReleaseClaimRemovesOnlyThisCellsNetwork(t *testing.T) {
	d, r, _ := newDriver(t, `{"runsc":{}}`)
	r.answers["network ls"] = "n1\n"
	r.answers["network inspect"] = `{"kodus.cell":"cell-2"}`
	if err := d.ReleaseClaim(context.Background(), driver.ClaimNetwork{WorkloadGroupID: "kodus-claim-1"}); !errors.Is(err, driver.ErrNotOwned) {
		t.Fatalf("err %v", err)
	}
	r.answers["network inspect"] = `{"kodus.cell":"cell-1"}`
	if err := d.ReleaseClaim(context.Background(), driver.ClaimNetwork{WorkloadGroupID: "kodus-claim-1"}); err != nil || r.find("network", "rm") == nil {
		t.Fatalf("own network not removed: %v", err)
	}
}

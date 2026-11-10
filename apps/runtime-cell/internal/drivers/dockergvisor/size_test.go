package dockergvisor

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

func TestParseMemMB(t *testing.T) {
	for in, want := range map[string]int{"4g": 4096, "12G": 12288, "512m": 512, "16GiB": 16384, "1.5g": 1536, "2048mb": 2048, "1t": 1 << 20} {
		if got, err := parseMemMB(in); err != nil || got != want {
			t.Errorf("parseMemMB(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "g", "-1g", "4x", "4 gigs", "100k"} {
		if _, err := parseMemMB(in); err == nil {
			t.Errorf("parseMemMB(%q) accepted", in)
		}
	}
}

// The largest size is the flags', else the default; it is never below the
// default, which a claim that asks nothing gets.
func TestMaxClaimSize(t *testing.T) {
	cases := []struct {
		cfg  Config
		want driver.ClaimSize
		err  bool
	}{
		{cfg: Config{MemLimit: "4g", CPUs: "2"}, want: driver.ClaimSize{MemoryMB: 4096, CPUs: 2}},
		{cfg: Config{MemLimit: "4g", CPUs: "2", MemMax: "16g", CPUsMax: 8}, want: driver.ClaimSize{MemoryMB: 16384, CPUs: 8}},
		{cfg: Config{MemLimit: "4g", CPUs: "1.5"}, want: driver.ClaimSize{MemoryMB: 4096, CPUs: 1}},
		{cfg: Config{MemLimit: "8g", CPUs: "2", MemMax: "4g"}, err: true},
		{cfg: Config{MemLimit: "4g", CPUs: "4", CPUsMax: 2}, err: true},
		{cfg: Config{MemLimit: "4g", CPUs: "2", MemMax: "lots"}, err: true},
	}
	for _, c := range cases {
		got, err := maxClaimSize(c.cfg)
		if c.err != (err != nil) || got != c.want {
			t.Errorf("maxClaimSize(%+v) = %v, %v; want %v (error %v)", c.cfg, got, err, c.want, c.err)
		}
	}
	if _, err := New(context.Background(), newMemDocker(), Config{CellID: "cell-1", HolderImage: "h", MemLimit: "8g", MemMax: "4g"}); err == nil {
		t.Fatal("New took a maximum below the default")
	}
}

// A claim never gets more than the cell grants: Create refuses the size
// before any container exists.
func TestCreateRefusesASizeAboveTheCellsMax(t *testing.T) {
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "inspect": holderJSON}}
	d, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), MemMax: "8g", CPUsMax: 4})
	if err != nil {
		t.Fatal(err)
	}
	if got := d.Capabilities().MaxClaimSize; got != (driver.ClaimSize{MemoryMB: 8192, CPUs: 4}) {
		t.Fatalf("max %v", got)
	}
	for _, asked := range []driver.ClaimSize{{MemoryMB: 16384, CPUs: 4}, {MemoryMB: 8192, CPUs: 8}} {
		s := spec()
		s.ClaimSize = asked
		if _, err := d.Create(context.Background(), s); !errors.Is(err, driver.ErrSizeUnavailable) {
			t.Fatalf("Create(%v) = %v, want ErrSizeUnavailable", asked, err)
		}
	}
	if r.find("run") != nil {
		t.Fatal("a holder ran for a size the cell does not grant")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.machines) != 0 {
		t.Fatalf("refused machines kept: %v", d.machines)
	}
}

// Each machine's builds run at its claim's size; a claim that asked none
// runs at the default, and the size goes with the machine.
func TestAClaimsSizeReachesItsBuilds(t *testing.T) {
	docker := newMemDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(),
		EgressContainer: "kodus-egress", BuilderImage: "moby/buildkit@sha256:abc", MemMax: "16g", CPUsMax: 8})
	if err != nil {
		t.Fatal(err)
	}
	recordChowns(d)
	ctx := context.Background()
	boot := func(claim string, size driver.ClaimSize) (driver.MachineRef, dockercli.BuildRun) {
		t.Helper()
		n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: claim})
		if err != nil {
			t.Fatal(err)
		}
		s := spec()
		s.ClaimID, s.ClaimGroupID, s.ClaimSize = claim, n.WorkloadGroupID, size
		ref, err := d.Create(ctx, s)
		if err != nil {
			t.Fatal(err)
		}
		subnet := netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID])
		if _, _, err := d.build(ctx, ref, []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), subnet); err != nil {
			t.Fatal(err)
		}
		return ref, docker.builds[len(docker.builds)-1]
	}
	big, b := boot("claim-1", driver.ClaimSize{MemoryMB: 12288, CPUs: 6})
	if b.MemLimit != "12288m" || b.CPUs != "6" {
		t.Fatalf("the sized claim's build ran with --memory %s --cpus %s", b.MemLimit, b.CPUs)
	}
	_, b = boot("claim-2", driver.ClaimSize{})
	if b.MemLimit != "4g" || b.CPUs != "2" {
		t.Fatalf("a claim that asked no size built with --memory %s --cpus %s, want the default", b.MemLimit, b.CPUs)
	}
	if err := d.Destroy(ctx, big); err != nil {
		t.Fatal(err)
	}
	d.mu.Lock()
	_, kept := d.machines[big.MachineID]
	d.mu.Unlock()
	if kept {
		t.Fatal("the size (the machine's state) outlived its machine")
	}
	// An OOM names the limit the build really had.
	docker.buildErr = &dockercli.ExitError{Command: "docker run", Code: dockercli.ExitKilled}
	n, _ := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-1", OrgID: "org-a", ClaimID: "claim-3"})
	s := spec()
	s.ClaimID, s.ClaimGroupID, s.ClaimSize = "claim-3", n.WorkloadGroupID, driver.ClaimSize{MemoryMB: 16384, CPUs: 8}
	ref, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = d.build(ctx, ref, []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, n.WorkloadGroupID, d.resolvPath(n.WorkloadGroupID), netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID]))
	if !errors.Is(err, driver.ErrOutOfMemory) || !strings.Contains(err.Error(), "16384m") {
		t.Fatalf("err %v, want out of memory naming 16384m", err)
	}
}

// Every compose service of a sized claim gets its memory and CPUs, in place
// of the cell's default.
func TestAClaimsSizeReachesItsServices(t *testing.T) {
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`, "run": "c0ffee\n", "inspect": holderJSON, "network subnet": "10.213.5.0/24 \n"}}
	var rewritten []string
	run := func(ctx context.Context, stdin []byte, dir string, args ...string) ([]byte, error) {
		if args[0] == "compose" && strings.Contains(strings.Join(args, " "), " config") {
			for i, a := range args {
				if a == "-f" && i+1 < len(args) {
					b, err := os.ReadFile(args[i+1])
					if err != nil {
						t.Fatal(err)
					}
					rewritten = append(rewritten, string(b))
				}
			}
		}
		return r.run(ctx, stdin, dir, args...)
	}
	d, err := New(context.Background(), dockercli.CLI{Run: run}, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(), MemMax: "16g", CPUsMax: 8})
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	s.ClaimSize = driver.ClaimSize{MemoryMB: 12288, CPUs: 6}
	ref, err := d.Create(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	ref.Tags[driver.TagOrg], ref.Tags[driver.TagRole] = "", ""
	dir := t.TempDir()
	r.answers["compose config"] = canonicalFor(dir)
	r.answers["ps"] = "s1\n"
	r.answers["inspect"] = `[{"Id":"s1","Name":"/kodus-claim-1-workload-a-1","Config":{"Labels":{"kodus.cell":"cell-1"}},"NetworkSettings":{"Networks":{"kodus-claim-1":{"IPAddress":"172.30.0.9"}}}}]`
	if _, err := d.Up(context.Background(), ref, []byte("services:\n  a:\n    image: x\n    mem_limit: 64g\n"), dir); err != nil {
		t.Fatal(err)
	}
	if len(rewritten) != 1 {
		t.Fatalf("%d compose files checked, want 1", len(rewritten))
	}
	f := rewritten[0]
	if !strings.Contains(f, "mem_limit: 12288m") || !strings.Contains(f, "cpus: \"6\"") || strings.Contains(f, "64g") || strings.Contains(f, "mem_limit: 4g") {
		t.Fatalf("services not held to the claim's size:\n%s", f)
	}
}

// A sized environment's pool machine is made at its size and says so: it
// was made at the cell's default and reported no size, so the agent
// discarded it for every claim of that environment.
func TestPoolMachinesAreMadeAtTheEnvironmentsSize(t *testing.T) {
	docker := newMemDocker()
	docker.plant(dockercli.Container{ID: "cegress", Name: "kodus-egress", Networks: map[string]string{"kodus-cell": "10.9.0.2"}})
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "kodus/holder@sha256:abc", WorkDir: t.TempDir(),
		EgressContainer: "kodus-egress", MemMax: "16g", CPUsMax: 8})
	if err != nil {
		t.Fatal(err)
	}
	s := spec()
	size := driver.ClaimSize{MemoryMB: 12288, CPUs: 6}
	pool := driver.PoolSpec{CellID: "cell-1", OrgID: "org-a", EnvironmentID: "env-1", ImageID: s.ImageID, ClaimSize: size, KMSKeyRef: s.KMSKeyRef, Size: s.Size,
		ExpiresAt: s.ExpiresAt, HardExpiresAt: s.HardExpiresAt}
	pm, err := d.PoolCreate(context.Background(), pool)
	if err != nil {
		t.Fatal(err)
	}
	if pm.ClaimSize != size {
		t.Fatalf("the pool machine reports size %v, want %v", pm.ClaimSize, size)
	}
	if mem, cpus := d.limits(pm.Workload.MachineID); mem != "12288m" || cpus != "6" {
		t.Fatalf("the pool machine runs with --memory %s --cpus %s", mem, cpus)
	}
	pool.ClaimSize = driver.ClaimSize{MemoryMB: 32768, CPUs: 6}
	if _, err := d.PoolCreate(context.Background(), pool); !errors.Is(err, driver.ErrSizeUnavailable) {
		t.Fatalf("a pool machine above the cell's max: %v", err)
	}
}

// A claim is counted at its memory limit while it boots and at the ready
// count once its builds are done, never above its own limit (ADR-070).
func TestClaimMemoryCountsBootAtTheLimitAndReadyAtTheReadyCount(t *testing.T) {
	d, err := New(context.Background(), newMemDocker(), Config{CellID: "cell-1", HolderImage: "h", MemLimit: "12g", MemMax: "16g"})
	if err != nil {
		t.Fatal(err)
	}
	if got := d.ClaimMemory(driver.ClaimSize{}); got != (driver.ClaimMemory{BootMB: 12288, ReadyMB: 2048}) {
		t.Fatalf("default claim = %+v", got)
	}
	if got := d.ClaimMemory(driver.ClaimSize{MemoryMB: 16384, CPUs: 8}); got != (driver.ClaimMemory{BootMB: 16384, ReadyMB: 2048}) {
		t.Fatalf("sized claim = %+v", got)
	}
	small, err := New(context.Background(), newMemDocker(), Config{CellID: "cell-1", HolderImage: "h", MemLimit: "1g", MemReady: "3g"})
	if err != nil {
		t.Fatal(err)
	}
	if got := small.ClaimMemory(driver.ClaimSize{}); got != (driver.ClaimMemory{BootMB: 1024, ReadyMB: 1024}) {
		t.Fatalf("ready above the limit = %+v", got)
	}
	if _, err := New(context.Background(), newMemDocker(), Config{CellID: "cell-1", HolderImage: "h", MemReady: "lots"}); err == nil {
		t.Fatal("New took an unreadable ready count")
	}
}

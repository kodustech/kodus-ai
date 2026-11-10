package dockergvisor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"go.yaml.in/yaml/v3"
)

// limitsPathDocker keeps the normal stateful Docker fake and records the
// boundaries where independent container limits used to bypass one budget.
type limitsPathDocker struct {
	*memDocker
	composeParents []string
	copyParents    []string
	copyErr        error
}

func (m *limitsPathDocker) CopyVolumeGeneration(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent, expected, write string) error {
	return m.memDocker.copyGeneration(from, to, expected, write, func() error { return m.CopyVolumeBound(ctx, runtime, helper, from, to, labels, parent) })
}

func (m *limitsPathDocker) ComposeConfig(_ context.Context, p dockercli.ComposeProject) ([]byte, error) {
	raw, err := os.ReadFile(p.File)
	if err != nil {
		return nil, err
	}
	var doc map[string]any
	if err = yaml.Unmarshal(raw, &doc); err != nil {
		return nil, err
	}
	services, _ := doc["services"].(map[string]any)
	for _, s := range services {
		parent, _ := s.(map[string]any)["cgroup_parent"].(string)
		m.composeParents = append(m.composeParents, parent)
	}
	return json.Marshal(doc)
}
func (m *limitsPathDocker) CopyVolumeBound(ctx context.Context, runtime, helper, from, to string, labels map[string]string, parent string) error {
	m.copyParents = append(m.copyParents, parent)
	if m.copyErr != nil {
		return m.copyErr
	}
	return m.memDocker.CopyVolumeIn(ctx, runtime, helper, from, to, labels)
}
func limitedPathsDriver(t *testing.T) (*Driver, *limitsPathDocker, *fakeClaimLimits) {
	t.Helper()
	docker := &limitsPathDocker{memDocker: newMemDocker()}
	limits := &fakeClaimLimits{}
	d, err := New(context.Background(), docker, Config{CellID: "cell-1", HolderImage: "holder", BuilderImage: "moby/buildkit@sha256:abc", WorkDir: t.TempDir(), ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	recordChowns(d)
	return d, docker, limits
}
func makeLimitedClaim(t *testing.T, d *Driver, id string) (driver.ClaimNetwork, driver.MachineRef) {
	t.Helper()
	ctx := context.Background()
	s := spec()
	s.ClaimID = id
	s.EnvironmentID = bakeEnv
	n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: id})
	if err != nil {
		t.Fatal(err)
	}
	s.ClaimGroupID = n.WorkloadGroupID
	ref, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	return n, ref
}
func runLimitedBrowser(t *testing.T, d *Driver, claim string, ref driver.MachineRef) ([]string, error) {
	t.Helper()
	d.mu.Lock()
	d.machineLocked(ref.MachineID).services = map[string]string{"api": "10.213.1.10"}
	d.mu.Unlock()
	var args []string
	r := BrowserRunner{Driver: d, Image: browserImage, Exec: func(_ context.Context, a []string, _ []byte, _ io.Writer) error {
		if a[0] == "run" {
			args = append([]string(nil), a...)
		}
		return nil
	}}
	err := r.Run(context.Background(), browser.RunSpec{ClaimID: claim, Workload: ref.MachineID, Service: "api", Port: 3000, Deadline: time.Second}, nil, io.Discard)
	return args, err
}

func TestClaimLimitsBuildersComposeAndBrowserKeepTheHolderParent(t *testing.T) {
	d, docker, _ := limitedPathsDriver(t)
	ctx := context.Background()
	n, ref := makeLimitedClaim(t, d, "claim-paths")
	parent := docker.containers[ref.MachineID].CgroupParent
	if parent == "" {
		t.Fatal("holder has no aggregate parent")
	}
	dir := project(t)
	_, _, err := d.build(ctx, ref, []sandbox.Build{{Service: "api", Context: dir, Dockerfile: "Dockerfile"}}, n.WorkloadGroupID, "", netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID]))
	if err != nil {
		t.Fatal(err)
	}
	if len(docker.builds) != 1 || docker.builds[0].CgroupParent != parent {
		t.Fatalf("builder parent escaped: %+v", docker.builds)
	}
	_, err = d.Up(ctx, ref, []byte("services:\n  api:\n    image: app\n"), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if len(docker.composeParents) != 1 || docker.composeParents[0] != parent {
		t.Fatalf("compose parent escaped: %v", docker.composeParents)
	}
	args, err := runLimitedBrowser(t, d, "claim-paths", ref)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(args, " "), "--cgroup-parent "+parent+" ") {
		t.Fatalf("browser escaped: %q", args)
	}
}

func TestClaimLimitsControllerLossRefusesEveryNewContainerPath(t *testing.T) {
	for _, kind := range []string{"builder", "compose", "browser", "restore"} {
		t.Run(kind, func(t *testing.T) {
			d, docker, limits := limitedPathsDriver(t)
			ctx := context.Background()
			n, ref := makeLimitedClaim(t, d, "claim-loss")
			limits.fail = errors.New("delegated hierarchy lost")
			var err error
			switch kind {
			case "builder":
				_, _, err = d.build(ctx, ref, []sandbox.Build{{Service: "api", Context: project(t), Dockerfile: "Dockerfile"}}, n.WorkloadGroupID, "", netip.MustParsePrefix(docker.subnets[n.WorkloadGroupID]))
			case "compose":
				_, err = d.Up(ctx, ref, []byte("services:\n  api:\n    image: app\n"), t.TempDir())
			case "browser":
				_, err = runLimitedBrowser(t, d, "claim-loss", ref)
			case "restore":
				ref.ImageID = bakeImageID("cell-1", bakeOrg, bakeEnv, strings.Repeat("a", 40))
				_, err = d.restoreData(ctx, ref, []string{"pgdata"})
			}
			if !errors.Is(err, ErrResourceEnforcement) {
				t.Fatalf("%s err=%v", kind, err)
			}
			if len(docker.builds) != 0 || len(docker.composeParents) != 0 || len(docker.copyParents) != 0 {
				t.Fatalf("work started without parent: builds=%d compose=%v copy=%v", len(docker.builds), docker.composeParents, docker.copyParents)
			}
		})
	}
}

func TestClaimLimitsAdoptedPoolObserverAndBrowserSharePhysicalParent(t *testing.T) {
	d, docker, _ := limitedPathsDriver(t)
	ctx := context.Background()
	s := spec()
	p, err := d.PoolCreate(ctx, driver.PoolSpec{CellID: s.CellID, OrgID: s.OrgID, EnvironmentID: bakeEnv, ImageID: s.ImageID, Size: s.Size, KMSKeyRef: s.KMSKeyRef, ExpiresAt: s.ExpiresAt, HardExpiresAt: s.HardExpiresAt})
	if err != nil {
		t.Fatal(err)
	}
	parent := docker.containers[p.Workload.MachineID].CgroupParent
	if err = d.Adopt(ctx, p, "claim-adopted"); err != nil {
		t.Fatal(err)
	}
	s.ClaimID = "claim-adopted"
	s.Role = driver.RoleObserver
	s.ClaimGroupID = p.Network.WorkloadGroupID
	observer, err := d.Create(ctx, s)
	if err != nil {
		t.Fatal(err)
	}
	if got := docker.containers[observer.MachineID].CgroupParent; got != parent {
		t.Fatalf("observer changed physical parent %q -> %q", parent, got)
	}
	args, err := runLimitedBrowser(t, d, "claim-adopted", p.Workload)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(args, " "), "--cgroup-parent "+parent+" ") {
		t.Fatalf("adopted browser escaped physical parent: %q", args)
	}
}

func TestClaimLimitsBakePinAndRestoreHelpersRetainTheirOwnedParent(t *testing.T) {
	d, docker, limits := limitedPathsDriver(t)
	ctx := context.Background()
	n, setup := makeLimitedClaim(t, d, "claim-seed")
	parent := docker.containers[setup.MachineID].CgroupParent
	d.machineOutput(setup.MachineID).volumes = []string{"pgdata"}
	docker.plantVolume(setup.MachineID, "pgdata", "seed")
	if err := d.PinBakeSource(setup); err != nil {
		t.Fatal(err)
	}
	if err := d.Destroy(ctx, setup); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if len(limits.removed) != 0 {
		t.Fatal("parent removed before pinned bake helper finished")
	}
	image, err := d.Bake(ctx, bakeSpec(setup))
	if err != nil {
		t.Fatal(err)
	}
	if len(docker.copyParents) != 1 || docker.copyParents[0] != parent {
		t.Fatalf("bake helper escaped parent: %v", docker.copyParents)
	}
	if len(limits.removed) != 1 {
		t.Fatalf("bake's empty parent not removed: %v", limits.removed)
	}
	_, target := makeLimitedClaim(t, d, "claim-from-bake")
	target.ImageID = image.ImageID
	targetParent := docker.containers[target.MachineID].CgroupParent
	if targetParent == parent {
		t.Fatal("new claim inherited setup parent")
	}
	count, err := d.restoreData(ctx, target, []string{"pgdata"})
	if err != nil || count != 1 {
		t.Fatalf("restore %d %v", count, err)
	}
	if len(docker.copyParents) != 2 || docker.copyParents[1] != targetParent {
		t.Fatalf("restore helper escaped target parent: %v", docker.copyParents)
	}
}

type emptyParentLimits struct{ *fakeClaimLimits }

func (emptyParentLimits) Ensure(string, claimlimits.Limits) (string, error) { return "", nil }

func TestClaimLimitsEmptyManagerParentNeverFallsBackToUnlimited(t *testing.T) {
	d, docker, limits := limitedPathsDriver(t)
	d.cfg.ClaimLimits = emptyParentLimits{limits}
	s := spec()
	ctx := context.Background()
	if _, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: s.CellID, OrgID: s.OrgID, ClaimID: s.ClaimID}); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Create(ctx, s); !errors.Is(err, ErrResourceEnforcement) {
		t.Fatalf("empty parent accepted: %v", err)
	}
	if len(docker.containers) != 0 {
		t.Fatal("holder launched outside requested aggregate parent")
	}
}

func TestClaimLimitsRestoreHelperFailureCannotBecomeSuccess(t *testing.T) {
	d, docker, _ := limitedPathsDriver(t)
	ctx := context.Background()
	_, ref := makeLimitedClaim(t, d, "claim-copy-error")
	ref.ImageID = bakeImageID("cell-1", bakeOrg, bakeEnv, strings.Repeat("a", 40))
	labels := envLabels("cell-1", bakeOrg, bakeEnv)
	labels[labelBakeVolume], labels[labelBakeSHA] = "pgdata", strings.Repeat("a", 40)
	docker.volumes[bakeVolume("cell-1", bakeOrg, bakeEnv, "pgdata", strings.Repeat("a", 40))] = memVolume{labels: labels, data: "seed"}
	docker.copyErr = ErrResourceEnforcement
	if count, err := d.restoreData(ctx, ref, []string{"pgdata"}); !errors.Is(err, ErrResourceEnforcement) || count != 0 {
		t.Fatalf("copy refusal became success: count=%d err=%v", count, err)
	}
}

func TestClaimLimitsPoolRestoreUsesThePoolsOwnParent(t *testing.T) {
	d, docker, _ := limitedPathsDriver(t)
	ctx := context.Background()
	s := spec()
	s.ImageID = installGenerationForTest(t, d, docker.memDocker)
	pool, err := d.PoolCreate(ctx, driver.PoolSpec{CellID: s.CellID, OrgID: s.OrgID, EnvironmentID: bakeEnv, ImageID: s.ImageID, Size: s.Size, KMSKeyRef: s.KMSKeyRef, ExpiresAt: s.ExpiresAt, HardExpiresAt: s.HardExpiresAt})
	if err != nil {
		t.Fatal(err)
	}
	parent := docker.containers[pool.Workload.MachineID].CgroupParent
	if len(docker.copyParents) != 1 || docker.copyParents[0] != parent {
		t.Fatalf("pool restore escaped %q: %v", parent, docker.copyParents)
	}
}

type onceFailRemoveLimits struct {
	*fakeClaimLimits
	failed bool
}

func (f *onceFailRemoveLimits) Remove(key string) error {
	if !f.failed {
		f.failed = true
		return errors.New("group still draining")
	}
	return f.fakeClaimLimits.Remove(key)
}

func TestClaimLimitsReleaseRetriesParentAfterNetworkAlreadyGone(t *testing.T) {
	d, docker, limits := limitedPathsDriver(t)
	d.cfg.ClaimLimits = &onceFailRemoveLimits{fakeClaimLimits: limits}
	ctx := context.Background()
	n, ref := makeLimitedClaim(t, d, "claim-retry-parent")
	if err := d.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if err := d.ReleaseClaim(ctx, n); err == nil {
		t.Fatal("first parent-removal failure was swallowed")
	}
	if _, ok := docker.networks[n.WorkloadGroupID]; ok {
		t.Fatal("fixture network was not removed")
	}
	if err := d.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if len(limits.removed) != 1 {
		t.Fatalf("parent cleanup never retried after network removal: %v", limits.removed)
	}
}

func TestClaimLimitsRestartDestroyReleaseRecoversParentOwnership(t *testing.T) {
	d, docker, limits := limitedPathsDriver(t)
	ctx := context.Background()
	n, ref := makeLimitedClaim(t, d, "claim-restart-release")
	restarted, err := New(ctx, docker, Config{CellID: "cell-1", HolderImage: "holder", WorkDir: t.TempDir(), ClaimLimits: limits})
	if err != nil {
		t.Fatal(err)
	}
	if err = restarted.Destroy(ctx, ref); err != nil {
		t.Fatal(err)
	}
	if err = restarted.ReleaseClaim(ctx, n); err != nil {
		t.Fatal(err)
	}
	if len(limits.removed) != 1 {
		t.Fatalf("lost physical-parent cleanup on restart: %v", limits.removed)
	}
}

func TestClaimLimitsRecoveredHolderCannotWidenTheConfiguredCeiling(t *testing.T) {
	for _, kind := range []string{"org", "memory", "cpu", "host-pids", "parent", "claim"} {
		t.Run(kind, func(t *testing.T) {
			d, docker, _ := limitedPathsDriver(t)
			ctx := context.Background()
			_, ref := makeLimitedClaim(t, d, "claim-metadata")
			c := docker.containers[ref.MachineID]
			switch kind {
			case "org":
				c.Labels["kodus.org"] = "other-org"
			case "memory":
				c.Labels[labelLimitMemory] = "8589934592"
			case "cpu":
				c.Labels[labelLimitQuota] = "800000"
			case "host-pids":
				// The new release may lower its ceiling while an older holder persists.
				d.cfg.PidsLimit = 1024
			case "parent":
				c.CgroupParent = "/other-delegation/" + c.Labels[labelLimitKey]
			case "claim":
				c.Labels["kodus.claim"] = "another-claim"
			}
			docker.containers[ref.MachineID] = c
			if _, err := d.parentFor(ctx, ref); !errors.Is(err, ErrResourceEnforcement) {
				t.Fatalf("%s metadata accepted: %v", kind, err)
			}
		})
	}
}

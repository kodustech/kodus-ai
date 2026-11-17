package k8ssandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
)

// cluster is the part of a cluster and its kubelets the environment mode
// uses, in memory: pods (an address at once, held at the gate until the
// init container's open), volume claims whose data is a string, policies,
// logs, and pods/exec into the init container (InitScript's operations) and
// into a service (onExec). A service that starts on an empty volume writes
// "init#<n>" in it, as a database's first start does.
type cluster struct {
	mu      sync.Mutex
	pods    map[string]Object
	objects map[Resource]map[string]Object
	data    map[string]string // claim name -> contents
	hosts   map[string]string // pod -> /etc/hosts
	decoys  map[string]string
	copies  map[string][]byte // pod/dir -> tar
	opened  []string          // pods, in the order their gates opened
	ops     []string          // "pod op args"
	inits   int
	next    int
	// failing services' pods get this waiting reason when they start.
	failing map[string]string
	logs    map[string]string
	onExec  func(pod string, argv []string, stdin []byte) CommandResult
}

func newCluster() *cluster {
	return &cluster{pods: map[string]Object{}, objects: map[Resource]map[string]Object{}, data: map[string]string{},
		hosts: map[string]string{}, decoys: map[string]string{}, copies: map[string][]byte{}, failing: map[string]string{}, logs: map[string]string{}}
}

func roundTrip(o Object) Object {
	b, _ := json.Marshal(o)
	var out Object
	_ = json.Unmarshal(b, &out)
	return out
}

func (c *cluster) CreatePod(_ context.Context, ns string, pod Object, dryRun bool) (Object, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	pod = roundTrip(pod)
	key := ns + "/" + str(meta(pod)["name"])
	if _, ok := c.pods[key]; ok {
		return nil, &APIError{Code: 409, Reason: "AlreadyExists"}
	}
	if dryRun {
		return pod, nil
	}
	meta(pod)["namespace"] = ns
	c.next++
	status := map[string]any{"phase": "Pending", "podIP": fmt.Sprintf("10.1.0.%d", c.next)}
	if spec, _ := pod["spec"].(map[string]any); spec["initContainers"] == nil {
		status["phase"] = "Running" // a holder pod
	}
	pod["status"] = status
	c.pods[key] = pod
	return pod, nil
}

func (c *cluster) GetPod(_ context.Context, ns, name string) (Object, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pods[ns+"/"+name]
	if !ok {
		return nil, ErrNotFound
	}
	return roundTrip(p), nil
}

func (c *cluster) DeletePod(_ context.Context, ns, name string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.pods[ns+"/"+name]; !ok {
		return ErrNotFound
	}
	delete(c.pods, ns+"/"+name)
	return nil
}

func hasLabels(o Object, want map[string]string) bool {
	l, _ := meta(o)["labels"].(map[string]any)
	for k, v := range want {
		if fmt.Sprint(l[k]) != v {
			return false
		}
	}
	return true
}

func (c *cluster) ListPods(_ context.Context, ns string, labels map[string]string) ([]Object, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Object
	for _, p := range c.pods {
		if meta(p)["namespace"] == ns && hasLabels(p, labels) {
			out = append(out, roundTrip(p))
		}
	}
	return out, nil
}

func (c *cluster) PatchPodAnnotations(context.Context, string, string, map[string]string) error {
	return nil
}

func (c *cluster) CreateObject(_ context.Context, ns string, r Resource, obj Object) (Object, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.objects[r] == nil {
		c.objects[r] = map[string]Object{}
	}
	obj = roundTrip(obj)
	key := ns + "/" + str(meta(obj)["name"])
	if _, ok := c.objects[r][key]; ok {
		return nil, &APIError{Code: 409, Reason: "AlreadyExists"}
	}
	meta(obj)["namespace"] = ns
	c.objects[r][key] = obj
	return obj, nil
}

func (c *cluster) ListObjects(_ context.Context, ns string, r Resource, labels map[string]string) ([]Object, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []Object
	for _, o := range c.objects[r] {
		if meta(o)["namespace"] == ns && hasLabels(o, labels) {
			out = append(out, o)
		}
	}
	return out, nil
}

func (c *cluster) DeleteObject(_ context.Context, ns string, r Resource, name string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.objects[r][ns+"/"+name]; !ok {
		return ErrNotFound
	}
	delete(c.objects[r], ns+"/"+name)
	return nil
}

func (c *cluster) PodLogs(_ context.Context, ns, pod, _ string, _ time.Time, _ int) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.pods[ns+"/"+pod]; !ok {
		return nil, ErrNotFound
	}
	return []byte(c.logs[pod]), nil
}

// claimOf is the volume claim a pod mounts under the volume name.
func claimOf(p Object, volume string) string {
	spec, _ := p["spec"].(map[string]any)
	vols, _ := spec["volumes"].([]any)
	for _, v := range vols {
		vm, _ := v.(map[string]any)
		if vm["name"] == volume {
			pvc, _ := vm["persistentVolumeClaim"].(map[string]any)
			return str(pvc["claimName"])
		}
	}
	return ""
}

func (c *cluster) RunCommand(_ context.Context, ns, pod, container string, argv []string, stdin []byte, _ int) (CommandResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	p, ok := c.pods[ns+"/"+pod]
	if !ok {
		return CommandResult{}, ErrNotFound
	}
	if container != kube.InitContainer {
		if c.onExec == nil {
			if slices.Contains(argv, "pwd") {
				return CommandResult{Stdout: []byte("/srv\n")}, nil
			}
			return CommandResult{}, nil
		}
		c.mu.Unlock()
		res := c.onExec(pod, argv, stdin)
		c.mu.Lock()
		return res, nil
	}
	st := p["status"].(map[string]any)
	if st["phase"] != "Pending" {
		return CommandResult{}, errors.New("container kodus-init is not running")
	}
	op, args := argv[4], argv[5:]
	c.ops = append(c.ops, strings.TrimSpace(pod+" "+op+" "+strings.Join(args, " ")))
	switch op {
	case "hosts":
		c.hosts[pod] = string(stdin)
	case "decoy":
		c.decoys[pod] = string(stdin)
	case "copy":
		c.copies[pod+"/"+args[0]] = stdin
	case "wipe":
		c.data[claimOf(p, args[0])] = ""
	case "take":
		return CommandResult{Stdout: []byte(c.data[claimOf(p, args[0])])}, nil
	case "restore":
		c.data[claimOf(p, args[0])] = string(stdin)
	case "open":
		c.opened = append(c.opened, pod)
		spec := p["spec"].(map[string]any)
		svc := spec["containers"].([]any)[0].(map[string]any)
		name := str(svc["name"])
		if reason := c.failing[name]; reason != "" {
			st["containerStatuses"] = []any{map[string]any{"name": name, "state": map[string]any{"waiting": map[string]any{"reason": reason, "message": "no such image"}}}}
			return CommandResult{}, nil
		}
		for _, v := range spec["volumes"].([]any) {
			vm := v.(map[string]any)
			if pvc, ok := vm["persistentVolumeClaim"].(map[string]any); ok && c.data[str(pvc["claimName"])] == "" {
				c.data[str(pvc["claimName"])] = fmt.Sprintf("init#%d", c.inits)
				c.inits++
			}
		}
		st["phase"] = "Running"
		st["containerStatuses"] = []any{map[string]any{"name": name, "state": map[string]any{"running": map[string]any{}}}}
		st["conditions"] = []any{map[string]any{"type": "Ready", "status": "True"}}
	default:
		return CommandResult{ExitCode: 2, Stderr: []byte("unknown op")}, nil
	}
	return CommandResult{}, nil
}

const envNS = "envs"

const composeAppDBCache = `services:
  app:
    image: example/app:1
    depends_on:
      db: {condition: service_healthy}
      cache: {condition: service_started}
    volumes: [uploads:/srv/uploads]
  db:
    image: postgres:16
    healthcheck: {test: [CMD-SHELL, pg_isready]}
    volumes: [pgdata:/var/lib/postgresql/data]
  cache:
    image: redis:7
volumes:
  pgdata: {}
  uploads: {}
`

type envFixture struct {
	t   *testing.T
	c   *cluster
	d   *Driver
	ref driver.MachineRef
	dir string
}

func newEnvFixture(t *testing.T, recipeYAML string) *envFixture {
	t.Helper()
	c := newCluster()
	d, err := New(c, nil, Config{
		CellID: "cell-a", Namespace: sandboxNS, RuntimeClass: "gvisor", HolderImage: "holder@sha256:1", EgressAddress: "10.96.0.53",
		ReadyTimeout: 2 * time.Second, Poll: time.Millisecond,
		Env: &EnvConfig{API: c, Exec: c, Namespace: envNS, HelperImage: "helper@sha256:2"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ref, err := d.Create(context.Background(), driver.MachineSpec{
		CellID: "cell-a", EnvironmentID: "env-1", Role: driver.RoleWorkload, OrgID: "org-1", ClaimID: "claim-1",
		ClaimSize: driver.ClaimSize{MemoryMB: 2048, CPUs: 2}, ClaimGroupID: "claim-1", KMSKeyRef: "k",
		ExpiresAt: time.Now().Add(10 * time.Minute), HardExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if recipeYAML != "" {
		if err := os.MkdirAll(filepath.Join(dir, ".kodus"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ".kodus", "workspace.yaml"), []byte(recipeYAML), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return &envFixture{t: t, c: c, d: d, ref: ref, dir: dir}
}

func (f *envFixture) up(compose string) ([]string, error) {
	return f.d.Up(context.Background(), driver.UpRequest{Ref: f.ref, Compose: []byte(compose), ProjectDir: f.dir})
}

func (f *envFixture) envPods() []Object {
	pods, _ := f.c.ListPods(context.Background(), envNS, map[string]string{"kodus.io/claim": "claim-1"})
	return pods
}

// An Up makes the claim's policy, its volume claims and one pod per
// service on the RuntimeClass in the environment namespace, gives every pod
// a hosts file with every service at its pod's address, starts each
// service once what it depends on meets its condition, and returns the
// pods' addresses.
func TestAnEnvironmentUpBootsEveryServiceInDependsOnOrder(t *testing.T) {
	f := newEnvFixture(t, "version: 1\nservices:\n  compose:\n    public: app\n")
	sources, err := f.up(composeAppDBCache)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 3 {
		t.Errorf("sources %v", sources)
	}
	if len(f.c.objects[ResourceNetworkPolicies]) != 1 || len(f.c.objects[ResourceVolumeClaims]) != 2 {
		t.Errorf("objects %v", f.c.objects)
	}
	pods := f.envPods()
	if len(pods) != 3 {
		t.Fatalf("pods %d", len(pods))
	}
	addr := map[string]string{}
	for _, p := range pods {
		if p["spec"].(map[string]any)["runtimeClassName"] != "gvisor" || !hasLabels(p, map[string]string{"kodus.io/cell": "cell-a", "kodus.io/org": "org-1"}) {
			t.Errorf("pod %v", meta(p))
		}
		addr[str(meta(p)["name"])] = podStatus(p).ip
	}
	for pod, hosts := range f.c.hosts {
		for _, svc := range []string{"app", "db", "cache"} {
			if !strings.Contains(hosts, addr["env-claim-1-"+svc]+"\t"+svc+"\n") {
				t.Errorf("%s's hosts file lacks %s:\n%s", pod, svc, hosts)
			}
		}
	}
	last := f.c.opened[len(f.c.opened)-1]
	if last != "env-claim-1-app" {
		t.Errorf("app started before what it depends on: %v", f.c.opened)
	}
	if _, err := f.up(composeAppDBCache); err == nil {
		t.Error("a second Up without a Reset")
	}
}

// A reset gives the database the data its first start made (the golden
// copy, taken before anything that depends on it ran), not the round's,
// and every other volume starts empty, as compose down -v.
func TestResetRestoresTheGoldenDataAndEmptiesTheRest(t *testing.T) {
	f := newEnvFixture(t, "")
	if _, err := f.up(composeAppDBCache); err != nil {
		t.Fatal(err)
	}
	st := f.d.envs.get(f.ref.MachineID)
	first := f.c.data["env-claim-1-pgdata"]
	if string(st.golden["pgdata"]) != first || first == "" {
		t.Fatalf("golden %q, data %q", st.golden["pgdata"], first)
	}
	if _, ok := st.golden["uploads"]; ok {
		t.Error("the app's own volume became golden")
	}
	uploads := f.c.data["env-claim-1-uploads"]
	f.c.data["env-claim-1-pgdata"] += "+round"
	parts := f.d.Parts()
	if err := parts.Resetter.Reset(context.Background(), f.ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if n := len(f.envPods()); n != 0 {
		t.Fatalf("%d pods after the reset", n)
	}
	if len(f.c.objects[ResourceVolumeClaims]) != 2 {
		t.Error("the reset dropped the volume claims")
	}
	if _, err := f.up(composeAppDBCache); err != nil {
		t.Fatal(err)
	}
	if got := f.c.data["env-claim-1-pgdata"]; got != first {
		t.Errorf("the database restarted on %q, not its first start's %q", got, first)
	}
	if got := f.c.data["env-claim-1-uploads"]; got == uploads {
		t.Errorf("the app's volume kept %q across the reset", got)
	}
	if err := parts.Resetter.Reset(context.Background(), f.ref, driver.SnapshotRef{Kind: "disk"}); !errors.Is(err, driver.ErrUnsupported) {
		t.Errorf("a disk reset: %v", err)
	}
}

// Without a service whose data a reset could restore, every reset starts
// the volumes empty.
func TestNoGoldenServiceMeansEmptyVolumesEachRound(t *testing.T) {
	f := newEnvFixture(t, "")
	compose := "services:\n  db:\n    image: postgres\n    volumes: [d:/d]\nvolumes: {d: {}}\n"
	if _, err := f.up(compose); err != nil {
		t.Fatal(err)
	}
	st := f.d.envs.get(f.ref.MachineID)
	if st.golden != nil || st.goldenOff == "" {
		t.Errorf("golden %v off %q", st.golden, st.goldenOff)
	}
	before := f.c.data["env-claim-1-d"]
	if err := f.d.Parts().Resetter.Reset(context.Background(), f.ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.up(compose); err != nil {
		t.Fatal(err)
	}
	if f.c.data["env-claim-1-d"] == before {
		t.Error("the volume was not emptied")
	}
}

// What the backend cannot run is refused before anything is created: a
// build (no builder yet) and a claim with org secrets are the platform's
// gaps (ErrUnsupported), a privileged service the file's (RefusedError).
func TestUpRefusesWhatTheBackendCannotRunBeforeCreatingAnything(t *testing.T) {
	f := newEnvFixture(t, "")
	if _, err := f.up("services:\n  a:\n    build: .\n"); !errors.Is(err, driver.ErrUnsupported) || !errors.Is(err, kube.ErrUnsupported) {
		t.Errorf("build: %v", err)
	}
	var refused *sandbox.RefusedError
	if _, err := f.up("services:\n  a:\n    image: x\n    privileged: true\n"); !errors.As(err, &refused) {
		t.Errorf("privileged: %v", err)
	}
	if _, err := f.d.Up(context.Background(), driver.UpRequest{Ref: f.ref, Compose: []byte("services: {a: {image: x}}\n"), ProjectDir: f.dir, CellTrust: true}); !errors.Is(err, driver.ErrUnsupported) {
		t.Errorf("cell trust: %v", err)
	}
	if len(f.envPods()) != 0 || len(f.c.objects[ResourceNetworkPolicies]) != 0 {
		t.Error("a refused Up created objects")
	}
	if _, err := f.d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{ClaimID: "claim-1", Expose: []driver.ExposePort{{Service: "a", Port: 80}}}); !errors.Is(err, driver.ErrUnsupported) {
		t.Errorf("expose: %v", err)
	}
}

// A service that cannot start fails the Up as the workload's own failure,
// and leaves no pod behind for the next try.
func TestABootThatFailsLeavesNoPod(t *testing.T) {
	f := newEnvFixture(t, "")
	f.c.failing["web"] = "ErrImagePull"
	_, err := f.up("services:\n  web: {image: nope}\n  side: {image: busybox}\n")
	if !errors.Is(err, driver.ErrWorkloadBoot) || !strings.Contains(err.Error(), "ErrImagePull") {
		t.Errorf("err %v", err)
	}
	if n := len(f.envPods()); n != 0 {
		t.Errorf("%d pods left", n)
	}
}

// An exec runs in the public service's pod, from its working directory,
// under the request's timeout, with its env; its output is masked; a cwd
// outside the working directory or an env that is not NAME=value is refused.
func TestExecRunsInThePublicService(t *testing.T) {
	f := newEnvFixture(t, "version: 1\nservices:\n  compose:\n    public: app\n")
	var got []string
	f.c.onExec = func(pod string, argv []string, _ []byte) CommandResult {
		if slices.Contains(argv, "pwd") {
			return CommandResult{Stdout: []byte("/srv\n")}
		}
		got = append([]string{pod}, argv...)
		return CommandResult{ExitCode: 3, Stdout: []byte("token ghs_secretsecret1234\n")}
	}
	if _, err := f.up(composeAppDBCache); err != nil {
		t.Fatal(err)
	}
	res, err := f.d.Exec(context.Background(), f.ref, kodyexec.Request{Command: "npm test", Cwd: "pkg", TimeoutMs: 30_000, Env: []string{"CI=1"}, Secrets: []string{"ghs_secretsecret1234"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 3 || strings.Contains(res.Stdout, "ghs_") {
		t.Errorf("result %+v", res)
	}
	want := []string{"env-claim-1-app", "/bin/sh", "-c", execLine, "kody-exec", "/srv/pkg", "30", "npm test", "CI=1"}
	if !slices.Equal(got, want) {
		t.Errorf("argv\n got %q\nwant %q", got, want)
	}
	if _, err := f.d.Exec(context.Background(), f.ref, kodyexec.Request{Command: "x", Cwd: "../etc"}); err == nil {
		t.Error("a cwd out of the workspace")
	}
	if _, err := f.d.Exec(context.Background(), f.ref, kodyexec.Request{Command: "x", Env: []string{"A B=1"}}); err == nil {
		t.Error("a bad env")
	}
}

// The recipe's setup and migrate run in the public service and a SQL seed
// is piped to psql in its service, after the Up.
func TestRunRecipeRunsTheStepsInTheServices(t *testing.T) {
	f := newEnvFixture(t, "version: 1\nservices:\n  compose:\n    public: app\nsetup: [make deps]\ndata:\n  migrate: make migrate\n  seed: {service: db, sql: seed.sql}\n")
	if err := os.WriteFile(filepath.Join(f.dir, "seed.sql"), []byte("insert into t values (1);"), 0o644); err != nil {
		t.Fatal(err)
	}
	var ran []string
	var seeded string
	f.c.onExec = func(pod string, argv []string, stdin []byte) CommandResult {
		switch {
		case slices.Contains(argv, "pwd"):
			return CommandResult{Stdout: []byte("/\n")}
		case slices.Contains(argv, "kodus-seed"):
			seeded = pod + ":" + string(stdin)
		case len(argv) > 6:
			ran = append(ran, pod+":"+argv[6])
		}
		return CommandResult{ExitCode: 0}
	}
	if _, err := f.up(composeAppDBCache); err != nil {
		t.Fatal(err)
	}
	var lines []string
	if err := f.d.RunRecipe(context.Background(), f.ref, f.dir, func(l string) { lines = append(lines, l) }); err != nil {
		t.Fatal(err)
	}
	if strings.Join(ran, ",") != "env-claim-1-app:make deps,env-claim-1-app:make migrate" {
		t.Errorf("ran %v", ran)
	}
	if seeded != "env-claim-1-db:insert into t values (1);" {
		t.Errorf("seed %q", seeded)
	}
	f.c.onExec = func(string, []string, []byte) CommandResult {
		return CommandResult{ExitCode: 1, Stderr: []byte("boom")}
	}
	var step *driver.RecipeStepError
	if err := f.d.RunRecipe(context.Background(), f.ref, f.dir, nil); !errors.As(err, &step) || step.Field != "setup[0]" {
		t.Errorf("a failing setup: %v", err)
	}
}

// A Run's decoy credentials file is written into every pod before it
// starts, and the checkout files a service binds are copied in.
func TestTheDecoyAndTheCheckoutCopiesReachEveryPod(t *testing.T) {
	f := newEnvFixture(t, "")
	if err := os.MkdirAll(filepath.Join(f.dir, "conf"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.dir, "conf", "a.conf"), []byte("x=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(f.dir, "evil")); err != nil {
		t.Fatal(err)
	}
	_, err := f.d.Up(context.Background(), driver.UpRequest{Ref: f.ref, ProjectDir: f.dir,
		Compose:  []byte("services:\n  web:\n    image: nginx\n    volumes: [./conf:/etc/nginx/conf.d]\n"),
		Canaries: []driver.Canary{{Slot: driver.CanarySlotNpmrc, Value: "decoy-value"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.c.decoys["env-claim-1-web"], "decoy-value") {
		t.Errorf("decoys %v", f.c.decoys)
	}
	if tar := f.c.copies["env-claim-1-web/copy-0"]; !strings.Contains(string(tar), "a.conf") || !strings.Contains(string(tar), "x=1") {
		t.Errorf("copy %q", tar)
	}
	f2 := newEnvFixture(t, "")
	if err := os.Symlink("/etc", filepath.Join(f2.dir, "etc")); err != nil {
		t.Fatal(err)
	}
	if _, err := f2.up("services:\n  web:\n    image: nginx\n    volumes: [./etc:/x]\n"); err == nil {
		t.Error("a bind through a symlink out of the checkout")
	}
}

// Destroy ends the claim's objects in the environment namespace with its
// machine; the orphan pass ends those of this cell's claims that have no
// machine left, and never another cell's.
func TestDestroyAndTheOrphanPassEndTheClaimsObjects(t *testing.T) {
	f := newEnvFixture(t, "")
	if _, err := f.up(composeAppDBCache); err != nil {
		t.Fatal(err)
	}
	other := Object{"metadata": map[string]any{"name": "env-claim-9", "labels": map[string]any{"kodus.io/cell": "cell-b", "kodus.io/claim": "claim-9"}}}
	if _, err := f.c.CreateObject(context.Background(), envNS, ResourceNetworkPolicies, other); err != nil {
		t.Fatal(err)
	}
	orphan := Object{"metadata": map[string]any{"name": "env-claim-7", "labels": map[string]any{"kodus.io/cell": "cell-a", "kodus.io/claim": "claim-7"}}}
	if _, err := f.c.CreateObject(context.Background(), envNS, ResourceVolumeClaims, orphan); err != nil {
		t.Fatal(err)
	}
	gone, err := f.d.ReapOrphans(context.Background())
	if err != nil || len(gone) != 1 || !strings.Contains(gone[0], "claim-7") {
		t.Errorf("orphans %v %v", gone, err)
	}
	if len(f.envPods()) != 3 {
		t.Error("the orphan pass touched a live claim")
	}
	if err := f.d.Destroy(context.Background(), f.ref); err != nil {
		t.Fatal(err)
	}
	if len(f.envPods()) != 0 || len(f.c.objects[ResourceVolumeClaims]) != 0 {
		t.Errorf("left %d pods, claims %v", len(f.envPods()), f.c.objects[ResourceVolumeClaims])
	}
	if len(f.c.objects[ResourceNetworkPolicies]) != 1 {
		t.Error("another cell's policy was touched")
	}
}

// The services' logs in a window, with the kubelet's timestamps.
func TestServiceLogsReadsTheWindow(t *testing.T) {
	f := newEnvFixture(t, "")
	if _, err := f.up("services:\n  web: {image: nginx}\n"); err != nil {
		t.Fatal(err)
	}
	f.c.logs["env-claim-1-web"] = "2026-11-17T10:00:00.5Z before\n2026-11-17T10:00:02Z inside one\n2026-11-17T10:00:03Z inside two\n2026-11-17T10:00:09Z after\n"
	since, until := time.Date(2026, 11, 17, 10, 0, 1, 0, time.UTC), time.Date(2026, 11, 17, 10, 0, 5, 0, time.UTC)
	lines, err := f.d.ServiceLogs(context.Background(), "claim-1", f.ref, since, until, 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 2 || lines[0].Text != "inside one" || lines[0].Service != "web" {
		t.Errorf("lines %+v", lines)
	}
	if _, err := f.d.ServiceLogs(context.Background(), "claim-2", f.ref, since, until, 100); !errors.Is(err, driver.ErrNotOwned) {
		t.Errorf("another claim's logs: %v", err)
	}
}

// The environment mode needs its own namespace: the restricted sandbox one
// would refuse the builder and its gate is not the environment's.
func TestTheEnvironmentModeNeedsItsOwnNamespace(t *testing.T) {
	c := newCluster()
	_, err := New(c, nil, Config{CellID: "c", Namespace: "same", RuntimeClass: "gvisor", HolderImage: "h", EgressAddress: "1.1.1.1",
		Env: &EnvConfig{API: c, Exec: c, Namespace: "same"}})
	if err == nil {
		t.Error("the sandbox namespace accepted for environments")
	}
	d, err := New(c, nil, Config{CellID: "c", Namespace: "sb", RuntimeClass: "gvisor", HolderImage: "h", EgressAddress: "1.1.1.1"})
	if err != nil {
		t.Fatal(err)
	}
	if p := d.Parts(); p.Composer != nil || p.Resetter != nil || d.RunsEnvironments() {
		t.Error("environment parts without Config.Env")
	}
}

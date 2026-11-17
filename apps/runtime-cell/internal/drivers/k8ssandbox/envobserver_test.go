package k8ssandbox

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// Exec is pods/exec with stdin and stdout attached: the observer's bridge
// (onDial), recorded.
func (c *cluster) Exec(_ context.Context, ns, pod, container string, command []string) (io.ReadWriteCloser, error) {
	c.mu.Lock()
	_, ok := c.pods[ns+"/"+pod]
	c.dials = append(c.dials, append([]string{ns + "/" + pod, container}, command...))
	dial := c.onDial
	c.mu.Unlock()
	if !ok {
		return nil, ErrNotFound
	}
	if dial == nil {
		return nil, errors.New("nothing listens")
	}
	return dial(), nil
}

const observerImage = "cell@sha256:3"

// newObserverFixture is the environment fixture on a cell that runs an
// observer per claim, with its TLS files.
func newObserverFixture(t *testing.T) *envFixture {
	t.Helper()
	tls := t.TempDir()
	for _, f := range []string{"cert.pem", "key.pem", "ca.pem"} {
		if err := os.WriteFile(filepath.Join(tls, f), []byte("-----"+f+"-----\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return newEnvFixtureWith(t, "", func(e *EnvConfig) { e.ObserverImage, e.ObserverTLSDir = observerImage, tls })
}

func (f *envFixture) createObserver() driver.MachineRef {
	f.t.Helper()
	ref, err := f.d.Create(context.Background(), driver.MachineSpec{
		CellID: "cell-a", EnvironmentID: "env-1", Role: driver.RoleObserver, OrgID: "org-1", ClaimID: "claim-1",
		Size: driver.MachineSize{CPU: 2, MemoryGB: 4}, ClaimGroupID: "claim-1", KMSKeyRef: "k", ImageID: "img-1",
		ExpiresAt: time.Now().Add(10 * time.Minute), HardExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		f.t.Fatal(err)
	}
	return ref
}

func (f *envFixture) observerPod() Object {
	p, _ := f.c.GetPod(context.Background(), envNS, "env-claim-1--observer")
	return p
}

func untar(t *testing.T, b []byte) map[string]*tar.Header {
	t.Helper()
	out := map[string]*tar.Header{}
	tr := tar.NewReader(bytes.NewReader(b))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		out[h.Name] = h
	}
}

// The claim's observer machine is a pod of its own in the environment
// namespace on the claim's RuntimeClass, labeled the claim's in the
// observer's role, with its policy; its TLS files go in through the gate
// (the key readable by the observer's user only), and it runs before Create
// returns, its address the machine's.
func TestTheObserverIsAPodOfItsOwnInTheEnvironmentNamespace(t *testing.T) {
	f := newObserverFixture(t)
	ref := f.createObserver()
	p := f.observerPod()
	if p == nil {
		t.Fatalf("no observer pod in %s: %v", envNS, f.c.pods)
	}
	if ref.MachineID != envNS+"/env-claim-1--observer" || ref.PrivateAddress == "" || ref.PrivateAddress != podStatus(p).ip {
		t.Errorf("ref %+v", ref)
	}
	if !hasLabels(p, map[string]string{"kodus.io/cell": "cell-a", "kodus.io/org": "org-1", "kodus.io/claim": "claim-1", "kodus.io/role": "observer", "kodus.io/env": "env-1"}) {
		t.Errorf("labels %v", meta(p)["labels"])
	}
	spec := p["spec"].(map[string]any)
	if spec["runtimeClassName"] != "gvisor" || spec["automountServiceAccountToken"] != false {
		t.Errorf("spec %v", spec)
	}
	if c := container(p, "containers", 0); c["image"] != observerImage {
		t.Errorf("image %v", c["image"])
	}
	if _, ok := f.c.objects[ResourceNetworkPolicies][envNS+"/env-claim-1--observer"]; !ok {
		t.Errorf("no observer policy: %v", f.c.objects[ResourceNetworkPolicies])
	}
	files := untar(t, f.c.copies["env-claim-1--observer/"+kube.ObserverTLSDir])
	for _, name := range []string{"cert.pem", "key.pem", "ca.pem"} {
		h := files[name]
		if h == nil || h.Uid != kube.ObserverUID || h.Gid != kube.ObserverUID {
			t.Errorf("%s: %+v", name, h)
		}
	}
	if h := files["key.pem"]; h != nil && h.Mode&0o007 != 0 {
		t.Errorf("the key is world-readable: %o", h.Mode)
	}
	if !slices.Contains(f.c.opened, "env-claim-1--observer") || podStatus(p).phase != "Running" {
		t.Errorf("the observer did not start: %v %s", f.c.opened, podStatus(p).phase)
	}
	sandboxPods, _ := f.c.ListPods(context.Background(), sandboxNS, map[string]string{"kodus.io/role": "observer"})
	if len(sandboxPods) != 0 {
		t.Error("an observer holder in the sandbox namespace")
	}
}

// An observer pod passes the environment gate unchanged: its container runs
// confined, non-root, with no token and no host namespace.
func TestTheObserverPodPassesTheEnvironmentGate(t *testing.T) {
	f := newObserverFixture(t)
	f.createObserver()
	p := f.observerPod()
	delete(p, "status")
	if failed := gate(t, p); len(failed) > 0 {
		t.Errorf("the gate refuses the observer: %v", failed)
	}
}

// An observer that does not run (its image does not pull) fails Create and
// leaves neither its pod nor its policy.
func TestAnObserverThatDoesNotRunLeavesNothing(t *testing.T) {
	f := newObserverFixture(t)
	f.c.failing[kube.ObserverContainer] = "ErrImagePull"
	_, err := f.d.Create(context.Background(), driver.MachineSpec{
		CellID: "cell-a", EnvironmentID: "env-1", Role: driver.RoleObserver, OrgID: "org-1", ClaimID: "claim-1",
		ClaimGroupID: "claim-1", KMSKeyRef: "k", ExpiresAt: time.Now().Add(time.Minute), HardExpiresAt: time.Now().Add(time.Hour),
	})
	if err == nil || !strings.Contains(err.Error(), "ErrImagePull") {
		t.Errorf("err %v", err)
	}
	if f.observerPod() != nil || len(f.c.objects[ResourceNetworkPolicies]) != 0 {
		t.Error("a failed observer left objects")
	}
}

// The cell reaches the observer through pods/exec: each connection is the
// observer's bridge in its container, carrying the cell's protocol (HTTP
// here) over the exec's stdin and stdout; nothing but this cell's observer
// pod is dialed.
func TestTheCellReachesTheObserverThroughPodsExec(t *testing.T) {
	f := newObserverFixture(t)
	f.c.onDial = func() io.ReadWriteCloser {
		cell, obs := net.Pipe()
		go func() {
			defer func() { _ = obs.Close() }()
			req, err := http.ReadRequest(bufio.NewReader(obs))
			if err != nil {
				return
			}
			body := "configured for " + req.URL.Path
			_, _ = io.WriteString(obs, "HTTP/1.1 200 OK\r\nContent-Length: "+strconv.Itoa(len(body))+"\r\nConnection: close\r\n\r\n"+body)
		}()
		return cell
	}
	ref := f.createObserver()
	hc := &http.Client{Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return f.d.DialObserver(ctx, ref.MachineID)
	}}}
	resp, err := hc.Get("http://" + net.JoinHostPort(ref.PrivateAddress, "7443") + "/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if string(b) != "configured for /v1/config" {
		t.Errorf("body %q", b)
	}
	want := append([]string{envNS + "/env-claim-1--observer", kube.ObserverContainer}, kube.ObserverBridge...)
	if len(f.c.dials) != 1 || !slices.Equal(f.c.dials[0], want) {
		t.Errorf("dials %q", f.c.dials)
	}
	if _, err := f.d.DialObserver(context.Background(), f.ref.MachineID); err == nil {
		t.Error("dialed the workload as an observer")
	}
	if _, err := f.d.DialObserver(context.Background(), envNS+"/env-claim-1-app"); err == nil {
		t.Error("dialed a pod that is no observer")
	}
	other := Object{"metadata": map[string]any{"name": "env-claim-9--observer", "labels": map[string]any{"kodus.io/cell": "cell-b", "kodus.io/claim": "claim-9", "kodus.io/role": "observer"}}, "spec": map[string]any{}}
	if _, err := f.c.CreatePod(context.Background(), envNS, other, false); err != nil {
		t.Fatal(err)
	}
	if _, err := f.d.DialObserver(context.Background(), envNS+"/env-claim-9--observer"); !errors.Is(err, driver.ErrNotOwned) {
		t.Errorf("dialed another cell's observer: %v", err)
	}
}

// The observer's targets are the service pods' addresses on the exposed
// ports, only once the project is up; an exposed service the project does
// not run is an error. PrepareClaim takes the claim's expose ports on a cell
// with an observer.
func TestTargetsAreTheServicePodsAddresses(t *testing.T) {
	f := newObserverFixture(t)
	if _, err := f.d.PrepareClaim(context.Background(), driver.ClaimNetworkSpec{ClaimID: "claim-1", Expose: []driver.ExposePort{{Service: "app", Port: 8080, Kind: "http"}}}); err != nil {
		t.Fatalf("expose with an observer: %v", err)
	}
	in := []observer.Target{{Service: "app", Port: 8080, Kind: "http"}, {Service: "db", Port: 5432, Kind: "postgres"}}
	if _, err := f.d.Targets(f.ref.MachineID, in); err == nil {
		t.Error("targets before the project is up")
	}
	f.createObserver()
	if _, err := f.up(composeAppDBCache); err != nil {
		t.Fatal(err)
	}
	got, err := f.d.Targets(f.ref.MachineID, in)
	if err != nil {
		t.Fatal(err)
	}
	app, _ := f.c.GetPod(context.Background(), envNS, "env-claim-1-app")
	db, _ := f.c.GetPod(context.Background(), envNS, "env-claim-1-db")
	if got[0].Address != podStatus(app).ip+":8080" || got[1].Address != podStatus(db).ip+":5432" || got[1].Kind != "postgres" {
		t.Errorf("targets %+v", got)
	}
	if _, err := f.d.Targets(f.ref.MachineID, []observer.Target{{Service: "nope", Port: 1}}); err == nil {
		t.Error("a target the project does not run")
	}
}

// The observer runs beside the services in the claim's size: its share is
// taken before they split the rest.
func TestTheServicesShareTheClaimLessTheObserver(t *testing.T) {
	f := newObserverFixture(t)
	f.createObserver()
	if _, err := f.up("services:\n  web: {image: nginx}\n"); err != nil {
		t.Fatal(err)
	}
	web, _ := f.c.GetPod(context.Background(), envNS, "env-claim-1-web")
	lim := container(web, "containers", 0)["resources"].(map[string]any)["limits"].(map[string]any)
	if lim["memory"] != "1792Mi" || lim["cpu"] != "1750m" {
		t.Errorf("web limits %v, want the claim's 2048Mi and 2000m less the observer's 256Mi and 250m", lim)
	}
	obs := container(f.observerPod(), "containers", 0)["resources"].(map[string]any)["limits"].(map[string]any)
	if obs["memory"] != "256Mi" || obs["cpu"] != "250m" {
		t.Errorf("observer limits %v", obs)
	}
}

// A reset keeps the claim's observer machine (the same pod name, so the
// same ref) but starts a new observer: the next round's pods have new
// addresses, and an observer refuses to be bound again to other targets. A
// boot that fails leaves the observer; the next Up does not count it as a
// leftover.
func TestResetStartsANewObserverUnderTheSameMachine(t *testing.T) {
	f := newObserverFixture(t)
	ref := f.createObserver()
	f.c.failing["web"] = "ErrImagePull"
	if _, err := f.up("services:\n  web: {image: nope}\n"); err == nil {
		t.Fatal("a boot that fails")
	}
	if f.observerPod() == nil {
		t.Fatal("a failed boot ended the observer")
	}
	delete(f.c.failing, "web")
	if _, err := f.up("services:\n  web: {image: nginx}\n"); err != nil {
		t.Fatalf("Up after a failed boot: %v", err)
	}
	before := podStatus(f.observerPod()).ip
	copies := strings.Count(strings.Join(f.c.ops, "\n"), "env-claim-1--observer copy tls")
	if err := f.d.Parts().Resetter.Reset(context.Background(), f.ref, driver.SnapshotRef{Kind: "compose_volumes"}); err != nil {
		t.Fatal(err)
	}
	p := f.observerPod()
	if p == nil || podStatus(p).phase != "Running" {
		t.Fatalf("no running observer after the reset: %v", p)
	}
	if podStatus(p).ip == before {
		t.Error("the reset kept the observer bound to the last round's addresses")
	}
	if n := strings.Count(strings.Join(f.c.ops, "\n"), "env-claim-1--observer copy tls"); n != copies+1 {
		t.Errorf("the new observer got its TLS files %d times", n-copies)
	}
	if err := f.d.SetExpiry(context.Background(), ref, time.Now().Add(20*time.Minute)); err != nil {
		t.Errorf("the observer machine's ref after a reset: %v", err)
	}
	if _, err := f.up("services:\n  web: {image: nginx}\n"); err != nil {
		t.Fatalf("Up after the reset: %v", err)
	}
}

// The observer goes with its claim: Destroy of the workload, ReleaseClaim
// and the orphan pass end it with the claim's other objects; Destroy of the
// observer machine ends its pod and policy only; the sweep lists it as one
// of this cell's machines.
func TestTheObserverGoesWithItsClaim(t *testing.T) {
	f := newObserverFixture(t)
	ref := f.createObserver()
	if _, err := f.up("services:\n  web: {image: nginx}\n"); err != nil {
		t.Fatal(err)
	}
	refs, err := f.d.List(context.Background(), map[string]string{driver.TagCell: "cell-a", driver.TagRole: "observer"})
	if err != nil || len(refs) != 1 || refs[0].MachineID != ref.MachineID || refs[0].Tags[driver.TagHardExpires] == "" {
		t.Errorf("List %+v %v", refs, err)
	}
	if err := f.d.Destroy(context.Background(), ref); err != nil {
		t.Fatal(err)
	}
	if f.observerPod() != nil {
		t.Error("Destroy left the observer")
	}
	if _, ok := f.c.objects[ResourceNetworkPolicies][envNS+"/env-claim-1--observer"]; ok {
		t.Error("Destroy left the observer's policy")
	}
	if len(f.envPods()) != 1 {
		t.Error("destroying the observer touched the services")
	}
	f.createObserver()
	if err := f.d.ReleaseClaim(context.Background(), driver.ClaimNetwork{WorkloadGroupID: "claim-1"}); err != nil {
		t.Fatal(err)
	}
	if len(f.envPods()) != 0 || len(f.c.objects[ResourceNetworkPolicies]) != 0 {
		t.Errorf("ReleaseClaim left %d pods, policies %v", len(f.envPods()), f.c.objects[ResourceNetworkPolicies])
	}
}

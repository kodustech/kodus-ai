package k8ssandbox

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// The claim's observer (docs/runtime/kubernetes-environment-runs.md, "The
// observer"): with EnvConfig.ObserverImage, the observer machine the agent
// creates (Create, RoleObserver) is a pod of its own in the environment
// namespace on the claim's RuntimeClass (kube.ObserverPod), labeled the
// claim's in the observer's role, so every cleanup by the claim's labels
// ends it, with its own NetworkPolicy (kube.ObserverPolicy: egress to the
// claim's service pods only, no ingress). The cell copies the observer's TLS
// files (EnvConfig.ObserverTLSDir, as docker-gvisor mounts them) in through
// the gate init container and opens it. The observer serves on loopback; the
// cell reaches it through pods/exec, one bridge per connection
// (DialObserver), with the same mTLS client as on docker-gvisor. Its share
// of the claim's size is taken before the services split it, as
// docker-gvisor's observer runs in its claim's budget.
//
// A reset starts a new observer under the same pod name (recycleObserver):
// the next round's service pods have new addresses, and an observer bound to
// a claim refuses another binding with other targets (observer.Server, 409),
// where docker-gvisor's services keep their addresses and its observer
// survives.

// observerTLSFiles are what EnvConfig.ObserverTLSDir holds: the observer's
// server certificate and key, and the CA of the cell's client certificate.
var observerTLSFiles = []string{"cert.pem", "key.pem", "ca.pem"}

// maxObserverTLSFile bounds one of them.
const maxObserverTLSFile = 64 << 10

// observersOn says the cell runs an observer pod per claim.
func (c *EnvConfig) observersOn() bool { return c.ObserverImage != "" }

func (c *EnvConfig) observerDefaults() error {
	if c.ObserverImage == "" {
		return nil
	}
	if c.ObserverTLSDir == "" {
		return errors.New("k8ssandbox: an observer image needs its TLS directory")
	}
	if c.ObserverMemoryMB == 0 {
		c.ObserverMemoryMB = 256
	}
	if c.ObserverMilliCPU == 0 {
		c.ObserverMilliCPU = 250
	}
	if c.ObserverMemoryMB < 0 || c.ObserverMilliCPU < 0 {
		return errors.New("k8ssandbox: the observer's size is never negative")
	}
	return nil
}

// observerReserve is the observer's share the services leave, when the cell
// runs observers.
func (c *EnvConfig) observerReserve() kube.Share {
	if !c.observersOn() {
		return kube.Share{}
	}
	return kube.Share{MemoryMB: c.ObserverMemoryMB, MilliCPU: c.ObserverMilliCPU}
}

// observerFacts are what an observer pod renders from: its claim, org and
// environment, its ceiling, and its lease's expiry.
type observerFacts struct {
	claim, org, env string
	ceiling         time.Time
	expires         string
	image           string
}

// observerOptions are the claim's placement as an observer renders it.
func (d *Driver) observerOptions(f observerFacts) (kube.Options, error) {
	e := d.cfg.Env
	deadline := int64(f.ceiling.Sub(d.cfg.Now()).Seconds())
	if deadline < 1 {
		return kube.Options{}, errors.New("k8ssandbox: the claim's ceiling passed")
	}
	labels := map[string]string{label(driver.TagCell): d.cfg.CellID, label(driver.TagOrg): f.org, label(driver.TagClaim): f.claim,
		label(driver.TagRole): string(driver.RoleWorkload), label(driver.TagEnv): f.env}
	return kube.Options{
		Namespace: e.Namespace, Prefix: envPrefix(f.claim), Labels: labels, Selector: d.envSelector(f.claim),
		Annotations: map[string]string{
			label(driver.TagHardExpires): driver.FormatTime(f.ceiling), label(driver.TagExpires): f.expires, prefix + "image": f.image,
		},
		RuntimeClass: e.RuntimeClass, HelperImage: e.HelperImage, DeadlineSeconds: deadline,
	}, nil
}

// renderObserver is the claim's observer pod and policy.
func (d *Driver) renderObserver(f observerFacts) (kube.Observer, Object, error) {
	e := d.cfg.Env
	o, err := d.observerOptions(f)
	if err != nil {
		return kube.Observer{}, nil, err
	}
	ob, err := kube.ObserverPod(o, kube.ObserverSpec{Image: e.ObserverImage, CellID: d.cfg.CellID, MemoryMB: e.ObserverMemoryMB, MilliCPU: e.ObserverMilliCPU})
	if err != nil {
		return kube.Observer{}, nil, err
	}
	return ob, kube.ObserverPolicy(o), nil
}

// createObserver makes the claim's observer machine: its policy, its pod,
// started (startObserver). An observer that does not start leaves neither.
func (d *Driver) createObserver(ctx context.Context, spec driver.MachineSpec) (driver.MachineRef, error) {
	e := d.cfg.Env
	tags := spec.AllTags()
	f := observerFacts{claim: spec.ClaimID, org: spec.OrgID, env: spec.EnvironmentID, ceiling: spec.HardExpiresAt, expires: tags[driver.TagExpires], image: spec.ImageID}
	ob, pol, err := d.renderObserver(f)
	if err != nil {
		return driver.MachineRef{}, err
	}
	unlock := d.observerLocks.lock(ob.PodName)
	defer unlock()
	if err := d.replaceObject(ctx, ResourceNetworkPolicies, pol); err != nil {
		return driver.MachineRef{}, err
	}
	ip, err := d.startObserver(ctx, ob)
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), e.StopTimeout)
		defer cancel()
		return driver.MachineRef{}, errors.Join(err, ignoreNotFound(e.API.DeleteObject(cleanup, e.Namespace, ResourceNetworkPolicies, kube.ObserverPodName(envPrefix(spec.ClaimID)))))
	}
	id := e.Namespace + "/" + ob.PodName
	return driver.MachineRef{MachineID: id, DriverRef: id, PrivateAddress: ip, ImageID: spec.ImageID, Tags: tags}, nil
}

// replaceObject creates obj in the environment namespace, replacing one of
// the same name a crashed cell left.
func (d *Driver) replaceObject(ctx context.Context, r Resource, obj Object) error {
	e := d.cfg.Env
	_, err := e.API.CreateObject(ctx, e.Namespace, r, obj)
	if !IsConflict(err) {
		return err
	}
	if err := ignoreNotFound(e.API.DeleteObject(ctx, e.Namespace, r, str(meta(obj)["name"]))); err != nil {
		return err
	}
	_, err = e.API.CreateObject(ctx, e.Namespace, r, obj)
	return err
}

// startObserver creates the observer pod, waits for its address, copies its
// TLS files in through the gate, opens it and waits until the observer runs.
// A pod that does not get there is deleted. It returns the pod's address.
func (d *Driver) startObserver(ctx context.Context, ob kube.Observer) (string, error) {
	e := d.cfg.Env
	files, err := d.observerTLS()
	if err != nil {
		return "", err
	}
	fail := func(err error) (string, error) {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), e.StopTimeout)
		defer cancel()
		return "", errors.Join(fmt.Errorf("k8ssandbox: observer %s: %w", ob.PodName, err), d.deletePod(cleanup, ob.PodName))
	}
	if _, err := e.API.CreatePod(ctx, e.Namespace, ob.Pod, false); err != nil {
		return "", fmt.Errorf("k8ssandbox: observer %s: %w", ob.PodName, err)
	}
	p, err := d.waitObserver(ctx, ob.PodName, "address")
	if err != nil {
		return fail(err)
	}
	if _, err := d.initOp(ctx, ob.PodName, "copy", []string{kube.ObserverTLSDir}, files, 1<<20); err != nil {
		return fail(err)
	}
	if _, err := d.initOp(ctx, ob.PodName, "open", nil, nil, 1<<20); err != nil {
		return fail(err)
	}
	if _, err := d.waitObserver(ctx, ob.PodName, "started"); err != nil {
		return fail(err)
	}
	return podStatus(p).ip, nil
}

// waitObserver polls the observer pod until it reaches want (address,
// started). Its failure is the platform's, never the workload's.
func (d *Driver) waitObserver(ctx context.Context, name, want string) (Object, error) {
	e := d.cfg.Env
	ctx, cancel := context.WithTimeout(ctx, d.cfg.ReadyTimeout)
	defer cancel()
	last := "Pending"
	for {
		p, err := e.API.GetPod(ctx, e.Namespace, name)
		if err != nil && ctx.Err() == nil {
			return nil, err
		}
		if p != nil {
			done, why, fatal := envPodState(p, kube.ObserverContainer, want)
			switch {
			case done:
				return p, nil
			case fatal:
				return nil, errors.New(why)
			case why != "":
				last = why
			}
		}
		select {
		case <-ctx.Done():
			return nil, fmt.Errorf("did not get %s in %s: %s", want, d.cfg.ReadyTimeout, last)
		case <-time.After(d.cfg.Poll):
		}
	}
}

// observerTLS is the tar the gate unpacks into the observer's TLS volume:
// the files owned by the observer's user, the key readable by it only (and
// its group, the pod's fsGroup).
func (d *Driver) observerTLS() ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, name := range observerTLSFiles {
		f, err := os.Open(filepath.Join(d.cfg.Env.ObserverTLSDir, name)) //nolint:gosec // G304: the operator's observer TLS directory
		if err != nil {
			return nil, fmt.Errorf("k8ssandbox: observer TLS: %w", err)
		}
		raw, err := io.ReadAll(io.LimitReader(f, maxObserverTLSFile+1))
		_ = f.Close()
		switch {
		case err != nil:
			return nil, fmt.Errorf("k8ssandbox: observer TLS: %w", err)
		case len(raw) > maxObserverTLSFile:
			return nil, fmt.Errorf("k8ssandbox: observer TLS: %s is over %d KiB", name, maxObserverTLSFile>>10)
		}
		mode := int64(0o444)
		if name == "key.pem" {
			mode = 0o440
		}
		h := &tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: mode, Size: int64(len(raw)), Uid: kube.ObserverUID, Gid: kube.ObserverUID}
		if err := tw.WriteHeader(h); err != nil {
			return nil, err
		}
		if _, err := tw.Write(raw); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// ownObserver reads the observer pod a machine id names in the environment
// namespace: this cell's, in the observer's role; nil when it is gone.
func (d *Driver) ownObserver(ctx context.Context, machine string) (Object, string, error) {
	e := d.cfg.Env
	ns, name := split(driver.MachineRef{DriverRef: machine})
	if e == nil || ns != e.Namespace || name == "" {
		return nil, name, fmt.Errorf("%w: %s is no observer of this cell", driver.ErrNotOwned, machine)
	}
	p, err := e.API.GetPod(ctx, ns, name)
	if errors.Is(err, ErrNotFound) {
		return nil, name, nil
	}
	if err != nil {
		return nil, name, err
	}
	labels, _ := meta(p)["labels"].(map[string]any)
	if !d.owns(p) || str(labels[label(driver.TagRole)]) != kube.ObserverRole {
		return nil, name, fmt.Errorf("%w: pod %s is no observer of this cell", driver.ErrNotOwned, machine)
	}
	return p, name, nil
}

// isObserverRef says the ref names a pod of the environment namespace: an
// observer machine.
func (d *Driver) isObserverRef(ref driver.MachineRef) bool {
	ns, _ := split(ref)
	return d.cfg.Env != nil && ns == d.cfg.Env.Namespace
}

// DialObserver opens one connection to the claim's observer: the observer's
// bridge (kube.ObserverBridge) in its container over pods/exec, the cell's
// stream its stdin and stdout. machine is the observer machine's id.
func (d *Driver) DialObserver(ctx context.Context, machine string) (net.Conn, error) {
	if d.exec == nil {
		return nil, errors.New("k8ssandbox: no exec client")
	}
	p, name, err := d.ownObserver(ctx, machine)
	if err != nil {
		return nil, err
	}
	if p == nil {
		return nil, fmt.Errorf("k8ssandbox: observer %s is gone", machine)
	}
	s, err := d.exec.Exec(ctx, d.cfg.Env.Namespace, name, kube.ObserverContainer, kube.ObserverBridge)
	if err != nil {
		return nil, err
	}
	return streamConn(s), nil
}

// Targets points each exposed port at its compose service's pod address,
// where the claim's observer reaches it; an exposed service the project does
// not run is an error, and so is a project that is not up.
func (d *Driver) Targets(workload string, in []observer.Target) ([]observer.Target, error) {
	addrs := d.envs.addresses(workload)
	if addrs == nil {
		return nil, fmt.Errorf("k8ssandbox: %s has no project up", workload)
	}
	out := make([]observer.Target, 0, len(in))
	for _, t := range in {
		ip, ok := addrs[t.Service]
		if !ok || ip == "" {
			return nil, fmt.Errorf("k8ssandbox: service %s is not up in %s", t.Service, workload)
		}
		t.Address = net.JoinHostPort(ip, strconv.Itoa(t.Port))
		out = append(out, t)
	}
	return out, nil
}

// recycleObserver starts a new observer under the claim's observer pod name
// (a reset: the next round binds it to the new pods' addresses), keeping its
// labels and lease expiry. A claim with no observer pod is left as it is.
func (d *Driver) recycleObserver(ctx context.Context, f holderFacts) error {
	e := d.cfg.Env
	if !e.observersOn() {
		return nil
	}
	name := kube.ObserverPodName(envPrefix(f.claim))
	unlock := d.observerLocks.lock(name)
	defer unlock()
	old, _, err := d.ownObserver(ctx, e.Namespace+"/"+name)
	if err != nil || old == nil {
		return err
	}
	labels, _ := meta(old)["labels"].(map[string]any)
	ann, _ := meta(old)["annotations"].(map[string]any)
	of := observerFacts{claim: f.claim, org: f.org, env: str(labels[label(driver.TagEnv)]), ceiling: f.ceiling,
		expires: str(ann[label(driver.TagExpires)]), image: str(ann[prefix+"image"])}
	ob, _, err := d.renderObserver(of)
	if err != nil {
		return err
	}
	if err := d.deletePod(ctx, name); err != nil {
		return err
	}
	_, err = d.startObserver(ctx, ob)
	return err
}

// destroyObserver ends the observer machine: its pod and its policy.
func (d *Driver) destroyObserver(ctx context.Context, ref driver.MachineRef) error {
	e := d.cfg.Env
	_, name := split(ref)
	unlock := d.observerLocks.lock(name)
	defer unlock()
	p, _, err := d.ownObserver(ctx, ref.DriverRef)
	if err != nil || p == nil {
		return err
	}
	err = ignoreNotFound(e.API.DeletePod(ctx, e.Namespace, name))
	return errors.Join(err, ignoreNotFound(e.API.DeleteObject(ctx, e.Namespace, ResourceNetworkPolicies, name)))
}

// setObserverExpiry is SetExpiry on an observer pod, after any recycle of it.
func (d *Driver) setObserverExpiry(ctx context.Context, ref driver.MachineRef, at time.Time) error {
	e := d.cfg.Env
	_, name := split(ref)
	unlock := d.observerLocks.lock(name)
	defer unlock()
	p, _, err := d.ownObserver(ctx, ref.DriverRef)
	if err != nil {
		return err
	}
	if p == nil {
		return fmt.Errorf("k8ssandbox: pod %s is gone: %w", ref.DriverRef, ErrNotFound)
	}
	return d.patchExpiry(ctx, e.API, e.Namespace, name, p, at)
}

// keyedLocks is one mutex per key, kept while someone holds or waits on it.
type keyedLocks struct {
	mu sync.Mutex
	m  map[string]*keyedLock
}

type keyedLock struct {
	sync.Mutex
	n int
}

func (k *keyedLocks) lock(key string) (unlock func()) {
	k.mu.Lock()
	if k.m == nil {
		k.m = map[string]*keyedLock{}
	}
	l := k.m[key]
	if l == nil {
		l = &keyedLock{}
		k.m[key] = l
	}
	l.n++
	k.mu.Unlock()
	l.Lock()
	return func() {
		l.Unlock()
		k.mu.Lock()
		if l.n--; l.n == 0 {
			delete(k.m, key)
		}
		k.mu.Unlock()
	}
}

// streamConn is an exec stream as a net.Conn (deadlines included), through
// a pipe; the two copies end, and are waited for, on Close.
func streamConn(s io.ReadWriteCloser) net.Conn {
	cell, pipe := net.Pipe()
	c := &execConn{Conn: cell}
	c.wg.Add(2)
	go func() {
		defer c.wg.Done()
		_, _ = io.Copy(pipe, s)
		_ = pipe.Close()
	}()
	go func() {
		defer c.wg.Done()
		_, _ = io.Copy(s, pipe)
		_ = s.Close()
	}()
	return c
}

type execConn struct {
	net.Conn
	wg   sync.WaitGroup
	once sync.Once
	err  error
}

// Close ends the stream and waits for both copies.
func (c *execConn) Close() error {
	c.once.Do(func() {
		c.err = c.Conn.Close()
		c.wg.Wait()
	})
	return c.err
}

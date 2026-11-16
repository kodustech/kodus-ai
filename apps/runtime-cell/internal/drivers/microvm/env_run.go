package microvm

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/buildmirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/sandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/composecmd"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guestinit"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// A Run's whole path on microVMs (docs/runtime/isolation-p3-snapshots.md,
// "Environments in a microVM"):
//   - the workload is an environment VM whose own dockerd runs the claim's
//     compose project (env.go);
//   - the observer is a microVM of its own on the claim's bridge, the guest
//     agent's observer mode, which the cell reaches over that VM's vsock only:
//     no TCP from the host into any VM, and no TCP port on the claim's network
//     that a workload could reach to command it;
//   - the observer reaches each exposed service at the workload VM's address
//     on the port the service listens on (the compose file publishes it on
//     the VM at the same number);
//   - a setup's bake is the environment's template, and a claim of that image
//     is restored from it.

// ObserverVsockPort is where an observer microVM serves the cell.
const ObserverVsockPort = 7443

// observerDir is where an observer VM keeps its TLS files and log.
const observerDir = ".kodus-observer"

// projectName is the compose project of a claim's VM: the environment's,
// so a Run side restored from the environment's template updates the
// project the setup brought up.
func projectName(ref driver.MachineRef) string {
	h := sha256.Sum256([]byte(ref.Tags[driver.TagEnv]))
	return "kenv-" + hex.EncodeToString(h[:6])
}

// vmFiles are the cell's files a claim's services get in its VM: the Run's
// decoy credentials file and the cell's trust files, by name under
// cellFilesDir in the project, with where each goes in every service.
type vmFiles struct {
	files  map[string][]byte
	mounts map[string]string // file name -> target in the service
	env    map[string]string
}

// cellFilesDir is where the cell's files for the services sit in the project.
const cellFilesDir = ".kodus-cell"

// filesFor are the decoy and trust files of a claim's Up.
func (d *Driver) filesFor(req driver.UpRequest) (vmFiles, error) {
	f := vmFiles{files: map[string][]byte{}, mounts: map[string]string{}}
	if decoy := driver.CanaryFileOf(req.Canaries); decoy != "" {
		f.files["npmrc"], f.mounts["npmrc"] = []byte(decoy), sandbox.DecoyTarget
	}
	if req.CellTrust {
		if !d.cfg.Trust.Set() {
			return vmFiles{}, errors.New("microvm: the claim's machines need the cell's trust files and this cell has none")
		}
		for name, src := range map[string]string{"ca-bundle.pem": d.cfg.Trust.Bundle, "cell-ca.pem": d.cfg.Trust.CellCA} {
			raw, err := os.ReadFile(src) //nolint:gosec // G304: the cell's own trust files
			if err != nil {
				return vmFiles{}, err
			}
			f.files[name] = raw
		}
		f.mounts["ca-bundle.pem"], f.mounts["cell-ca.pem"] = machinetrust.BundleTarget, machinetrust.CellCATarget
		f.env = machinetrust.Env(machinetrust.BundleTarget, machinetrust.CellCATarget)
	}
	return f, nil
}

// renderForVM is the cell's compose file as the claim's VM runs it: every
// container port a service lists without a host port published on the VM
// at the same number (the observer finds it there after every up, reset
// and restore; ports the file maps stay as they are), the cell's files
// bound read-only into every service with their env over the file's, and
// the mirror's build args added to every build (the project's own win).
// builds reports whether any service builds an image.
func renderForVM(composeFile []byte, f vmFiles, mirror buildmirror.Mirror) (out []byte, builds bool, err error) {
	var doc map[string]any
	if err := yaml.Unmarshal(composeFile, &doc); err != nil {
		return nil, false, fmt.Errorf("microvm: compose file: %w", err)
	}
	services, _ := doc["services"].(map[string]any)
	for _, raw := range services {
		svc, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if b, ok := svc["build"]; ok && b != nil {
			builds = true
			if svc["build"], err = withMirrorArgs(b, mirror); err != nil {
				return nil, false, err
			}
		}
		ports, _ := svc["ports"].([]any)
		for i, p := range ports {
			switch v := p.(type) {
			case string:
				port, proto, _ := strings.Cut(v, "/")
				if _, err := strconv.Atoi(port); err == nil {
					pinned := port + ":" + port
					if proto != "" {
						pinned += "/" + proto
					}
					ports[i] = pinned
				}
			case int:
				ports[i] = strconv.Itoa(v) + ":" + strconv.Itoa(v)
			case map[string]any:
				if _, has := v["published"]; !has && v["target"] != nil {
					v["published"] = fmt.Sprint(v["target"])
				}
			}
		}
		vols, _ := svc["volumes"].([]any)
		for name, target := range f.mounts {
			vols = append(vols, map[string]any{"type": "bind", "source": "./" + cellFilesDir + "/" + name, "target": target, "read_only": true})
		}
		if len(vols) > 0 {
			svc["volumes"] = vols
		}
		if len(f.env) > 0 {
			env := map[string]any{}
			switch e := svc["environment"].(type) {
			case map[string]any:
				env = e
			case []any:
				for _, kv := range e {
					k, v, _ := strings.Cut(fmt.Sprint(kv), "=")
					env[k] = v
				}
			}
			for k, v := range f.env {
				env[k] = v
			}
			svc["environment"] = env
		}
	}
	out, err = yaml.Marshal(doc)
	return out, builds, err
}

// withMirrorArgs is a service's build section with the mirror's build args
// (buildmirror.Mirror.Args): a context given as a string becomes the long
// form, and args given as a list or a map keep every value of the file's.
// With no mirror the section stays as the file wrote it.
func withMirrorArgs(build any, mirror buildmirror.Mirror) (any, error) {
	if mirror == (buildmirror.Mirror{}) {
		return build, nil
	}
	var b map[string]any
	switch v := build.(type) {
	case string:
		b = map[string]any{"context": v}
	case map[string]any:
		b = v
	default:
		return nil, fmt.Errorf("microvm: a build section is neither a context nor a map")
	}
	own := map[string]string{}
	switch a := b["args"].(type) {
	case nil:
	case map[string]any:
		for k, v := range a {
			if v == nil {
				own[k] = ""
				continue
			}
			own[k] = fmt.Sprint(v)
		}
	case []any:
		for _, kv := range a {
			k, v, _ := strings.Cut(fmt.Sprint(kv), "=")
			own[k] = v
		}
	default:
		return nil, fmt.Errorf("microvm: a build's args are neither a list nor a map")
	}
	args := mirror.Args(own)
	if len(args) == 0 {
		return b, nil
	}
	out := make(map[string]any, len(args))
	for k, v := range args {
		out[k] = v
	}
	b["args"] = out
	return b, nil
}

// Targets points each exposed port at the workload VM's address on that
// port, where its compose project publishes it (pinPorts).
func (d *Driver) Targets(ctx context.Context, workload string, in []observer.Target) ([]observer.Target, error) {
	m, ok, err := d.find(ctx, workload)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("microvm: no machine %s", workload)
	}
	ip := m.Addresses[networkName(m.Labels[driver.TagClaim])]
	if ip == "" {
		return nil, fmt.Errorf("microvm: machine %s has no address on its claim's network", workload)
	}
	out := make([]observer.Target, 0, len(in))
	for _, t := range in {
		t.Address = net.JoinHostPort(ip, strconv.Itoa(t.Port))
		out = append(out, t)
	}
	return out, nil
}

// DialObserver opens a stream to the claim's observer over its VM's vsock.
func (d *Driver) DialObserver(ctx context.Context, machine string) (net.Conn, error) {
	m, ok, err := d.find(ctx, machine)
	if err != nil || !ok {
		return nil, errors.Join(err, fmt.Errorf("microvm: no observer machine %s", machine))
	}
	if m.Labels[driver.TagRole] != string(driver.RoleObserver) {
		return nil, fmt.Errorf("microvm: %s is not an observer", machine)
	}
	return d.cfg.Backend.DialVsock(ctx, machine, ObserverVsockPort)
}

// startObserver lays the observer's TLS files in its VM and starts the
// guest agent's observer mode there, in the background.
func (d *Driver) startObserver(ctx context.Context, ref driver.MachineRef) error {
	if d.cfg.ObserverTLSDir == "" {
		return errors.New("microvm: an observer machine needs the observer TLS directory")
	}
	c, err := d.guestOf(ctx, ref)
	if err != nil {
		return err
	}
	defer func() { _ = c.Close() }()
	for _, f := range []string{"cert.pem", "key.pem", "ca.pem"} {
		raw, err := os.ReadFile(filepath.Join(d.cfg.ObserverTLSDir, f)) //nolint:gosec // G304: the operator's observer TLS directory
		if err != nil {
			return fmt.Errorf("microvm: observer TLS: %w", err)
		}
		p, content := observerDir+"/"+f, base64.StdEncoding.EncodeToString(raw)
		mode := int64(0o600)
		if r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindWrite, Path: &p, Content: &content, Mkdirs: ptr(true), Mode: &mode}); err != nil || !r.Ok {
			return errors.Join(err, fmt.Errorf("microvm: observer TLS into %s: %s", ref.MachineID, opError(r)))
		}
	}
	cmd := "nohup " + guestinit.AgentPath + " observer -vsock " + strconv.Itoa(ObserverVsockPort) + " -cell-id " + composecmd.ShellQuote(d.cfg.CellID) +
		" -cert " + observerDir + "/cert.pem -key " + observerDir + "/key.pem -ca " + observerDir + "/ca.pem >" + observerDir + "/log 2>&1 &"
	timeout := int64(10_000)
	r, err := c.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &cmd, TimeoutMs: &timeout})
	if err != nil || !r.Ok || r.Exec == nil || r.Exec.ExitCode != 0 {
		return errors.Join(err, fmt.Errorf("microvm: start the observer in %s: %s %s", ref.MachineID, opError(r), stderrOf(r)))
	}
	return nil
}

// RunRecipe runs the recipe's boot steps in the claim's project in its VM
// (setup and data.migrate in the public service, data.seed as its form
// says), as docker-gvisor does on the host's Docker: each in a service
// container, never on the cell host. A seed the compose file already binds
// into postgres's initdb runs with the database's own first start. Each
// step's lines reach output when the step ends.
func (d *Driver) RunRecipe(ctx context.Context, ref driver.MachineRef, projectDir string, output func(line string)) error {
	rec, err := recipe.Load(projectDir)
	if err != nil {
		return fmt.Errorf("%w: %w", driver.ErrWorkloadRecipe, err)
	}
	if rec == nil {
		return nil
	}
	dir, err := d.guestDir(ref.MachineID, projectDir)
	if err != nil {
		return err
	}
	project := composecmd.Project{Name: projectName(ref), File: composeFileName}
	inService := func(service, script string) string {
		return composecmd.DockerLine(project.Exec(service, "sh", "-c", script))
	}
	public := rec.Services.Compose.Primary()
	run := func(step, field, cmd string) error {
		r, err := d.Exec(ctx, ref, kodyexec.Request{Command: cmd, Cwd: dir, TimeoutMs: upTimeout})
		emitLines(output, r.Stderr, r.Stdout)
		if err == nil && r.ExitCode != 0 {
			err = fmt.Errorf("exit %d: %s", r.ExitCode, tailOf(r.Stderr, 1000))
		}
		if err != nil {
			if full := d.diskFull(ctx, ref, err); errors.Is(full, driver.ErrDiskCapacity) {
				return full
			}
			return &driver.RecipeStepError{Step: step, Field: field, Err: fmt.Errorf("%w: %w", driver.ErrWorkloadBoot, err)}
		}
		return nil
	}
	for i, s := range rec.Setup {
		if err := run("setup", fmt.Sprintf("setup[%d]", i+1), inService(public, s)); err != nil {
			return err
		}
	}
	if rec.Data.Migrate != "" {
		if err := run("migrate", "data.migrate", inService(public, rec.Data.Migrate)); err != nil {
			return err
		}
	}
	seed := rec.Data.Seed
	d.mu.Lock()
	atInit := d.initdb[ref.MachineID][path.Clean(seed.SQL)]
	d.mu.Unlock()
	switch {
	case seed.IsZero():
	case seed.SQL != "":
		if atInit {
			return nil
		}
		user, db := seed.User, seed.Database
		cmd := composecmd.DockerLine(project.Exec(seed.Service, "psql", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", db)) + " < " + composecmd.ShellQuote(seed.SQL)
		return run("seed", "data.seed", cmd)
	case seed.Service != "":
		return run("seed", "data.seed", inService(seed.Service, seed.Command))
	default:
		return run("seed", "data.seed", inService(public, seed.Command))
	}
	return nil
}

func tailOf(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

// initdbBinds are the project's files the compose file binds into
// postgres's /docker-entrypoint-initdb.d, relative to the project.
func initdbBinds(composeFile []byte) map[string]bool {
	var doc struct {
		Services map[string]struct {
			Volumes []any `yaml:"volumes"`
		} `yaml:"services"`
	}
	out := map[string]bool{}
	if yaml.Unmarshal(composeFile, &doc) != nil {
		return out
	}
	for _, s := range doc.Services {
		for _, v := range s.Volumes {
			src, target := "", ""
			switch x := v.(type) {
			case string:
				parts := strings.Split(x, ":")
				if len(parts) >= 2 {
					src, target = parts[0], parts[1]
				}
			case map[string]any:
				src, _ = x["source"].(string)
				target, _ = x["target"].(string)
			}
			if strings.HasPrefix(path.Clean(target), "/docker-entrypoint-initdb.d") && strings.HasSuffix(src, ".sql") {
				out[path.Clean(strings.TrimPrefix(src, "./"))] = true
			}
		}
	}
	return out
}

// Reset takes the claim's project down with its volumes in its VM (kind
// compose_volumes); the agent brings it up again and runs the recipe. A
// round's reset (kind memory) goes through ResetToSnapshot instead.
func (d *Driver) Reset(ctx context.Context, ref driver.MachineRef, snap driver.SnapshotRef) error {
	if snap.Kind != string(protocol.SnapshotKindComposeVolumes) {
		return fmt.Errorf("%w: microvm resets compose volumes here; a round goes through its snapshot", driver.ErrUnsupported)
	}
	r, err := d.Exec(ctx, ref, kodyexec.Request{Command: composecmd.DockerLine(composecmd.Down(projectName(ref), true)), TimeoutMs: 300_000})
	if err == nil && r.ExitCode != 0 {
		err = fmt.Errorf("compose down exited %d: %s", r.ExitCode, tailOf(r.Stderr, 1000))
	}
	return err
}

// TemplateKey is the key of an environment's template: the newest setup's
// bake replaces the others.
func TemplateKey(env string) string {
	h := sha256.Sum256([]byte(env))
	return "env-" + hex.EncodeToString(h[:8])
}

// PinBakeSource keeps the setup's workload machine for the bake that takes
// it as the environment's template: its Destroy (the claim's release) and
// its network's removal wait for the bake.
func (d *Driver) PinBakeSource(ctx context.Context, ref driver.MachineRef) error {
	if _, ok, err := d.find(ctx, ref.MachineID); err != nil || !ok {
		return errors.Join(err, notFound(ok, ref))
	}
	d.mu.Lock()
	d.pinned[ref.MachineID] = true
	d.mu.Unlock()
	return nil
}

// Bake keeps the setup's pinned machine as the environment's template
// (purpose template, key the environment's); the image id is the
// snapshot's. The machine ends, and its network goes if its claim was
// released meanwhile.
func (d *Driver) Bake(ctx context.Context, spec driver.BakeSpec) (driver.ImageRef, error) {
	if !d.bakes() {
		return driver.ImageRef{}, fmt.Errorf("%w: this backend keeps no environment template", driver.ErrUnsupported)
	}
	src := spec.Source.MachineID
	d.mu.Lock()
	pinned := d.pinned[src]
	d.mu.Unlock()
	if !pinned {
		return driver.ImageRef{}, fmt.Errorf("microvm: the bake's source %s is not pinned", src)
	}
	defer func() {
		d.mu.Lock()
		delete(d.pinned, src)
		pending := d.pendingNets[networkOfMachine(src)]
		delete(d.pendingNets, networkOfMachine(src))
		d.mu.Unlock()
		_ = d.Destroy(context.WithoutCancel(ctx), spec.Source)
		if pending.WorkloadGroupID != "" {
			_ = d.ReleaseClaim(context.WithoutCancel(ctx), pending)
		}
	}()
	// The setup's data disk peak sizes the environment's next machines.
	d.measureNeed(spec.Source, spec.OrgID, spec.EnvironmentID)
	snap, err := d.snapshot(ctx, spec.Source, isolation.PurposeTemplate, TemplateKey(spec.EnvironmentID))
	if err != nil {
		return driver.ImageRef{}, err
	}
	return driver.ImageRef{ImageID: snap.ID, DriverRef: snap.ID}, nil
}

// networkOfMachine is the claim network of a machine kodus-<claim>-<role>.
func networkOfMachine(machine string) string {
	i := strings.LastIndex(machine, "-")
	if i < 0 {
		return ""
	}
	return machine[:i]
}

// emitLines gives output every line of what a command printed in the VM;
// nothing without an output.
func emitLines(output func(line string), texts ...string) {
	if output == nil {
		return
	}
	for _, text := range texts {
		for line := range strings.Lines(text) {
			if line = strings.TrimRight(line, "\r\n"); line != "" {
				output(line)
			}
		}
	}
}

package dockergvisor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/browser"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// BrowserRunner starts the browser runner image (apps/runtime-cell/
// browser-runner, ADR-071) for one probe round: under the driver's runtime
// (runsc), on the claim's network only, as uid 10001 with a read-only root,
// no capability and a memory, CPU and pid bound. The page reaches the app
// by one name (browser.AppHost) mapped to the exposed service's fixed
// address; DNS is the claim's resolver, and the cell's egress refuses this
// container as a source, so nothing outside the claim's services answers.
// The job goes in on stdin, the artifacts come out as a tar on stdout: no
// host path is mounted but the claim's resolv.conf.
type BrowserRunner struct {
	Driver *Driver
	// Image is the runner image, pinned by digest (repo@sha256:...).
	Image string
	// Memory and CPUs bound the container ("1g", "1" when empty).
	Memory, CPUs string
	// Exec runs the docker argv with stdin and stdout; nil: the docker
	// binary with the minimal environment. Tests record.
	Exec func(ctx context.Context, args []string, stdin []byte, stdout io.Writer) error
	// Now stamps the container's ceiling (kodus:hard-expires); nil: time.Now.
	Now func() time.Time
}

var _ browser.Runner = BrowserRunner{}

var digestRef = regexp.MustCompile(`^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$`)

// CheckBrowserImage refuses a runner image that is not pinned by digest.
func CheckBrowserImage(ref string) error {
	if !digestRef.MatchString(ref) {
		return fmt.Errorf("dockergvisor: browser image %q is not pinned by digest (repo@sha256:...)", ref)
	}
	return nil
}

// browserUser is the runner image's own user (Dockerfile).
const browserUser = "10001:10001"

// exitJobRefused is the runner's exit status for a job outside the closed list.
const exitJobRefused = 2

func (r BrowserRunner) Run(ctx context.Context, spec browser.RunSpec, job []byte, out io.Writer) error {
	if err := driver.ValidateClaimID(spec.ClaimID); err != nil {
		return err
	}
	if err := CheckBrowserImage(r.Image); err != nil {
		return err
	}
	d := r.Driver
	ip, ok := d.peek(spec.Workload).services[spec.Service]
	if !ok {
		return fmt.Errorf("dockergvisor: service %s is not up in %s", spec.Service, spec.Workload)
	}
	if exists, err := d.owned(ctx, spec.Workload); err != nil {
		return err
	} else if !exists {
		return fmt.Errorf("dockergvisor: %s has no machine", spec.Workload)
	}
	parent, err := d.parentFor(ctx, driver.MachineRef{MachineID: spec.Workload})
	if err != nil {
		return err
	}
	network := d.claimNetwork(spec.ClaimID)
	resolv, err := d.claimResolv(network)
	if err != nil {
		return err
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	name := "kodus-browser-" + strings.ToLower(spec.ClaimID) + "-" + fmt.Sprint(now().UnixNano())
	args := browserArgs(browserOpts{
		CgroupParent: parent, Name: name, Image: r.Image, Runtime: d.cfg.Runtime, Network: network, Resolv: resolv,
		Host: browser.AppHost, IP: ip, Memory: orDefault(r.Memory, "1g"), CPUs: orDefault(r.CPUs, "1"),
		Labels: toLabels(map[string]string{
			driver.TagCell: d.cfg.CellID, driver.TagClaim: spec.ClaimID, driver.TagRole: "browser",
			// The sweep removes it past this, whatever happened to the cell.
			driver.TagHardExpires: now().Add(spec.Deadline).UTC().Format(time.RFC3339),
		}),
	})
	run := r.Exec
	if run == nil {
		run = dockerStream
	}
	err = run(ctx, args, job, out)
	// `docker run --rm` ends the container with the client, unless the client
	// was killed (a cancelled round): remove it either way.
	cleanup, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancelCleanup()
	if rmErr := r.remove(cleanup, name); rmErr != nil && err == nil && ctx.Err() == nil {
		d.log().Warn("browser.remove.failed", "container", name, "err", rmErr)
	}
	if code, ok := dockercli.ExitCode(err); ok && code == exitJobRefused {
		return browser.ErrJobRefused
	}
	return err
}

func (r BrowserRunner) remove(ctx context.Context, name string) error {
	if r.Exec != nil {
		return r.Exec(ctx, []string{"rm", "-f", name}, nil, io.Discard)
	}
	return dockerStream(ctx, []string{"rm", "-f", name}, nil, io.Discard)
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

type browserOpts struct {
	CgroupParent                                                  string
	Name, Image, Runtime, Network, Resolv, Host, IP, Memory, CPUs string
	Labels                                                        map[string]string
}

// browserArgs is the docker argv of one runner container.
func browserArgs(o browserOpts) []string {
	args := []string{"run", "--rm", "-i", "--name", o.Name,
		"--network", o.Network,
		"--add-host", o.Host + ":" + o.IP,
		"--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=1g",
		"--user", browserUser, "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
		"--pids-limit", "512", "--memory", o.Memory, "--memory-swap", o.Memory, "--cpus", o.CPUs,
		"--log-driver", "none",
	}
	if o.Runtime != "" {
		args = append(args, "--runtime", o.Runtime)
	}
	if o.Resolv != "" {
		args = append(args, "-v", o.Resolv+":/etc/resolv.conf:ro")
	}
	for _, k := range sortedLabelKeys(o.Labels) {
		args = append(args, "--label", k+"="+o.Labels[k])
	}
	if o.CgroupParent != "" {
		args = append(args, "--cgroup-parent", o.CgroupParent)
	}
	return append(args, o.Image)
}

func sortedLabelKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// stderrTail is how much of the runner's stderr an error carries.
const stderrTail = 4 << 10

type tailBuf struct{ b []byte }

func (t *tailBuf) Write(p []byte) (int, error) {
	t.b = append(t.b, p...)
	if len(t.b) > stderrTail {
		t.b = t.b[len(t.b)-stderrTail:]
	}
	return len(p), nil
}

// dockerStream runs docker with stdin and stdout streamed, the minimal
// environment, and the stderr tail (redacted) in its error.
func dockerStream(ctx context.Context, args []string, stdin []byte, stdout io.Writer) error {
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Env = dockercli.MinimalEnv()
	if stdin != nil {
		cmd.Stdin = strings.NewReader(string(stdin))
	}
	var stderr tailBuf
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	err := cmd.Run()
	if err == nil {
		return nil
	}
	msg, _ := redact.Patterns(strings.TrimSpace(string(stderr.b)))
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return &dockercli.ExitError{Command: "docker " + args[0], Code: exit.ExitCode(), Stderr: msg, Err: err}
	}
	return fmt.Errorf("docker %s: %w: %s", args[0], err, msg)
}

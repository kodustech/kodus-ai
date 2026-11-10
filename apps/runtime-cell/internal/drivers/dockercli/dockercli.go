// Package dockercli is the one adapter to the docker binary both Docker
// drivers use (docker-gvisor and the dev-only local-docker).
//
// A command gets a minimal environment unless the caller hands it one:
// docker compose interpolates ${VAR} in the compose file from its own
// environment, and the cell's environment holds the cell's credentials.
// Output is bounded: a build or a crashing container can print without end,
// and that text (redacted) only ever reaches an error message in part.
package dockercli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// CommandRunner runs a command; ExecCommand uses exec, tests record.
type CommandRunner func(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error)

const (
	// maxStdout bounds what a command may answer (ps, inspect, config).
	maxStdout = 32 << 20
	// stderrTail is how much of stderr an error carries.
	stderrTail = 4 << 10
)

// passEnv are the variables a docker command keeps by default: how to reach
// the daemon and where the binaries are, nothing else.
var passEnv = []string{"PATH", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR"}

// MinimalEnv is the environment ExecCommand gives docker by default.
func MinimalEnv() []string {
	var env []string
	for _, k := range passEnv {
		if v, ok := os.LookupEnv(k); ok {
			env = append(env, k+"="+v)
		}
	}
	// docker wants a HOME; the cell's own is not needed.
	return append(env, "HOME="+os.TempDir())
}

// ExecCommandWith returns a runner that gives every command env.
func ExecCommandWith(env []string) CommandRunner {
	return func(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		cmd.Env = env
		if stdin != nil {
			cmd.Stdin = bytes.NewReader(stdin)
		}
		stdout := &capped{max: maxStdout}
		stderr := &tail{max: stderrTail}
		cmd.Stdout, cmd.Stderr = stdout, stderr
		if sink := driver.OutputFrom(ctx); sink != nil {
			// A build's progress and compose's messages go to stderr.
			lw := &lineWriter{sink: sink}
			cmd.Stderr = io.MultiWriter(stderr, lw)
			defer lw.flush()
		}
		err := cmd.Run()
		if err == nil && stdout.over {
			err = fmt.Errorf("output past %d bytes", maxStdout)
		}
		if err != nil {
			msg, _ := redact.Patterns(strings.TrimSpace(stderr.String()))
			command := name + " " + strings.Join(args, " ")
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				return stdout.Bytes(), &ExitError{Command: command, Code: exit.ExitCode(), Stderr: msg, Err: err}
			}
			return stdout.Bytes(), fmt.Errorf("%s: %w: %s", command, err, msg)
		}
		return stdout.Bytes(), nil
	}
}

// ExitError is a command that ran and exited unsuccessfully. Code is its
// exit status (-1 when a signal ended it); for `docker run` that is the
// container's own, so a caller can tell why the container ended without
// reading the message.
type ExitError struct {
	Command string
	Code    int
	// Stderr is the redacted tail of what the command printed.
	Stderr string
	// Err is the *exec.ExitError the command ended with; nil when a test
	// makes one.
	Err error
}

func (e *ExitError) Error() string {
	status := fmt.Sprintf("exit status %d", e.Code)
	if e.Err != nil {
		status = e.Err.Error()
	}
	return fmt.Sprintf("%s: %s: %s", e.Command, status, e.Stderr)
}

func (e *ExitError) Unwrap() error { return e.Err }

// ExitKilled is the status of a process ended by SIGKILL (128 + 9): for a
// container with a memory limit, the kernel's OOM killer.
const ExitKilled = 137

// ExitCode is the exit status of the command err came from, when it ran and
// exited; false when it never ran, or err is not a command's.
func ExitCode(err error) (int, bool) {
	var e *ExitError
	if errors.As(err, &e) {
		return e.Code, true
	}
	return 0, false
}

// ExecCommand runs docker with MinimalEnv.
func ExecCommand(ctx context.Context, stdin []byte, name string, args ...string) ([]byte, error) {
	return ExecCommandWith(MinimalEnv())(ctx, stdin, name, args...)
}

type capped struct {
	bytes.Buffer
	max  int
	over bool
}

func (c *capped) Write(p []byte) (int, error) {
	if room := c.max - c.Len(); room < len(p) {
		c.over = true
		c.Buffer.Write(p[:max(room, 0)])
		return len(p), nil
	}
	return c.Buffer.Write(p)
}

// lineWriter hands each complete line to sink (claim.progress). A line
// longer than maxLine is cut, never buffered without bound.
type lineWriter struct {
	sink func(string)
	buf  []byte
}

const maxLine = 2048

func (w *lineWriter) Write(p []byte) (int, error) {
	for _, b := range p {
		if b == '\n' {
			w.emit()
			continue
		}
		if len(w.buf) < maxLine {
			w.buf = append(w.buf, b)
		}
	}
	return len(p), nil
}

func (w *lineWriter) emit() {
	if len(w.buf) > 0 {
		w.sink(strings.TrimRight(string(w.buf), "\r"))
	}
	w.buf = w.buf[:0]
}

func (w *lineWriter) flush() { w.emit() }

// tail keeps the last max bytes written.
type tail struct {
	buf []byte
	max int
}

func (t *tail) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = append([]byte(nil), t.buf[len(t.buf)-t.max:]...)
	}
	return len(p), nil
}

func (t *tail) String() string { return string(t.buf) }

// CLI talks to the host's Docker through the docker binary.
type CLI struct {
	Bin string
	// Run runs the binary; nil: ExecCommand (minimal environment).
	Run CommandRunner
	// ExecRun runs a docker exec argv under host's limits; nil: the docker
	// binary through kodyexec.RunArgv. Tests record.
	ExecRun func(ctx context.Context, args []string, host kodyexec.Request) kodyexec.Result
}

func (c CLI) run(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	bin := c.Bin
	if bin == "" {
		bin = "docker"
	}
	r := c.Run
	if r == nil {
		r = ExecCommand
	}
	return r(ctx, stdin, bin, args...)
}

// Container is one container as Docker inspects it.
type Container struct {
	ID     string
	Name   string
	Image  string
	Labels map[string]string
	// Networks maps each network name to the container's address on it.
	Networks map[string]string
	// WorkingDir is the image's working directory ("" when it sets none).
	WorkingDir string
	// StartedAt is when its process last started (zero: never started).
	StartedAt time.Time
	// CgroupParent and PID are facts from the daemon, used to verify the
	// trusted parent against the local kernel before customer code starts.
	CgroupParent string
	PID          int
	// Mounts are its mounts as Docker made them: an anonymous volume shows
	// here under the name Docker gave it.
	Mounts []Mount
}

// Mount is one mount of a container.
type Mount struct {
	Type        string // volume, bind, tmpfs
	Name        string // the volume's name (type volume)
	Destination string
}

// IP is the container's address when it is on exactly one network, or on
// network when given.
func (c Container) IP(network string) string {
	if network != "" {
		return c.Networks[network]
	}
	if len(c.Networks) == 1 {
		for _, ip := range c.Networks {
			return ip
		}
	}
	return ""
}

func labelArgs(labels map[string]string) []string {
	var out []string
	for _, k := range sortedKeys(labels) {
		out = append(out, "--label", k+"="+labels[k])
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (c CLI) Version(ctx context.Context) (string, error) {
	out, err := c.run(ctx, nil, "version", "--format", "{{.Server.Version}}")
	return strings.TrimSpace(string(out)), err
}

func (c CLI) Runtimes(ctx context.Context) ([]string, error) {
	out, err := c.run(ctx, nil, "info", "--format", "{{json .Runtimes}}")
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		return nil, err
	}
	rts := make([]string, 0, len(m))
	for k := range m {
		rts = append(rts, k)
	}
	sort.Strings(rts)
	return rts, nil
}

// APIVersion is the daemon's API version ("1.52").
func (c CLI) APIVersion(ctx context.Context) (string, error) {
	out, err := c.run(ctx, nil, "version", "--format", "{{.Server.APIVersion}}")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// SecurityOptions are the daemon's security options as docker info lists
// them ("name=seccomp,profile=builtin", "name=userns", "name=rootless").
func (c CLI) SecurityOptions(ctx context.Context) ([]string, error) {
	out, err := c.run(ctx, nil, "info", "--format", "{{json .SecurityOptions}}")
	if err != nil {
		return nil, err
	}
	var opts []string
	if err := json.Unmarshal(out, &opts); err != nil {
		return nil, fmt.Errorf("dockercli: security options: %w", err)
	}
	return opts, nil
}

// HolderSpec is the claim's holder container: runsc, the claim's network,
// no capabilities, no new privileges, a read-only root and a pids limit.
type HolderSpec struct {
	Name, Image, Network, Runtime string
	// CgroupParent is the cell's aggregate resource parent, never repo input.
	CgroupParent string
	PidsLimit    int
	Labels       map[string]string
	// Resolv is the cell's resolv.conf for the claim, mounted read-only:
	// the holder resolves through the cell resolver alone.
	Resolv string
	// Mounts are more read-only binds, "host:container" (the observer's
	// certificates); the cell's own directories, never the checkout.
	Mounts []string
	// Cmd replaces `sleep infinity` (the observer's server).
	Cmd []string
	// AlsoOn are more networks, joined before the container starts: gVisor
	// sets a sandbox's interfaces up at start and takes no network later.
	AlsoOn []string
}

func (c CLI) RunHolder(ctx context.Context, h HolderSpec) (Container, error) {
	if err := ValidateCgroupParent(h.CgroupParent); err != nil {
		return Container{}, err
	}
	pids := h.PidsLimit
	if pids == 0 {
		pids = 2048
	}
	verb := []string{"run", "-d"}
	if len(h.AlsoOn) > 0 {
		verb = []string{"create"}
	}
	args := []string{verb[0]}
	args = append(args, verb[1:]...)
	args = append(args, "--name", h.Name, "--runtime", h.Runtime, "--network", h.Network,
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
		"--pids-limit", strconv.Itoa(pids), "--tmpfs", "/tmp", "--tmpfs", "/workspace")
	if h.CgroupParent != "" {
		args = append(args, "--cgroup-parent", h.CgroupParent)
	}
	if h.Resolv != "" {
		args = append(args, "-v", h.Resolv+":/etc/resolv.conf:ro")
	}
	for _, m := range h.Mounts {
		args = append(args, "-v", m+":ro")
	}
	args = append(args, labelArgs(h.Labels)...)
	cmd := h.Cmd
	if len(cmd) == 0 {
		cmd = []string{"sleep", "infinity"}
	}
	args = append(append(args, h.Image), cmd...)
	out, err := c.run(ctx, nil, args...)
	if err != nil {
		return Container{}, err
	}
	id := strings.TrimSpace(string(out))
	if len(h.AlsoOn) > 0 {
		for _, n := range h.AlsoOn {
			if _, err = c.run(ctx, nil, "network", "connect", n, id); err != nil {
				break
			}
		}
		if err == nil {
			_, err = c.run(ctx, nil, "start", id)
		}
		if err != nil {
			_, rerr := c.run(context.WithoutCancel(ctx), nil, "rm", "-f", id)
			return Container{}, errors.Join(err, rerr)
		}
	}
	cs, err := c.Inspect(ctx, id)
	if err != nil {
		return Container{}, err
	}
	if len(cs) != 1 {
		return Container{}, fmt.Errorf("dockercli: holder %s not found after run", h.Name)
	}
	return cs[0], nil
}

func (c CLI) Remove(ctx context.Context, name string) error {
	_, err := c.run(ctx, nil, "rm", "-f", name)
	return err
}

// Filters are docker ps filters, by kind ("label", "name"); a label value
// "k" (no '=') matches any container carrying the key.
type Filters map[string][]string

// IDs lists the ids of every container (running or not) matching filters.
func (c CLI) IDs(ctx context.Context, f Filters) ([]string, error) {
	args := []string{"ps", "-aq", "--no-trunc"}
	kinds := make([]string, 0, len(f))
	for k := range f {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	for _, k := range kinds {
		vals := append([]string(nil), f[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			args = append(args, "--filter", k+"="+v)
		}
	}
	out, err := c.run(ctx, nil, args...)
	if err != nil {
		return nil, err
	}
	return strings.Fields(string(out)), nil
}

// Inspect reads containers as JSON: labels come back as a map, so a label
// value with a comma cannot forge another label (ps --format joins them).
func (c CLI) Inspect(ctx context.Context, ids ...string) ([]Container, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	out, err := c.run(ctx, nil, append([]string{"inspect", "--type", "container"}, ids...)...)
	if err != nil {
		return nil, err
	}
	var raw []struct {
		ID     string `json:"Id"`
		Name   string `json:"Name"`
		Config struct {
			Image      string            `json:"Image"`
			Labels     map[string]string `json:"Labels"`
			WorkingDir string            `json:"WorkingDir"`
		} `json:"Config"`
		NetworkSettings struct {
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
		State struct {
			StartedAt string `json:"StartedAt"`
			PID       int    `json:"Pid"`
		} `json:"State"`
		HostConfig struct {
			CgroupParent string `json:"CgroupParent"`
		} `json:"HostConfig"`
		Mounts []struct {
			Type        string `json:"Type"`
			Name        string `json:"Name"`
			Destination string `json:"Destination"`
		} `json:"Mounts"`
	}
	if err := json.Unmarshal(out, &raw); err != nil {
		return nil, fmt.Errorf("dockercli: inspect: %w", err)
	}
	cs := make([]Container, 0, len(raw))
	for _, r := range raw {
		nets := map[string]string{}
		for name, n := range r.NetworkSettings.Networks {
			nets[name] = n.IPAddress
		}
		labels := r.Config.Labels
		if labels == nil {
			labels = map[string]string{}
		}
		// Docker writes 0001-01-01T00:00:00Z for a container never started.
		started, _ := time.Parse(time.RFC3339Nano, r.State.StartedAt)
		if started.Year() <= 1 {
			started = time.Time{}
		}
		var mounts []Mount
		for _, m := range r.Mounts {
			mounts = append(mounts, Mount{Type: m.Type, Name: m.Name, Destination: m.Destination})
		}
		cs = append(cs, Container{ID: r.ID, Name: strings.TrimPrefix(r.Name, "/"), Image: r.Config.Image, Labels: labels, Networks: nets, WorkingDir: r.Config.WorkingDir, StartedAt: started, CgroupParent: r.HostConfig.CgroupParent, PID: r.State.PID, Mounts: mounts})
	}
	return cs, nil
}

// List is every container carrying all of labels, inspected.
func (c CLI) List(ctx context.Context, labels map[string]string) ([]Container, error) {
	f := Filters{}
	for _, k := range sortedKeys(labels) {
		if labels[k] == "" {
			f["label"] = append(f["label"], k)
		} else {
			f["label"] = append(f["label"], k+"="+labels[k])
		}
	}
	ids, err := c.IDs(ctx, f)
	if err != nil {
		return nil, err
	}
	return c.Inspect(ctx, ids...)
}

// ComposeProject is a compose project as a command names it.
type ComposeProject struct {
	Name string
	// Dir is the project directory relative paths resolve in.
	Dir string
	// File is the compose file the cell wrote.
	File string
	// EnvFile is the interpolation file: os.DevNull for none at all; ""
	// lets compose read the project directory's .env (local-docker only).
	EnvFile string
	// Services, when set, is what ComposeUp starts: these and what they
	// depend on, nothing else.
	Services []string
}

func (p ComposeProject) args() []string {
	args := []string{"compose", "-p", p.Name, "--project-directory", p.Dir, "-f", p.File}
	if p.EnvFile != "" {
		args = append(args, "--env-file", p.EnvFile)
	}
	return args
}

// ComposeConfig is the project as compose will run it, canonical JSON:
// interpolated, merged, every short syntax spelled out.
func (c CLI) ComposeConfig(ctx context.Context, p ComposeProject) ([]byte, error) {
	return c.run(ctx, nil, append(p.args(), "config", "--format", "json")...)
}

// ComposeUp is up -d --wait with no build and nothing orphaned.
func (c CLI) ComposeUp(ctx context.Context, p ComposeProject) error {
	_, err := c.run(ctx, nil, append(append(p.args(), "up", "-d", "--no-build", "--wait", "--remove-orphans"), p.Services...)...)
	return err
}

// ComposeBuild builds the project's images, then pulls the missing images
// of pullServices (local-docker only: the gVisor driver never builds).
func (c CLI) ComposeBuild(ctx context.Context, p ComposeProject, pullServices []string) error {
	if _, err := c.run(ctx, nil, append(p.args(), "build", "-q")...); err != nil {
		return err
	}
	if len(pullServices) == 0 {
		return nil
	}
	_, err := c.run(ctx, nil, append(append(p.args(), "pull", "-q", "--policy", "missing"), pullServices...)...)
	return err
}

// ComposeDown works from the project name alone: a destroy may come after a
// restart, with no compose file at hand.
func (c CLI) ComposeDown(ctx context.Context, project string, volumes bool) error {
	args := []string{"compose", "-p", project, "down", "--remove-orphans"}
	if volumes {
		args = append(args, "-v")
	}
	_, err := c.run(ctx, nil, args...)
	return err
}

func (c CLI) ComposeStop(ctx context.Context, project string) error {
	_, err := c.run(ctx, nil, "compose", "-p", project, "stop")
	return err
}

func (c CLI) ComposeStart(ctx context.Context, project string) error {
	_, err := c.run(ctx, nil, "compose", "-p", project, "start")
	return err
}

func (c CLI) ComposeExec(ctx context.Context, project, service string, stdin []byte, cmd ...string) error {
	_, err := c.run(ctx, stdin, append([]string{"compose", "-p", project, "exec", "-T", service}, cmd...)...)
	return err
}

// ExecInput runs argv in the container with stdin as its input (docker exec
// -i): a seed file piped to psql. It returns what the command printed on
// stdout; an error carries the redacted tail of its stderr (ExitError).
func (c CLI) ExecInput(ctx context.Context, container string, stdin []byte, argv ...string) ([]byte, error) {
	if stdin == nil {
		stdin = []byte{}
	}
	return c.run(ctx, stdin, append([]string{"exec", "-i", container}, argv...)...)
}

// ComposePort is the host address a service's container port is published
// on ("127.0.0.1:55001").
func (c CLI) ComposePort(ctx context.Context, project, service string, port int) (string, error) {
	out, err := c.run(ctx, nil, "compose", "-p", project, "port", service, strconv.Itoa(port))
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	return strings.TrimSpace(line), nil
}

func (c CLI) ComposePs(ctx context.Context, project string) ([]byte, error) {
	return c.run(ctx, nil, "compose", "-p", project, "ps", "-a", "--format", "json")
}

func (c CLI) ComposeLogs(ctx context.Context, project, service string, lines int) ([]byte, error) {
	return c.run(ctx, nil, "compose", "-p", project, "logs", "--no-color", "--no-log-prefix", "--tail", strconv.Itoa(lines), service)
}

// ComposeLogsWindow is what a service logged in [since, until], each line
// prefixed with the daemon's RFC 3339 timestamp (--timestamps), the last
// lines at most.
func (c CLI) ComposeLogsWindow(ctx context.Context, project, service string, since, until time.Time, lines int) ([]byte, error) {
	return c.run(ctx, nil, "compose", "-p", project, "logs", "--no-color", "--no-log-prefix", "--timestamps",
		"--since", since.UTC().Format(time.RFC3339Nano), "--until", until.UTC().Format(time.RFC3339Nano),
		"--tail", strconv.Itoa(lines), service)
}

// ParseTimestampedLogs reads compose logs --timestamps output: one
// "<RFC 3339 time> <text>" per line, oldest first. A line without a time
// (a continuation the daemon did not stamp) takes the previous line's.
func ParseTimestampedLogs(raw []byte) []TimedLine {
	var out []TimedLine
	var last time.Time
	for _, l := range strings.Split(strings.TrimRight(string(raw), "\n"), "\n") {
		if l == "" {
			continue
		}
		stamp, text, ok := strings.Cut(l, " ")
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if !ok || err != nil {
			out = append(out, TimedLine{At: last, Text: l})
			continue
		}
		last = at
		out = append(out, TimedLine{At: at, Text: text})
	}
	return out
}

// TimedLine is one log line and when the daemon stamped it.
type TimedLine struct {
	At   time.Time
	Text string
}

// RemoveImagesLabelled removes the images carrying label=value.
func (c CLI) RemoveImagesLabelled(ctx context.Context, label, value string) error {
	out, err := c.run(ctx, nil, "image", "ls", "-q", "--filter", "label="+label+"="+value)
	if err != nil {
		return err
	}
	ids := uniqueFields(out)
	if len(ids) == 0 {
		return nil
	}
	_, err = c.run(ctx, nil, append([]string{"image", "rm"}, ids...)...)
	return err
}

func uniqueFields(b []byte) []string {
	seen := map[string]bool{}
	var out []string
	for _, f := range strings.Fields(string(b)) {
		if !seen[f] {
			seen[f] = true
			out = append(out, f)
		}
	}
	return out
}

// NetworkCreate makes a bridge network with no IPv6. An internal network
// also gets no address on the host's side of the bridge
// (inhibit_ipv4): with one, a container reaches every host service that
// listens on all interfaces.
// BuildRun is one sandboxed image build: rootless BuildKit in a container
// under Runtime, on the claim's network at a fixed address, resolving
// through the cell, reading the context read-only and writing the image as
// a docker tarball into Out.
type BuildRun struct {
	Image, Runtime, Network, Address, Resolv string
	// CgroupParent places the builder under the claim's aggregate budget.
	CgroupParent                string
	Context, Dockerfile, Target string
	Args                        map[string]string
	// Tag names the image in the tarball; Out is a directory the builder's
	// user (uid 1000) can write.
	Tag, Out string
	// CacheFrom is a BuildKit local cache the build reads, mounted read-only
	// (the environment's); CacheTo is where it writes its own, a directory
	// the builder's user can write. Either may be empty.
	CacheFrom, CacheTo string
	PidsLimit          int
	MemLimit           string
	CPUs               string
	Labels             map[string]string
	// RegistryMirror is the cell's registry mirror (host:port, plain HTTP on
	// the claim network) BuildKit pulls docker.io images through; empty: none.
	RegistryMirror string
	// StateDir, when set, is BuildKit's own state (its layer snapshots and the
	// RUN --mount=type=cache directories) mounted at the rootless daemon's
	// root, so a later build finds them; uid 1000 must be able to write it.
	// Empty: the state lives and dies with the builder container.
	StateDir string
	// GCKeepStorage bounds the state BuildKit keeps ("20GB"); empty: its default.
	GCKeepStorage string
}

// BuildkitStateRoot is where rootless BuildKit keeps its state in the builder image.
const BuildkitStateRoot = "/home/user/.local/share/buildkit"

var keepStorage = regexp.MustCompile(`^[0-9]{1,6}(MB|GB|TB)$`)

// BuildkitdConfig is the BuildKit daemon config RunBuild writes in Out when
// the build pulls through the cell's registry mirror.
const BuildkitdConfig = "buildkitd.toml"

var mirrorHostPort = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?:[0-9]{1,5}$`)

// buildkitdMirrorConfig makes BuildKit pull docker.io through the mirror, over
// plain HTTP (the mirror is on the claim network, answered by the resolver).
func buildkitdMirrorConfig(hostPort string) ([]byte, error) {
	if !mirrorHostPort.MatchString(hostPort) {
		return nil, fmt.Errorf("dockercli: registry mirror %q is not host:port", hostPort)
	}
	return []byte(fmt.Sprintf("[registry.\"docker.io\"]\n  mirrors = [%q]\n\n[registry.%q]\n  http = true\n", hostPort, hostPort)), nil
}

// BuildTarball is where RunBuild leaves the image, inside Out.
const BuildTarball = "image.tar"

func (c CLI) RunBuild(ctx context.Context, b BuildRun) error {
	if err := ValidateCgroupParent(b.CgroupParent); err != nil {
		return err
	}
	pids := b.PidsLimit
	if pids == 0 {
		pids = 4096
	}
	// Named, so it can be removed: a canceled docker CLI leaves its
	// container running (a build that outlived its claim's ceiling).
	name := "kodus-build-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	flags := "--oci-worker-no-process-sandbox"
	var conf []byte
	if b.RegistryMirror != "" {
		var err error
		if conf, err = buildkitdMirrorConfig(b.RegistryMirror); err != nil {
			return err
		}
	}
	if b.StateDir != "" && b.GCKeepStorage != "" {
		if !keepStorage.MatchString(b.GCKeepStorage) {
			return fmt.Errorf("dockercli: gc keep storage %q is not <n>MB|GB|TB", b.GCKeepStorage)
		}
		conf = append(conf, []byte(fmt.Sprintf("\n[worker.oci]\n  gc = true\n  gckeepstorage = %q\n", b.GCKeepStorage))...)
	}
	if len(conf) > 0 {
		// In Out, the cell's directory for this build, read by the builder at /out.
		if err := os.WriteFile(filepath.Join(b.Out, BuildkitdConfig), conf, 0o644); err != nil {
			return err
		}
		flags += " --config /out/" + BuildkitdConfig
	}
	args := []string{"run", "--rm", "--name", name, "--runtime", b.Runtime, "--network", b.Network, "--ip", b.Address,
		"--pids-limit", strconv.Itoa(pids), "-e", "BUILDKITD_FLAGS=" + flags,
		"-v", b.Resolv + ":/etc/resolv.conf:ro", "-v", b.Context + ":/ctx:ro", "-v", b.Out + ":/out"}
	if b.CgroupParent != "" {
		args = append(args, "--cgroup-parent", b.CgroupParent)
	}
	if b.CacheFrom != "" {
		args = append(args, "-v", b.CacheFrom+":/cache-in:ro")
	}
	if b.CacheTo != "" {
		args = append(args, "-v", b.CacheTo+":/cache-out")
	}
	if b.StateDir != "" {
		args = append(args, "-v", b.StateDir+":"+BuildkitStateRoot)
	}
	if b.MemLimit != "" {
		args = append(args, "--memory", b.MemLimit)
	}
	if b.CPUs != "" {
		args = append(args, "--cpus", b.CPUs)
	}
	args = append(args, labelArgs(b.Labels)...)
	args = append(args, "--entrypoint", "buildctl-daemonless.sh", b.Image, "build", "--progress", "plain", "--frontend", "dockerfile.v0",
		"--local", "context=/ctx", "--local", "dockerfile=/ctx", "--opt", "filename="+b.Dockerfile)
	if b.Target != "" {
		args = append(args, "--opt", "target="+b.Target)
	}
	for _, k := range sortedKeys(b.Args) {
		args = append(args, "--opt", "build-arg:"+k+"="+b.Args[k])
	}
	if b.CacheFrom != "" {
		args = append(args, "--import-cache", "type=local,src=/cache-in")
	}
	if b.CacheTo != "" {
		// zstd: several times faster than gzip on a large cache, and it stays on the cell's disk.
		args = append(args, "--export-cache", "type=local,dest=/cache-out,mode=max,compression=zstd")
	}
	// Uncompressed: the tarball only goes to this Docker's load and is removed
	// after it, so gzip of a multi-GB image (single-threaded, under the
	// sandbox) would only cost minutes of the claim's ceiling.
	args = append(args, "--output", "type=docker,name="+b.Tag+",dest=/out/"+BuildTarball+",compression=uncompressed")
	_, err := c.run(ctx, nil, args...)
	if ctx.Err() != nil {
		// The claim was released, hit its ceiling or the cell stopped: the
		// build stops with it.
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_, _ = c.run(rctx, nil, "rm", "-f", "-v", name)
	}
	return err
}

// LoadImage loads a docker tarball into this Docker.
func (c CLI) LoadImage(ctx context.Context, tarball string) error {
	_, err := c.run(ctx, nil, "load", "-q", "-i", tarball)
	return err
}

// RemoveImage removes an image by reference; one already gone is done.
func (c CLI) RemoveImage(ctx context.Context, ref string) error {
	_, err := c.run(ctx, nil, "image", "rm", "-f", ref)
	if err != nil && strings.Contains(err.Error(), "No such image") {
		return nil
	}
	return err
}

// ErrNoSuchImage is a TagImage whose source is not in this Docker.
var ErrNoSuchImage = errors.New("dockercli: no such image")

// TagImage gives the image src another name dst.
func (c CLI) TagImage(ctx context.Context, src, dst string) error {
	_, err := c.run(ctx, nil, "image", "tag", src, dst)
	if err != nil && strings.Contains(err.Error(), "No such image") {
		return fmt.Errorf("%w: %s", ErrNoSuchImage, src)
	}
	return err
}

// ImageRefs lists every repo:tag of the repository repo in this Docker.
func (c CLI) ImageRefs(ctx context.Context, repo string) ([]string, error) {
	out, err := c.run(ctx, nil, "image", "ls", "--format", "{{.Repository}}:{{.Tag}}", repo)
	if err != nil {
		return nil, err
	}
	return uniqueFields(out), nil
}

// NetworkSpec is a bridge network to create.
type NetworkSpec struct {
	Name     string
	Internal bool
	// HostOnly is an internal network the host has an address on, with no
	// traffic between its containers: the host reaches each of them, they
	// reach neither each other nor anything outside.
	HostOnly bool
	Labels   map[string]string
	// Subnet and IPRange ("10.213.7.0/24", "10.213.7.128/25"): empty lets
	// Docker pick. Dynamic addresses come only from IPRange.
	Subnet, IPRange string
}

func (c CLI) NetworkCreate(ctx context.Context, n NetworkSpec) error {
	args := []string{"network", "create", "--driver", "bridge", "--ipv6=false"}
	switch {
	case n.HostOnly:
		args = append(args, "--internal", "--opt", "com.docker.network.bridge.enable_icc=false")
	case n.Internal:
		args = append(args, "--internal", "--opt", "com.docker.network.bridge.inhibit_ipv4=true")
	}
	if n.Subnet != "" {
		args = append(args, "--subnet", n.Subnet)
	}
	if n.IPRange != "" {
		args = append(args, "--ip-range", n.IPRange)
	}
	args = append(args, labelArgs(n.Labels)...)
	_, err := c.run(ctx, nil, append(args, n.Name)...)
	return err
}

// NetworkSubnet is a network's first IPv4 subnet.
func (c CLI) NetworkSubnet(ctx context.Context, name string) (string, error) {
	out, err := c.run(ctx, nil, "network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", name)
	if err != nil {
		return "", err
	}
	for _, s := range strings.Fields(string(out)) {
		if !strings.Contains(s, ":") {
			return s, nil
		}
	}
	return "", fmt.Errorf("dockercli: network %s has no IPv4 subnet", name)
}

// NetworkLabels are a network's labels (nil, nil when it does not exist).
func (c CLI) NetworkLabels(ctx context.Context, name string) (map[string]string, error) {
	out, err := c.run(ctx, nil, "network", "ls", "-q", "--filter", "name=^"+name+"$")
	if err != nil || len(strings.Fields(string(out))) == 0 {
		return nil, err
	}
	out, err = c.run(ctx, nil, "network", "inspect", "--format", "{{json .Labels}}", name)
	if err != nil {
		return nil, err
	}
	labels := map[string]string{}
	if t := strings.TrimSpace(string(out)); t != "" && t != "null" {
		if err := json.Unmarshal([]byte(t), &labels); err != nil {
			return nil, err
		}
	}
	return labels, nil
}

// NetworkConnect attaches a running container to a network and returns its
// address there.
func (c CLI) NetworkConnect(ctx context.Context, network, container string) (string, error) {
	if _, err := c.run(ctx, nil, "network", "connect", network, container); err != nil {
		return "", err
	}
	cs, err := c.Inspect(ctx, container)
	if err != nil {
		return "", err
	}
	if len(cs) != 1 || cs[0].Networks[network] == "" {
		return "", fmt.Errorf("dockercli: %s has no address on %s after connect", container, network)
	}
	return cs[0].Networks[network], nil
}

// NetworkDisconnect detaches a container from a network; one that is not
// attached is already done.
func (c CLI) NetworkDisconnect(ctx context.Context, network, container string) error {
	_, err := c.run(ctx, nil, "network", "disconnect", "--force", network, container)
	if err != nil && strings.Contains(err.Error(), "is not connected") {
		return nil
	}
	return err
}

func (c CLI) NetworkRemove(ctx context.Context, name string) error {
	_, err := c.run(ctx, nil, "network", "rm", name)
	return err
}

// LabelFromTag maps a driver tag (kodus:cell) to a Docker label
// (kodus.cell): label keys cannot hold ':'.
func LabelFromTag(tag string) string { return strings.ReplaceAll(tag, ":", ".") }

// TagFromLabel maps a cell label back to its tag; other labels are kept.
func TagFromLabel(label string) string {
	if strings.HasPrefix(label, "kodus.") {
		return "kodus:" + strings.TrimPrefix(label, "kodus.")
	}
	return label
}

// ComposeStopServices stops the named services of a project (all of them
// when none is named).
func (c CLI) ComposeStopServices(ctx context.Context, project string, services ...string) error {
	_, err := c.run(ctx, nil, append([]string{"compose", "-p", project, "stop"}, services...)...)
	return err
}

// Volume is one Docker volume with its labels.
type Volume struct {
	Name   string
	Labels map[string]string
}

// Volumes lists the volumes carrying every one of labels.
func (c CLI) Volumes(ctx context.Context, labels map[string]string) ([]Volume, error) {
	args := []string{"volume", "ls", "--format", "{{json .}}"}
	for _, k := range sortedKeys(labels) {
		if labels[k] == "" {
			args = append(args, "--filter", "label="+k)
		} else {
			args = append(args, "--filter", "label="+k+"="+labels[k])
		}
	}
	out, err := c.run(ctx, nil, args...)
	if err != nil {
		return nil, err
	}
	var vols []Volume
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line == "" {
			continue
		}
		var row struct{ Name string }
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			return nil, err
		}
		// ls joins labels with commas; inspect gives them as a map.
		raw, err := c.run(ctx, nil, "volume", "inspect", "--format", "{{json .Labels}}", row.Name)
		if err != nil {
			return nil, err
		}
		l := map[string]string{}
		if t := strings.TrimSpace(string(raw)); t != "" && t != "null" {
			if err := json.Unmarshal([]byte(t), &l); err != nil {
				return nil, err
			}
		}
		vols = append(vols, Volume{Name: row.Name, Labels: l})
	}
	return vols, nil
}

// VolumeRemove removes volumes by name.
func (c CLI) VolumeRemove(ctx context.Context, names ...string) error {
	if len(names) == 0 {
		return nil
	}
	_, err := c.run(ctx, nil, append([]string{"volume", "rm", "-f"}, names...)...)
	return err
}

// CopyVolume makes to an exact copy of from, file modes and owners kept,
// with a throwaway helper container. With labels, to is created afresh
// with them (a snapshot); without, to must exist and is emptied first (a
// restore). Nothing may be using either volume.
func (c CLI) CopyVolume(ctx context.Context, helperImage, from, to string, labels map[string]string) error {
	return c.CopyVolumeIn(ctx, "", helperImage, from, to, labels)
}

// CopyVolumeIn is CopyVolume with the helper under runtime ("" is Docker's
// default): an org's data copied by docker-gvisor is read under runsc.
func (c CLI) CopyVolumeIn(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string) error {
	return c.CopyVolumeBound(ctx, runtime, helperImage, from, to, labels, "")
}

// ExecSpec is one command run inside a running container (docker exec).
type ExecSpec struct {
	Container string
	// Dir is the absolute directory it runs in, inside the container.
	Dir string
	// Env are KEY=VALUE pairs set for it.
	Env []string
}

// sandboxedLine runs the command under sh -c inside the container, and
// under timeout(1) there when the image has it: docker exec does not stop
// what it started when its client is killed, so the deadline is enforced in
// the sandbox too. The command and the seconds are positional parameters,
// never spliced into the script.
const sandboxedLine = `if command -v timeout >/dev/null 2>&1; then exec timeout -s KILL "$0" /bin/sh -c "$1"; fi; exec /bin/sh -c "$1"`

// ExecArgs is the docker argv that runs req inside the container. Nothing
// of req reaches a shell on the cell host: it is all argv.
func ExecArgs(e ExecSpec, req kodyexec.Request) []string {
	secs := (req.TimeoutMs + 999) / 1000
	if secs <= 0 {
		secs = 60
	}
	args := []string{"exec", "-i=false"}
	if e.Dir != "" {
		args = append(args, "-w", e.Dir)
	}
	for _, kv := range e.Env {
		args = append(args, "-e", kv)
	}
	return append(args, e.Container, "/bin/sh", "-c", sandboxedLine, strconv.FormatInt(secs, 10), req.ShellLine())
}

// Exec runs req inside the container through the docker binary on PATH,
// with the minimal docker environment: the command under req's timeout in
// the sandbox, the client under host's (a little longer), both with
// kody-exec's output caps and secret masking (kodyexec.RunArgv).
func (c CLI) Exec(ctx context.Context, e ExecSpec, req, host kodyexec.Request) kodyexec.Result {
	if c.ExecRun != nil {
		return c.ExecRun(ctx, ExecArgs(e, req), host)
	}
	bin := c.Bin
	if bin == "" {
		bin = "docker"
	}
	return kodyexec.RunArgv(ctx, host, MinimalEnv(), append([]string{bin}, ExecArgs(e, req)...)...)
}

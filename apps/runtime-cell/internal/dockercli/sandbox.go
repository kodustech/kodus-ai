package dockercli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// A code sandbox's container (docs/runtime/sandbox.md): the holder's
// lockdown (runtime, claim network, no capability, no new privileges, a
// read-only root, the cell's resolver) plus what a holder never needs,
// because commands run in this one: a memory and CPU limit of its own, an
// unprivileged user, and a bounded /workspace and /tmp in the sandbox's own
// memory (never a host directory), so what the commands write is counted
// and capped inside the isolation boundary.

// SandboxSpec is one sandbox container.
type SandboxSpec struct {
	HolderSpec
	// User runs the container and everything in it ("1000:1000").
	User string
	// Memory and CPUs are docker's --memory and --cpus ("4g", "2"); empty: none.
	Memory, CPUs string
	// WorkspaceSize and TmpSize cap /workspace and /tmp ("8g"); empty: docker's default.
	WorkspaceSize, TmpSize string
	// Tmpfs are more bounded in-memory directories of the sandbox's user,
	// beside /workspace and /tmp (a layer builder's /opt/kcli/<id>).
	Tmpfs []Tmpfs
}

// Tmpfs is one extra in-memory directory: an absolute path of safe
// characters under /opt/ and a size ("256m").
type Tmpfs struct{ Dir, Size string }

var tmpfsDir = regexp.MustCompile(`^/opt/[a-z][a-z0-9-]{0,31}/[a-z][a-z0-9-]{0,31}$`)

var (
	sandboxUser = regexp.MustCompile(`^[0-9]{1,10}:[0-9]{1,10}$`)
	sandboxMem  = regexp.MustCompile(`^[1-9][0-9]{0,6}[kmg]?$`)
	sandboxCPUs = regexp.MustCompile(`^[0-9]{1,4}(\.[0-9]{1,3})?$`)
)

func tmpfsOpt(dir, size, user string) string {
	uid, gid, _ := strings.Cut(user, ":")
	opt := dir + ":rw,nosuid,nodev,mode=0755,uid=" + uid + ",gid=" + gid
	if size != "" {
		opt += ",size=" + size
	}
	return opt
}

// SandboxArgs is the docker argv that creates s.
func SandboxArgs(s SandboxSpec) ([]string, error) {
	switch {
	case !sandboxUser.MatchString(s.User):
		return nil, fmt.Errorf("dockercli: sandbox user %q is not uid:gid", s.User)
	case s.Memory != "" && !sandboxMem.MatchString(s.Memory), s.WorkspaceSize != "" && !sandboxMem.MatchString(s.WorkspaceSize), s.TmpSize != "" && !sandboxMem.MatchString(s.TmpSize):
		return nil, errors.New("dockercli: a sandbox size is not <n>[k|m|g]")
	case s.CPUs != "" && !sandboxCPUs.MatchString(s.CPUs):
		return nil, fmt.Errorf("dockercli: sandbox cpus %q", s.CPUs)
	}
	for _, t := range s.Tmpfs {
		if !tmpfsDir.MatchString(t.Dir) || !sandboxMem.MatchString(t.Size) {
			return nil, fmt.Errorf("dockercli: sandbox tmpfs %q size %q is not /opt/<name>/<name> and <n>[k|m|g]", t.Dir, t.Size)
		}
	}
	if err := ValidateCgroupParent(s.CgroupParent); err != nil {
		return nil, err
	}
	if err := ValidDiskSize(s.DiskSize); err != nil {
		return nil, err
	}
	pids := s.PidsLimit
	if pids == 0 {
		pids = 2048
	}
	args := []string{
		"run", "-d", "--name", s.Name, "--runtime", s.Runtime, "--network", s.Network,
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
		"--pids-limit", strconv.Itoa(pids), "--user", s.User,
		"--tmpfs", tmpfsOpt("/workspace", s.WorkspaceSize, s.User), "--tmpfs", tmpfsOpt("/tmp", s.TmpSize, s.User),
		// A command runs as PID 1's user and can write to its stdout: with a
		// log driver that is a file on the host's disk with no bound.
		"--log-driver", "none",
	}
	for _, t := range s.Tmpfs {
		args = append(args, "--tmpfs", tmpfsOpt(t.Dir, t.Size, s.User))
	}
	if s.Memory != "" {
		args = append(args, "--memory", s.Memory, "--memory-swap", s.Memory)
	}
	if s.CPUs != "" {
		args = append(args, "--cpus", s.CPUs)
	}
	if s.CgroupParent != "" {
		args = append(args, "--cgroup-parent", s.CgroupParent)
	}
	args = append(args, storageOpt(s.DiskSize)...)
	io, err := s.IO.args()
	if err != nil {
		return nil, err
	}
	args = append(args, io...)
	if s.Resolv != "" {
		args = append(args, "-v", s.Resolv+":/etc/resolv.conf:ro")
	}
	for _, m := range s.Mounts {
		args = append(args, "-v", m+":ro")
	}
	args = append(args, labelArgs(s.Labels)...)
	cmd := s.Cmd
	if len(cmd) == 0 {
		cmd = []string{"sleep", "infinity"}
	}
	return append(append(args, s.Image), cmd...), nil
}

// RunSandbox starts the sandbox container and inspects it.
func (c CLI) RunSandbox(ctx context.Context, s SandboxSpec) (Container, error) {
	args, err := SandboxArgs(s)
	if err != nil {
		return Container{}, err
	}
	out, err := c.run(ctx, nil, args...)
	if err != nil {
		return Container{}, err
	}
	cs, err := c.Inspect(ctx, strings.TrimSpace(string(out)))
	if err != nil {
		return Container{}, err
	}
	if len(cs) != 1 {
		return Container{}, fmt.Errorf("dockercli: sandbox %s not found after run", s.Name)
	}
	return cs[0], nil
}

// ExecStream starts argv in the container with its stdin and stdout as a
// byte stream (docker exec -i), as user. Nothing reaches a shell on the cell
// host. ctx bounds the stream's whole life (pass one that outlives the call
// that opens it); Close ends the process; the stream also ends when the
// container goes. What the process writes to stderr is dropped past 64 KiB.
func (c CLI) ExecStream(ctx context.Context, container, user string, argv ...string) (io.ReadWriteCloser, error) {
	if !sandboxUser.MatchString(user) {
		return nil, fmt.Errorf("dockercli: exec user %q is not uid:gid", user)
	}
	bin := c.Bin
	if bin == "" {
		bin = "docker"
	}
	args := append([]string{"exec", "-i", "-u", user, container}, argv...)
	cmd := exec.CommandContext(ctx, bin, args...) //nolint:gosec // G204: argv, the docker binary and the cell's own guest command; no shell
	cmd.Env = MinimalEnv()
	cmd.Stderr = &capped{max: 64 << 10}
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &execStream{cmd: cmd, in: in, out: out}, nil
}

type execStream struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	out  io.ReadCloser
	once sync.Once
	done chan struct{}
	mu   sync.Mutex
}

func (s *execStream) waited() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done == nil {
		s.done = make(chan struct{})
		go func() { _ = s.cmd.Wait(); close(s.done) }()
	}
	return s.done
}

func (s *execStream) Read(p []byte) (int, error)  { return s.out.Read(p) }
func (s *execStream) Write(p []byte) (int, error) { return s.in.Write(p) }

func (s *execStream) Close() error {
	s.once.Do(func() {
		_ = s.in.Close()
		if s.cmd.Process != nil {
			_ = s.cmd.Process.Kill()
		}
		<-s.waited()
	})
	return nil
}

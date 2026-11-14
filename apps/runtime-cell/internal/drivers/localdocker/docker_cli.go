package localdocker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// CLI is Docker through the docker binary (internal/drivers/dockercli).
// Unlike the gVisor driver, local-docker gives docker the developer's whole
// environment and lets compose read the checkout's .env: it runs the
// developer's own code with no isolation, and their compose files may use
// their shell's variables.
type CLI struct {
	Bin string
	// HelperImage copies volumes for data snapshots; DefaultHelperImage
	// when empty.
	HelperImage string
	// Run runs the binary; nil: exec with the process environment.
	Run dockercli.CommandRunner
}

func (c CLI) cli() dockercli.CLI {
	r := c.Run
	if r == nil {
		r = dockercli.ExecCommandWith(os.Environ())
	}
	return dockercli.CLI{Bin: c.Bin, Run: r}
}

func (p ComposeProject) dockercli() dockercli.ComposeProject {
	return dockercli.ComposeProject{Name: p.Name, Dir: p.Dir, File: p.File, EnvFile: p.EnvFile}
}

func (c CLI) Version(ctx context.Context) (string, error) { return c.cli().Version(ctx) }

func (c CLI) ComposeBuild(ctx context.Context, p ComposeProject, pullServices []string) error {
	return c.cli().ComposeBuild(ctx, p.dockercli(), pullServices)
}

func (c CLI) ComposeUp(ctx context.Context, p ComposeProject) error {
	return c.cli().ComposeUp(ctx, p.dockercli())
}

func (c CLI) ComposeExec(ctx context.Context, project, service string, stdin []byte, cmd ...string) error {
	return c.cli().ComposeExec(ctx, project, service, stdin, cmd...)
}

func (c CLI) Shell(ctx context.Context, dir string, env map[string]string, command string) error {
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = dir
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%q: %v: %s", command, err, lastBytes(out, 2000))
	}
	return nil
}

// ComposeDown works from the project name alone: a destroy may come after a
// restart, with no compose file at hand. That is also why the built images
// are found by the project label compose puts on them, not with down --rmi.
func (c CLI) ComposeDown(ctx context.Context, project string, opts DownOptions) error {
	if err := c.cli().ComposeDown(ctx, project, opts.Volumes); err != nil || !opts.BuiltImages {
		return err
	}
	return c.cli().RemoveImagesLabelled(ctx, labelProject, project)
}

func (c CLI) ComposeStop(ctx context.Context, project string) error {
	return c.cli().ComposeStop(ctx, project)
}

func (c CLI) ComposeStart(ctx context.Context, project string) error {
	return c.cli().ComposeStart(ctx, project)
}

func (c CLI) ComposePort(ctx context.Context, project, service string, port int) (string, error) {
	return c.cli().ComposePort(ctx, project, service, port)
}

func (c CLI) List(ctx context.Context, labels map[string]string) ([]Container, error) {
	return c.cli().List(ctx, labels)
}

func (c CLI) ComposeStopServices(ctx context.Context, project string, services ...string) error {
	return c.cli().ComposeStopServices(ctx, project, services...)
}

// DefaultHelperImage copies volumes (sh and cp -a); CLI.HelperImage
// overrides it.
const DefaultHelperImage = "busybox:1.36"

func (c CLI) CopyVolume(ctx context.Context, from, to string, labels map[string]string) error {
	img := c.HelperImage
	if img == "" {
		img = DefaultHelperImage
	}
	return c.cli().CopyVolume(ctx, img, from, to, labels)
}

func (c CLI) Volumes(ctx context.Context, labels map[string]string) ([]dockercli.Volume, error) {
	return c.cli().Volumes(ctx, labels)
}

func (c CLI) VolumeRemove(ctx context.Context, names ...string) error {
	return c.cli().VolumeRemove(ctx, names...)
}

// ComposePs lists the project's services and their state (`ps -a`, so an
// exited service shows).
func (c CLI) ComposePs(ctx context.Context, project string) ([]ServiceState, error) {
	raw, err := c.cli().ComposePs(ctx, project)
	if err != nil {
		return nil, err
	}
	return parsePs(raw)
}

// parsePs reads `compose ps --format json` (dockercli.ParseComposePs).
func parsePs(raw []byte) ([]ServiceState, error) { return dockercli.ParseComposePs(raw) }

// ComposeLogs is the last lines a service logged, oldest first.
func (c CLI) ComposeLogs(ctx context.Context, project, service string, lines int) ([]string, error) {
	raw, err := c.cli().ComposeLogs(ctx, project, service, lines)
	if err != nil {
		return nil, err
	}
	text := strings.TrimRight(string(raw), "\n")
	if text == "" {
		return []string{}, nil
	}
	return strings.Split(text, "\n"), nil
}

func lastBytes(b []byte, n int) string {
	s := strings.TrimSpace(string(b))
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}

var (
	_ Docker           = CLI{}
	_ SnapshotDocker   = CLI{}
	_ DiagnosticDocker = CLI{}
)

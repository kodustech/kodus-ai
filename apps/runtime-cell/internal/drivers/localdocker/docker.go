package localdocker

import (
	"context"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
)

// Docker is what the driver needs from the local Docker. CLI implements it
// with the docker binary; the tests use a fake.
type Docker interface {
	// Version fails when there is no daemon to talk to.
	Version(ctx context.Context) (string, error)
	// ComposeBuild builds the project's images, then pulls the missing
	// images of pullServices (the ones that come from a registry).
	ComposeBuild(ctx context.Context, p ComposeProject, pullServices []string) error
	// ComposeUp is up -d --wait with no build: every container started and
	// passing its own healthcheck.
	ComposeUp(ctx context.Context, p ComposeProject) error
	// ComposeExec runs cmd in a running service, stdin piped in.
	ComposeExec(ctx context.Context, project, service string, stdin []byte, cmd ...string) error
	// Shell runs a recipe command on the host, in dir, with env added.
	Shell(ctx context.Context, dir string, env map[string]string, command string) error
	ComposeDown(ctx context.Context, project string, opts DownOptions) error
	ComposeStop(ctx context.Context, project string) error
	ComposeStart(ctx context.Context, project string) error
	// ComposePort is the host address a service's container port is
	// published on ("127.0.0.1:55001").
	ComposePort(ctx context.Context, project, service string, port int) (string, error)
	// List is the containers carrying every one of labels.
	List(ctx context.Context, labels map[string]string) ([]Container, error)
}

// SnapshotDocker is the part of Docker a data snapshot needs (data.reset:
// snapshot). CLI implements it; without it, a snapshot reset recreates.
type SnapshotDocker interface {
	// ComposeStopServices stops those services of the project (all of them
	// when none is named).
	ComposeStopServices(ctx context.Context, project string, services ...string) error
	// CopyVolume copies from into to with a helper container: with labels,
	// to is created afresh with them; without, to is emptied first.
	CopyVolume(ctx context.Context, from, to string, labels map[string]string) error
	// Volumes lists the volumes carrying every one of labels ("" matches
	// any value); VolumeRemove removes them by name.
	Volumes(ctx context.Context, labels map[string]string) ([]dockercli.Volume, error)
	VolumeRemove(ctx context.Context, names ...string) error
}

// DiagnosticDocker is the part of Docker the failure bundle reads. CLI
// implements it; a Docker without it gives a bundle with ports and disk only.
type DiagnosticDocker interface {
	ComposePs(ctx context.Context, project string) ([]ServiceState, error)
	ComposeLogs(ctx context.Context, project, service string, lines int) ([]string, error)
}

// ComposeProject is one claim's compose project as the driver runs it.
type ComposeProject struct {
	// Name is the compose project name, the machine id.
	Name string
	// Dir is the checkout, the project directory relative paths resolve in.
	Dir string
	// File is the adapted compose file the driver wrote into the checkout.
	File string
	// EnvFile holds the recipe's interpolation variables; "" when it sets
	// none, and compose then reads the checkout's own .env.
	EnvFile string
}

// DownOptions says what a down removes besides the containers.
type DownOptions struct {
	Volumes bool
	// BuiltImages are the images the project built. A reset keeps them for
	// its up; a destroy removes them, or every boot leaves one behind.
	BuiltImages bool
}

// ServiceState is one service of a compose project as `compose ps` sees it.
type ServiceState = dockercli.ServiceState

type Container = dockercli.Container

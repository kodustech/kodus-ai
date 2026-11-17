package dockergvisor

import (
	"context"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/registry"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation/gvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	dockerplacement "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/placement/docker"
)

// The host's Docker, split by the code that uses it. Each port is required
// whole: a Docker without one of its methods does not compile, it never
// degrades at run time. dockercli.CLI implements every one.

// daemonPort is what New checks of the daemon (claim limits, the health
// fast start) and what builderIDs reads (user namespace remapping).
type daemonPort interface {
	DaemonEndpoint(ctx context.Context) (string, error)
	CgroupInfo(ctx context.Context) (dockercli.CgroupDaemonInfo, error)
	APIVersion(ctx context.Context) (string, error)
	SecurityOptions(ctx context.Context) ([]string, error)
}

// backendPort is what newBackend gives the gVisor backend, and the data
// root whose disk the backend bounds a machine's writes on.
type backendPort interface {
	gvisor.Engine
	DataRoot(ctx context.Context) (string, error)
}

// buildPort is what a build and a bake run (build.go, bake.go) and what
// a generation prune removes (generation.go).
type buildPort interface {
	RunBuild(ctx context.Context, b dockercli.BuildRun) error
	LoadImage(ctx context.Context, l dockercli.ImageLoad) error
	TagImage(ctx context.Context, src, dst string) error
	RemoveImage(ctx context.Context, ref string) error
}

// registryPort is what the registry image transfer runs (package registry)
// and the host-only networks it and the observers are on (registry.go).
type registryPort interface {
	registry.Docker
	NetworkCreate(ctx context.Context, n dockercli.NetworkSpec) error
	NetworkLabels(ctx context.Context, name string) (map[string]string, error)
}

// composePort is what brings a claim's project up and down (up.go,
// lifecycle.go, data.go, golden.go).
type composePort interface {
	ComposeConfig(ctx context.Context, p dockercli.ComposeProject) ([]byte, error)
	ComposeUp(ctx context.Context, p dockercli.ComposeProject) error
	ComposeDown(ctx context.Context, project string, volumes bool) error
	ComposeStop(ctx context.Context, project string) error
	ComposeStopServices(ctx context.Context, project string, services ...string) error
	ComposeKill(ctx context.Context, project, signal string, services ...string) error
	NetworkSubnet(ctx context.Context, name string) (string, error)
}

// inventoryPort is what finds the cell's containers, networks and images
// (lifecycle.go, sweep.go, pool.go, claim_limits.go, generation.go,
// observer_sql.go, browser_explore.go).
type inventoryPort interface {
	IDs(ctx context.Context, f dockercli.Filters) ([]string, error)
	Inspect(ctx context.Context, ids ...string) ([]dockercli.Container, error)
	List(ctx context.Context, labels map[string]string) ([]dockercli.Container, error)
	NetworkLabels(ctx context.Context, name string) (map[string]string, error)
	ImageRefs(ctx context.Context, repo string) ([]string, error)
	ImageLabels(ctx context.Context, ref string) (map[string]string, error)
}

// dataPort is what copies and removes a claim's data volumes (data.go,
// generation.go, golden.go).
type dataPort interface {
	Volumes(ctx context.Context, labels map[string]string) ([]dockercli.Volume, error)
	VolumeRemove(ctx context.Context, names ...string) error
	CopyVolumeIn(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string) error
	CopyVolumeBound(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string, parent string) error
	CopyVolumeGeneration(ctx context.Context, runtime, helperImage, from, to string, labels map[string]string, parent, expected, write string) error
}

// execPort is what runs a command in a machine (exec.go, recipe_steps.go,
// observer_sql.go, golden.go).
type execPort interface {
	Exec(ctx context.Context, e dockercli.ExecSpec, req, host kodyexec.Request) kodyexec.Result
	ExecInput(ctx context.Context, container string, stdin []byte, argv ...string) ([]byte, error)
}

// logPort is what reads a claim's services: the failure bundle
// (diagnose.go) and a probe round's logs (service_logs.go).
type logPort interface {
	ComposePs(ctx context.Context, project string) ([]byte, error)
	ComposeLogs(ctx context.Context, project, service string, lines int) ([]byte, error)
	ComposeLogsWindow(ctx context.Context, project, service string, since, until time.Time, lines int) ([]byte, error)
}

// reaperPort is what the Reaper lists and removes with no in-memory state
// (reap.go, orphans.go, golden.go), and the gVisor ender it ends machines
// through.
type reaperPort interface {
	gvisor.EndingEngine
	IDs(ctx context.Context, f dockercli.Filters) ([]string, error)
	Inspect(ctx context.Context, ids ...string) ([]dockercli.Container, error)
	Remove(ctx context.Context, name string) error
	RemoveImage(ctx context.Context, ref string) error
	NetworkLabels(ctx context.Context, name string) (map[string]string, error)
	NetworkDisconnect(ctx context.Context, network, container string) error
	NetworkRemove(ctx context.Context, name string) error
	Volumes(ctx context.Context, labels map[string]string) ([]dockercli.Volume, error)
	VolumeRemove(ctx context.Context, names ...string) error
}

// Docker is what the Driver holds: every path above runs on it, the
// claim placement (dockerplacement.Networks) too, and it hands its own
// Reaper the same Docker.
type Docker interface {
	daemonPort
	backendPort
	dockerplacement.Networks
	buildPort
	registryPort
	composePort
	inventoryPort
	dataPort
	execPort
	logPort
	reaperPort
}

var (
	_ Docker        = dockercli.CLI{}
	_ daemonPort    = dockercli.CLI{}
	_ backendPort   = dockercli.CLI{}
	_ buildPort     = dockercli.CLI{}
	_ registryPort  = dockercli.CLI{}
	_ composePort   = dockercli.CLI{}
	_ inventoryPort = dockercli.CLI{}
	_ dataPort      = dockercli.CLI{}
	_ execPort      = dockercli.CLI{}
	_ logPort       = dockercli.CLI{}
	_ reaperPort    = dockercli.CLI{}
)

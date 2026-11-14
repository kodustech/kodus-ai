// Package localdocker is a DEV-ONLY MachineDriver: it runs the claim's
// environment (the checkout's compose project, or one container built from
// its Dockerfile) on the developer's own Docker daemon, with NO isolation.
// It exists to run a real app on a laptop against a local hub. It reports
// isolation "none", it refuses to start unless both the
// -dev-insecure-local-docker flag and KODY_RUNTIME_DEV=1 are set, and it
// must never run code nobody trusts.
//
// Where things are:
//
//	driver.go       the driver, its config and the dev gate
//	names.go        machine, project and label names
//	claims.go       PrepareClaim, ReleaseClaim
//	machines.go     the machine lifecycle: create, suspend, destroy, sweep
//	boot_plan.go    what a checkout boots: its recipe and adapted compose
//	boot.go         Boot and Reset, phase by phase
//	boot_report.go  phase timing and logs, LastBoot, BootTiming
//	seed.go         migrate and seed
//	health.go       the recipe's health check
//	claim_view.go   what the agent and the observer read: Manifest, Targets
//	diagnose.go     the failure bundle
//	docker.go       the port to Docker; docker_cli.go is its adapter
//	state.go        the state file; transport.go the upload that boots
package localdocker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

const Kind = "local-docker"

// DevEnv is the environment variable that, with the flag, opens the gate.
const DevEnv = "KODY_RUNTIME_DEV"

// ErrNotDev: the driver was asked for without both halves of the dev gate.
var ErrNotDev = errors.New("localdocker: refused: the local-docker driver has no isolation and needs both -dev-insecure-local-docker and " + DevEnv + "=1")

// Warning is printed to Config.Out every time the driver starts.
const Warning = `
################################################################################
#  KODY RUNTIME: local-docker driver, NO ISOLATION                             #
#                                                                              #
#  Workloads run directly on this machine's Docker daemon. There is no VM, no  #
#  sandbox, no egress policy and no per-claim network boundary: the code you   #
#  run can read your files, reach your network and talk to your Docker.        #
#                                                                              #
#  DEV ONLY. Never use it with untrusted code. Never in production.            #
################################################################################
`

type Config struct {
	CellID string
	// StateDir holds the state file (expiry, checkouts, published ports).
	StateDir string
	// MachinesDir is where each machine's files live (the transport root):
	// the workload's checkout is MachinesDir/<machine>/workspace.
	MachinesDir string
	// DevInsecure is the -dev-insecure-local-docker flag.
	DevInsecure bool
	// Getenv reads DevEnv; os.Getenv when nil.
	Getenv func(string) string
	// Out receives the warning banner; os.Stderr when nil.
	Out io.Writer
	Log *slog.Logger
}

// Driver labels every container with the claim's tags (Docker labels never
// change, which suits kodus:hard-expires) and keeps kodus:expires in a JSON
// state file, so a restarted cell still knows when each machine expires.
type Driver struct {
	docker Docker
	cfg    Config
	mu     sync.Mutex
	st     *state
	// getStatus and pollEvery drive the health check; tests replace them.
	getStatus func(ctx context.Context, url string) (int, error)
	pollEvery time.Duration
}

// Gate reports whether both halves of the dev gate are set.
func Gate(flag bool, getenv func(string) string) error {
	if getenv == nil {
		getenv = os.Getenv
	}
	if !flag || getenv(DevEnv) != "1" {
		return ErrNotDev
	}
	return nil
}

func New(ctx context.Context, docker Docker, cfg Config) (*Driver, error) {
	if err := Gate(cfg.DevInsecure, cfg.Getenv); err != nil {
		return nil, err
	}
	if cfg.CellID == "" || cfg.StateDir == "" {
		return nil, errors.New("localdocker: cell id and state dir required")
	}
	if cfg.Out == nil {
		cfg.Out = os.Stderr
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	fmt.Fprint(cfg.Out, Warning)
	cfg.Log.Warn("local-docker driver: NO ISOLATION, dev only, never with untrusted code", "cell", cfg.CellID)
	if _, err := docker.Version(ctx); err != nil {
		return nil, fmt.Errorf("localdocker: no Docker daemon: %w", err)
	}
	st, err := loadState(filepath.Join(cfg.StateDir, StateFile))
	if err != nil {
		return nil, fmt.Errorf("localdocker: state: %w", err)
	}
	return &Driver{docker: docker, cfg: cfg, st: st, getStatus: httpStatus, pollEvery: 500 * time.Millisecond}, nil
}

func (d *Driver) Kind() string { return Kind }

func (d *Driver) Capabilities() driver.Capabilities {
	return driver.Capabilities{Isolation: driver.IsolationNone, NestedContainers: true, Suspend: "stop", Arch: []string{"x86_64", "arm64"}}
}

func (d *Driver) Bake(context.Context, driver.BakeSpec) (driver.ImageRef, error) {
	return driver.ImageRef{}, fmt.Errorf("%w: localdocker builds the environment from the checkout at boot", driver.ErrUnsupported)
}

// saveLocked persists the state; the caller holds d.mu.
func (d *Driver) saveLocked() error {
	return d.st.save(filepath.Join(d.cfg.StateDir, StateFile))
}

func httpStatus(ctx context.Context, url string) (int, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

var _ driver.MachineDriver = (*Driver)(nil)

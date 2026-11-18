package main

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor/remotecache"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/localdocker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// driverEntry is one driver the cell can run: what it refuses before
// anything starts, and how it opens.
type driverEntry struct {
	// Gate refuses an invocation that may not run the driver at all: a
	// development gate, or a missing image without which it isolates nothing.
	Gate func(st settings, getenv func(string) string) error
	// Validate refuses settings the driver cannot honor.
	Validate func(st settings) error
	// Observers are the -observer modes its claims' observers run in; nil:
	// the driver runs no Run, so no observer, whatever the mode.
	Observers []string
	// Open builds the driver, fills cfg with it and its parts, and returns
	// what to close and how its claims reach their observers.
	Open func(ctx context.Context, w wiring, cfg *agent.Config) (opened, error)
}

// Observer modes (-observer).
const (
	observerInProcess = "inprocess"
	observerHTTP      = "http"
)

// drivers is every driver the cell can run, by the kind -driver (and
// docker-gvisor's -isolation-backend) resolves to.
var drivers = map[string]driverEntry{
	dockergvisor.Kind: {
		Gate: gateDockerGVisor, Validate: validateDockerGVisor,
		Observers: []string{observerHTTP}, Open: wireDockerGVisor,
	},
	microvm.Kind:     {Observers: []string{observerHTTP}, Open: wireMicroVM},
	fake.Kind:        {Gate: gateFake, Observers: []string{observerInProcess, observerHTTP}, Open: wireFake},
	localdocker.Kind: {Gate: gateLocalDocker, Observers: []string{observerInProcess}, Open: wireLocalDocker},
}

// driverAuto is -driver auto: docker-gvisor, the one production driver.
const driverAuto = "auto"

// selection is the driver this invocation runs.
type selection struct {
	// Kind is its key in drivers: microvm for docker-gvisor on firecracker.
	Kind string
	// Why says how -driver (and -isolation-backend) came to it.
	Why string
	// Backend is docker-gvisor's isolation backend; zero on other drivers.
	Backend isolation.Choice
	// BackendAuto: -isolation-backend auto chose Backend.
	BackendAuto bool
}

// hostFacts are what -driver auto and -isolation-backend auto look at.
type hostFacts struct {
	// ChooseBackend resolves -isolation-backend (isolation.Choose on the
	// probed host); kit: the operator gave a microVM kit and its digest.
	ChooseBackend func(requested string, kit bool) (isolation.Choice, error)
}

// probeHost is this process's host.
func probeHost() hostFacts {
	return hostFacts{
		ChooseBackend: func(requested string, kit bool) (isolation.Choice, error) {
			return isolation.Choose(requested, isolation.ProbeHost(), isolation.MicroVMReadiness{Kit: kit, RunsEnvironments: microvm.RunsEnvironments})
		},
	}
}

// selectDriver resolves -driver auto and docker-gvisor's isolation backend
// first, then checks the settings against the driver that will run: a flag
// another driver owns, set explicitly, is refused, then the driver's
// observer modes, gate and settings. st.Driver and st.IsolationBackend
// become what was resolved.
func selectDriver(st *settings, host hostFacts, getenv func(string) string) (selection, driverEntry, error) {
	sel, err := resolveDriver(st, host)
	if err != nil {
		return sel, driverEntry{}, err
	}
	e, ok := drivers[sel.Kind]
	if !ok {
		return sel, e, fmt.Errorf("unknown driver %q", st.Driver)
	}
	if err := checkFlagOwners(st.explicit, sel); err != nil {
		return sel, e, err
	}
	if err := checkObserverMode(sel.Kind, e.Observers, st.ObsMode); err != nil {
		return sel, e, err
	}
	if e.Gate != nil {
		if err := e.Gate(*st, getenv); err != nil {
			return sel, e, err
		}
	}
	if e.Validate != nil {
		if err := e.Validate(*st); err != nil {
			return sel, e, err
		}
	}
	return sel, e, nil
}

// resolveDriver turns -driver auto into a driver, and docker-gvisor into
// microvm when its isolation backend is firecracker.
func resolveDriver(st *settings, host hostFacts) (selection, error) {
	sel := selection{Why: "-driver " + st.Driver}
	switch st.Driver {
	case "":
		return sel, errors.New("-driver is required: docker-gvisor, auto, or local-docker / fake for development")
	case driverAuto:
		st.Driver, sel.Why = dockergvisor.Kind, "-driver auto: docker-gvisor"
	}
	sel.Kind = st.Driver
	if st.Driver != dockergvisor.Kind {
		return sel, nil
	}
	sel.BackendAuto = st.IsolationBackend == isolation.Auto || st.IsolationBackend == ""
	c, err := host.ChooseBackend(st.IsolationBackend, st.MicroVM.Kit != "" && st.MicroVM.KitDigest != "")
	if err != nil {
		return sel, err
	}
	sel.Backend, st.IsolationBackend = c, c.Backend
	sel.Why += "; isolation backend " + c.Backend + ": " + c.Why
	if c.Backend == isolation.Firecracker {
		sel.Kind = microvm.Kind // its machines are microVMs, not containers on the host's Docker
	}
	return sel, nil
}

// flagOwner says which drivers read a flag.
type flagOwner struct {
	// Name is a flag, or every flag that starts with it when it ends in "-"
	// (a name wins over a family).
	Name    string
	Drivers []string
	// ChoosesBackend: -isolation-backend auto reads it to choose, so
	// docker-gvisor on auto takes it whichever backend won.
	ChoosesBackend bool
}

// flagOwners are the flags only some drivers read. The cell refuses one of
// them, set on the command line or in the config file, when it runs
// another driver: it would do nothing there.
var flagOwners = []flagOwner{
	{Name: "gvisor-", Drivers: []string{dockergvisor.Kind}},
	{Name: "browser-explore", Drivers: []string{dockergvisor.Kind}},
	{Name: "docker-data-root", Drivers: []string{dockergvisor.Kind}},
	{Name: "disk-min-free-gb", Drivers: []string{dockergvisor.Kind}},
	{Name: "isolation-backend", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "host-policy", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "memory-admission", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "memory-reserve-mb", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "memory-allocatable-mb", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "firecracker-", Drivers: []string{microvm.Kind}},
	{Name: "firecracker-kit", Drivers: []string{microvm.Kind}, ChoosesBackend: true},
	{Name: "firecracker-kit-digest", Drivers: []string{microvm.Kind}, ChoosesBackend: true},
	{Name: "sandbox-pool", Drivers: []string{dockergvisor.Kind, microvm.Kind, fake.Kind}},
	{Name: "sandbox-guest-trace", Drivers: []string{dockergvisor.Kind, fake.Kind}},
	{Name: "sandbox-memory-mb", Drivers: []string{dockergvisor.Kind}},
	{Name: "sandbox-cpus", Drivers: []string{dockergvisor.Kind}},
	{Name: "sandbox-disk-mbps-per-cpu", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "sandbox-disk-iops-per-cpu", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "sandbox-net-mbps-per-cpu", Drivers: []string{dockergvisor.Kind, microvm.Kind}},
	{Name: "dev-insecure-local-docker", Drivers: []string{localdocker.Kind}},
}

// ownerOf is the flag's entry in flagOwners: its name, else its family.
func ownerOf(name string) (flagOwner, bool) {
	var family flagOwner
	found := false
	for _, o := range flagOwners {
		if o.Name == name {
			return o, true
		}
		if strings.HasSuffix(o.Name, "-") && strings.HasPrefix(name, o.Name) && len(o.Name) > len(family.Name) {
			family, found = o, true
		}
	}
	return family, found
}

// checkFlagOwners refuses every explicitly set flag the selected driver
// does not read, naming it and the driver.
func checkFlagOwners(explicit map[string]bool, sel selection) error {
	var errs []error
	for _, name := range slices.Sorted(maps.Keys(explicit)) {
		o, ok := ownerOf(name)
		if !ok || slices.Contains(o.Drivers, sel.Kind) || (o.ChoosesBackend && sel.BackendAuto) {
			continue
		}
		errs = append(errs, fmt.Errorf("-%s is read by %s only, and this cell runs %s (%s): remove it", name, strings.Join(o.Drivers, ", "), sel.Kind, sel.Why))
	}
	return errors.Join(errs...)
}

// checkObserverMode refuses an -observer mode the driver's claims cannot use.
func checkObserverMode(kind string, modes []string, mode string) error {
	if mode != observerInProcess && mode != observerHTTP {
		return fmt.Errorf("unknown observer mode %q", mode)
	}
	if modes == nil || slices.Contains(modes, mode) {
		return nil
	}
	return fmt.Errorf("-observer %s: the %s driver takes -observer %s", mode, kind, strings.Join(modes, " or "))
}

// gateDockerGVisor refuses a docker-gvisor cell without the images its
// machines run.
func gateDockerGVisor(st settings, _ func(string) string) error {
	if st.GVisorHolderImage == "" {
		return errors.New("docker-gvisor needs -gvisor-holder-image")
	}
	// Probes run on an observer machine of the claim: without its image
	// the observer is a bare holder and every probe would hang.
	if st.ObsMode == observerHTTP && st.GVisorObserverImage == "" {
		return errors.New("docker-gvisor with -observer http needs -gvisor-observer-image")
	}
	return nil
}

// validateDockerGVisor refuses docker-gvisor settings that need another:
// claim limits count on the memory admission, exploration on its image.
func validateDockerGVisor(st settings) error {
	if err := pinnedImages(st); err != nil {
		return err
	}
	if st.GVisorClaimLimits == "required" && !st.MemoryAdmission {
		return errors.New("required claim limits need physical memory admission (-memory-admission)")
	}
	if st.BrowserExplore && st.GVisorBrowserImage == "" {
		return errors.New("browser exploration requires a compatible pinned browser image (-gvisor-browser-image)")
	}
	return validateBakeShare(st)
}

// pinnedImageRE is a pinned image: repo@sha256:<64 hex> or an image id,
// sha256:<64 hex>. A malformed digest used to pass and fail at docker run.
var pinnedImageRE = regexp.MustCompile(`^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$`)

// pinnedImages refuses, outside -dev, an image flag that names a tag: a
// tag can be moved upstream or in a mirror, and every claim (the observer
// with its mTLS key mounted) would run what it now points at (S1-SUP-02).
// A digest (repo@sha256:...) or a local image id (sha256:...) is pinned;
// the helper image is checked by the driver the same way.
func pinnedImages(st settings) error {
	if st.Dev {
		return nil
	}
	for _, img := range []struct{ flag, ref string }{
		{"-gvisor-holder-image", st.GVisorHolderImage},
		{"-gvisor-observer-image", st.GVisorObserverImage},
		{"-gvisor-sandbox-image", st.Sandbox.Image},
		{"-gvisor-builder-image", st.GVisorBuilderImage},
		{"-gvisor-registry-image", st.GVisorRegistryImage},
		{"-gvisor-browser-image", st.GVisorBrowserImage},
	} {
		if img.ref != "" && !pinnedImageRE.MatchString(img.ref) {
			return fmt.Errorf("%s %q is not pinned (a tag can be moved under the cell): pin it by digest (repo@sha256:<64 hex>) or by image id (sha256:<64 hex>); -dev allows a tag", img.flag, img.ref)
		}
	}
	return nil
}

// validateBakeShare checks the shared-bake flags as the driver reads them
// (remotecache.New): a store it would refuse, a mirror or an auth file with
// no store.
func validateBakeShare(st settings) error {
	if st.GVisorBakeShare == "" {
		switch {
		case st.GVisorBakeSharePull != "":
			return errors.New("-gvisor-bake-share-pull mirrors -gvisor-bake-share, which is not set")
		case st.GVisorBakeShareAuthFile != "":
			return errors.New("-gvisor-bake-share-auth-file is for -gvisor-bake-share, which is not set")
		}
		return nil
	}
	if _, err := remotecache.New(remotecache.Config{URL: st.GVisorBakeShare}); err != nil {
		return fmt.Errorf("-gvisor-bake-share: %w", err)
	}
	if st.GVisorBakeSharePull != "" {
		if _, err := remotecache.New(remotecache.Config{URL: st.GVisorBakeSharePull}); err != nil {
			return fmt.Errorf("-gvisor-bake-share-pull: %w", err)
		}
	}
	return nil
}

// gateFake: the fake driver isolates nothing.
func gateFake(st settings, _ func(string) string) error {
	if !st.Dev {
		return errors.New("the fake driver isolates nothing: it runs only with -dev")
	}
	return nil
}

func gateLocalDocker(st settings, getenv func(string) string) error {
	return localdocker.Gate(st.DevInsecureLocalDocker, getenv)
}

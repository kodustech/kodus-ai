package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/localdocker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hostcheck"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

// wiring is what a driver entry opens with.
type wiring struct {
	st     settings
	cellID string
	trust  machinetrust.Files
	log    *slog.Logger
}

// opened is what the cell keeps of an open driver.
type opened struct {
	// close releases what Open started, waiting for the driver's
	// background work until its context ends; nil: nothing.
	close func(context.Context) error
	// observers is how the claims reach their observer (and a preview
	// claim its upstream) in the cell's -observer mode.
	observers func() (agent.ObserverFactory, agent.PreviewUpstreamFactory, error)
}

func wireDockerGVisor(ctx context.Context, w wiring, cfg *agent.Config) (opened, error) {
	st, log := w.st, w.log
	if _, err := checkSharedHost(w, dockergvisor.Kind, cfg); err != nil {
		return opened{}, err
	}
	var closers []func(context.Context) error
	closeAll := func(ctx context.Context) error {
		var errs []error
		for i := len(closers) - 1; i >= 0; i-- {
			errs = append(errs, closers[i](ctx))
		}
		return errors.Join(errs...)
	}
	var limits claimlimits.Manager
	var budgets claimlimits.Resizer
	if st.GVisorClaimLimits == "required" {
		manager, err := configureClaimLimits(ctx, dockercli.CLI{}, st, w.cellID, log)
		if err != nil {
			return opened{}, fmt.Errorf("claim resource enforcement: %w", err)
		}
		closers = append(closers, func(context.Context) error { return manager.Close() })
		limits, budgets = manager, manager
		cfg.RequireMemoryAdmission = true
	}
	// Without ceiling flags a claim may ask what the host has (never less than the default).
	hostMB, err := allocatableMemoryMB(st.MemoryAllocatableMB, st.MemoryReserveMB, readMemTotalMB)
	if err != nil {
		hostMB = 0
	}
	remoteAuth, err := readAuthFile(st.GVisorBuildCacheRemoteAuthFile)
	if err != nil {
		_ = closeAll(ctx)
		return opened{}, fmt.Errorf("gvisor-build-cache-remote-auth-file: %w", err)
	}
	shareAuth, err := readAuthFile(st.GVisorBakeShareAuthFile)
	if err != nil {
		_ = closeAll(ctx)
		return opened{}, fmt.Errorf("gvisor-bake-share-auth-file: %w", err)
	}
	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{
		HostMemoryMB: hostMB, HostCPUs: runtime.NumCPU(),
		BakeStateDir: filepath.Join(st.StateDir, "bakes"), IOLimits: st.MicroVM.gvisorIOLimits(),
		ClaimLimits: limits, ClaimBudgets: budgets, ClaimLimitBackend: st.GVisorClaimLimitBackend, CellID: w.cellID, BakeAdoptOrg: bakeAdoptOrg(hostSealUnitFile, st.Cert, st.Owner), HolderImage: st.GVisorHolderImage, SandboxImage: st.Sandbox.Image, WorkDir: filepath.Join(st.WorkDir, "compose"), EgressContainer: st.GVisorEgressContainer, BuilderImage: st.GVisorBuilderImage, BuilderTrustsCellCA: builderTrustsCellCA(st.GVisorBuilderImage, st.GVisorBuilderTrust), HelperImage: st.GVisorHelperImage, MaxBuilds: st.GVisorMaxBuilds, MirrorGoProxy: st.GVisorMirrorGoProxy, MirrorNPM: st.GVisorMirrorNPM, MirrorPyPI: st.GVisorMirrorPyPI, MirrorArtifacts: st.GVisorMirrorArtifacts, MirrorRegistry: st.GVisorMirrorRegistry, MemLimit: st.GVisorMemLimit,
		MemMax: st.GVisorMemMax, CPUsMax: st.GVisorCPUsMax, MemReady: st.GVisorMemReady, HealthStartInterval: st.GVisorHealthStart, NoGoldenData: !st.GVisorGoldenData, WarmForkReset: st.GVisorWarmForkReset, BuilderUID: st.GVisorBuilderUID, BuilderGID: st.GVisorBuilderGID,
		PersistBuildState: st.GVisorBuildState, BuildStateKeep: st.GVisorBuildStateKeep, BuildStateMinFreeBytes: int64(st.GVisorBuildStateMinFreeGB) << 30,
		BuildCacheRemote: st.GVisorBuildCacheRemote, BuildCacheRemoteAuth: remoteAuth,
		BakeShare: st.GVisorBakeShare, BakeSharePull: st.GVisorBakeSharePull, BakeShareAuth: shareAuth,
		MaxImageBytes: int64(st.GVisorMaxImageGB) << 30, ContainerDiskSize: st.GVisorContainerDisk, DiskMinFreeBytes: int64(st.DiskMinFreeGB) << 30,
		ServiceLogMaxSize: st.GVisorServiceLogMaxSize, ServiceLogMaxFile: st.GVisorServiceLogMaxFile,
		ImageTransfer: st.GVisorImageTransfer, RegistryImage: st.GVisorRegistryImage, RegistryKeepBytes: int64(st.GVisorRegistryKeepGB) << 30,
		ObserverImage: st.GVisorObserverImage, ObserverTLSDir: st.GVisorObserverTLS, CellImages: []string{st.GVisorBrowserImage}, Log: log.With("driver", dockergvisor.Kind),
		Trust: w.trust, ToolLayers: toolLayerConfig(st),
	})
	if err != nil {
		_ = closeAll(ctx)
		return opened{}, err
	}
	closers = append(closers, d.Shutdown)
	cfg.DiskWatch = diskWatch(st.DockerDataRoot, st.DiskMinFreeGB)
	cfg.RecoveryContext = ctx
	// The project boots from the checkout through the driver (Up), so
	// the transport carries no upload; exec runs in the project's public
	// service container, under gVisor (Driver.Exec).
	cfg.Driver, cfg.Parts, cfg.Transport = d, d.Parts(), transport.Compose{Run: d.Exec}
	cfg.FakeSupport = true
	cfg.CellTrust = w.trust.Set()
	if st.GVisorBrowserImage != "" {
		// Browser probes in the runner image, one container per round (ADR-071).
		if err := dockergvisor.CheckBrowserImage(st.GVisorBrowserImage); err != nil {
			_ = closeAll(ctx)
			return opened{}, fmt.Errorf("browser image: %w", err)
		}
		br := dockergvisor.BrowserRunner{Driver: d, Image: st.GVisorBrowserImage}
		cfg.Browser = br
		if st.BrowserExplore {
			if err := d.CheckBrowserExploreImage(ctx, st.GVisorBrowserImage); err != nil {
				_ = closeAll(ctx)
				return opened{}, fmt.Errorf("browser exploration image: %w", err)
			}
			cfg.BrowserExplore = br
		}
	}
	if cfg.Parts.Sandboxes != nil {
		cfg.SandboxPool = st.Sandbox.Pool
		cfg.GuestTraceContext = st.Sandbox.GuestTrace
		cfg.SandboxSize = driver.ClaimSize{MemoryMB: st.Sandbox.MemoryMB, CPUs: st.Sandbox.CPUs}
	}
	cfg.OrgKey = func(org string) (string, error) { return "docker-gvisor-" + org, nil }
	return opened{close: closeAll, observers: func() (agent.ObserverFactory, agent.PreviewUpstreamFactory, error) {
		// Each exposed service is a container of its own on the claim network.
		return httpObserversOf(st, func(c agent.ClaimInfo, in []observer.Target) ([]observer.Target, error) {
			return d.Targets(c.Workload.MachineID, in)
		}, d)
	}}, nil
}

func wireMicroVM(ctx context.Context, w wiring, cfg *agent.Config) (opened, error) {
	policy, err := checkSharedHost(w, microvm.Kind, cfg)
	if err != nil {
		return opened{}, err
	}
	w.st.MicroVM.HostPolicy = policy // a microVM cell refuses an unsafe shared host in Open, with its other prerequisites
	d, err := openMicroVM(ctx, w.st, w.cellID, w.trust, w.log)
	if err != nil {
		return opened{}, err
	}
	// A Run's commands, uploads, compose project and recipe go into its
	// environment VM through the guest agent; a setup's bake is the
	// environment's template; the observer is a VM of its own. A failed
	// setup's bundle carries each VM's states and VMM log, kept past its jail.
	cfg.Driver, cfg.Parts, cfg.Transport = d, d.Parts(), d
	cfg.SandboxPool = w.st.Sandbox.Pool
	cfg.CellTrust = w.trust.Set()
	cfg.OrgKey = func(org string) (string, error) { return "microvm-" + org, nil }
	return opened{observers: func() (agent.ObserverFactory, agent.PreviewUpstreamFactory, error) {
		obsTLS, hc, err := observerClient(w.st)
		if err != nil {
			return nil, nil, err
		}
		// An observer VM is reached over its vsock only: no TCP into a VM.
		f := microvmObservers(obsTLS, d)
		return f, httpPreviewUpstreams(f, hc.Transport), nil
	}}, nil
}

func wireFake(_ context.Context, w wiring, cfg *agent.Config) (opened, error) {
	st := w.st
	d := fake.NewForCell(w.cellID)
	cfg.Driver, cfg.Parts = d, d.Parts()
	cfg.Transport = transport.Local{Root: filepath.Join(st.WorkDir, "machines")}
	cfg.Parts.Sandboxes, cfg.SandboxPool = fake.Sandboxes{Driver: d, Root: filepath.Join(st.WorkDir, "machines"), Trust: w.trust}, st.Sandbox.Pool
	cfg.CellTrust = w.trust.Set()
	cfg.GuestTraceContext = st.Sandbox.GuestTrace
	cfg.OrgKey = func(org string) (string, error) { return "fake-key-" + org, nil }
	cfg.DevAllowInsecureIsolation = true // behind -dev (gateFake)
	return opened{observers: func() (agent.ObserverFactory, agent.PreviewUpstreamFactory, error) {
		if st.ObsMode == observerInProcess {
			f, p := inProcessObservers(nil)
			return f, p, nil
		}
		return httpObserversOf(st, nil)
	}}, nil
}

func wireLocalDocker(ctx context.Context, w wiring, cfg *agent.Config) (opened, error) {
	st := w.st
	d, err := localdocker.New(ctx, localdocker.CLI{}, localdocker.Config{
		CellID: w.cellID, StateDir: st.StateDir, MachinesDir: filepath.Join(st.WorkDir, "machines"),
		DevInsecure: st.DevInsecureLocalDocker, Log: w.log,
	})
	if err != nil {
		return opened{}, err
	}
	// The driver's gate passed (flag + KODY_RUNTIME_DEV=1); the hub
	// still refuses the cell unless RUNTIME_DEV_ALLOW_INSECURE_CELLS=1.
	cfg.Driver, cfg.Parts, cfg.Transport, cfg.DevAllowInsecureIsolation = d, d.Parts(), d.Transport(), true
	cfg.Manifests = d
	cfg.FakeSupport = true
	cfg.OrgKey = func(org string) (string, error) { return "local-docker-" + org, nil }
	return opened{observers: func() (agent.ObserverFactory, agent.PreviewUpstreamFactory, error) {
		// The app is published on a host port Docker picked.
		f, p := inProcessObservers(d.Targets)
		return f, p, nil
	}}, nil
}

// checkSharedHost probes the host the sandboxes share (a driver whose
// machines run on this host): a shared docker-gvisor cell refuses an unsafe
// one (a microVM cell refuses it in Open, with its other prerequisites), a
// dedicated one reports it. It returns the policy -host-policy resolved to.
func checkSharedHost(w wiring, kind string, cfg *agent.Config) (string, error) {
	policy, err := hostPolicyFor(w.st.HostPolicy, kind)
	if err != nil {
		return "", err
	}
	host := hostcheck.Probe(nil, "/", policy)
	if unsafe := host.Unsafe(); len(unsafe) > 0 {
		if policy == hostcheck.Shared && kind != microvm.Kind {
			return "", fmt.Errorf("a shared cell's host: %s", strings.Join(unsafe, "; "))
		}
		w.log.Warn("host.unsafe", "policy", policy, "findings", unsafe)
	}
	cfg.Host = hostReport(host)
	return policy, nil
}

// inProcessObservers runs each claim's observer inside the cell (the fake
// and local-docker cells, ADR-053); remap moves the targets to where the app
// is published (nil: as given).
func inProcessObservers(remap func(claimID string, in []observer.Target) ([]observer.Target, error)) (agent.ObserverFactory, agent.PreviewUpstreamFactory) {
	targetsOf := func(c agent.ClaimInfo, targets []observer.Target) ([]observer.Target, error) {
		if remap == nil {
			return targets, nil
		}
		return remap(c.ClaimID, targets)
	}
	observers := func(_ context.Context, c agent.ClaimInfo, targets []observer.Target) (observer.Client, error) {
		targets, err := targetsOf(c, targets)
		if err != nil {
			return nil, err
		}
		return observer.InProcess{Runner: observer.New(observer.Config{ImageID: c.Workload.ImageID, Targets: targets})}, nil
	}
	previews := func(_ context.Context, c agent.ClaimInfo, targets []observer.Target) (http.Handler, error) {
		targets, err := targetsOf(c, targets)
		if err != nil {
			return nil, err
		}
		return observer.PreviewHandler(targets), nil
	}
	return observers, previews
}

// observerClient is the cell's mTLS client of the observer machines. Its
// certificate is read again whenever the files change: -observer-cert is
// often the cell's own identity, which the renewer replaces long before the
// process ends, and an observer refuses the expired one at its handshake.
func observerClient(st settings) (*tls.Config, *http.Client, error) {
	obsTLS, err := tlsutil.ReloadingClient(st.ObsCert, st.ObsKey, st.ObsCA)
	if err != nil {
		return nil, nil, fmt.Errorf("observer tls: %w", err)
	}
	// An observer's address is only known once it runs: its
	// certificate names it instead (the observer CA issues only those).
	obsTLS.ServerName = st.ObsServerName
	return obsTLS, &http.Client{Transport: &http.Transport{TLSClientConfig: obsTLS}, Timeout: 11 * time.Minute}, nil
}

// httpObserversOf is each claim's observer machine over mTLS, and a
// preview claim's upstream through it.
func httpObserversOf(st settings, remap func(agent.ClaimInfo, []observer.Target) ([]observer.Target, error), sqlProviders ...driver.SQLObserverProvisioner) (agent.ObserverFactory, agent.PreviewUpstreamFactory, error) {
	_, hc, err := observerClient(st)
	if err != nil {
		return nil, nil, err
	}
	f := httpObservers(hc, remap, sqlProviders...)
	return f, httpPreviewUpstreams(f, hc.Transport), nil
}

// toolLayerConfig is the driver's tool layer settings (-gvisor-toollayer*).
func toolLayerConfig(st settings) dockergvisor.ToolLayerConfig {
	return dockergvisor.ToolLayerConfig{
		Enabled:       st.GVisorToolLayer,
		MaxLayerBytes: int64(st.GVisorToolLayerMaxMB) << 20, MaxOrgBytes: int64(st.GVisorToolLayerOrgGB) << 30, MaxCellBytes: int64(st.GVisorToolLayerBudgetGB) << 30,
	}
}

// Command cell is the cell agent (docs §4): the outbound connection to the
// runtime-hub, the leases, the dead-man switch, the repo tarball and the
// claim's observer. "cell extract" is the no-network extraction child. This
// file only wires: every part it builds lives in a package.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/awsec2"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/localdocker"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/enrollment"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/gitsource"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/transport"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "extract" {
		os.Exit(tarball.RunExtractChild(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && (os.Args[1] == "register" || os.Args[1] == "renew") {
		os.Exit(runEnroll(os.Args[1], os.Args[2:], os.Stdout, os.Stderr))
	}
	st, err := parseSettings(flag.CommandLine, os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if err := checkDriverGate(st, os.Getenv); err != nil {
		// Refuse before touching anything else (keys, Docker, the hub).
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	// One identity for every client of the cell: the hub WebSocket, the
	// egress control, the renewal. Each reads the holder at its handshake,
	// so a renewal reaches all of them; a live connection keeps the
	// certificate it was opened with.
	holder, err := enrollment.LoadCertHolder(st.Cert, st.Key)
	must(log, "cell identity", err)
	cellID, err := resolveCellID(st.CellID, holder.CellID())
	must(log, "cell identity", err)
	roots, err := tlsutil.Pool(st.CA)
	must(log, "hub ca", err)
	reg := metrics.NewRegistry()
	if st.AutoRenew {
		hub, err := enrollment.HTTPSBase(st.HubURL)
		must(log, "auto-renew", err)
		r := &enrollment.Renewer{Holder: holder, Hub: hub, Roots: roots, Log: log, Metrics: reg,
			Paths: enrollment.Paths{Key: st.Key, Cert: st.Cert, CA: st.CA, Issuer: st.Issuer}}
		go r.Run(ctx)
	}
	must(log, "metrics", serveMetrics(ctx, log, st.MetricsAddr, reg))
	exe, err := os.Executable()
	must(log, "executable", err)

	git := gitsource.GitHub{APIBase: st.GitAPI}
	cfg := agent.Config{
		MaxClaimSteps:          st.MaxClaimSteps,
		RequireMemoryAdmission: st.GVisorClaimLimits == "required",
		CellID:                 cellID,
		WorkDir:                st.WorkDir,
		Extractor:              tarball.NetNSExtractor{Command: []string{exe, "extract"}, AllowWithoutNetNS: st.Dev},
		Revoker:                git,
		// claim.acquire names the repo; the cell builds the URL from
		// validated parts, on the Git API it was configured with.
		Repo:    func(acq protocol.ClaimAcquireBody) (string, error) { return git.TarballURL(acq.Repo, acq.Sha) },
		Log:     log,
		Metrics: reg,
	}
	var localDocker *localdocker.Driver
	var gvisor *dockergvisor.Driver
	if st.Regions != "" {
		cfg.Regions = strings.Split(st.Regions, ",")
	}
	switch st.Driver {
	case "fake":
		d := fake.NewForCell(cellID)
		cfg.Driver, cfg.Diagnoser = d, d
		cfg.Transport = transport.Local{Root: filepath.Join(st.WorkDir, "machines")}
		cfg.OrgKey = func(org string) (string, error) { return "fake-key-" + org, nil }
		cfg.DevAllowInsecureIsolation = true // behind -dev (checkDriverGate)
	case "aws-ec2":
		var ac awsConfig
		b, err := os.ReadFile(st.AWSConfig)
		must(log, "aws config", err)
		must(log, "aws config", json.Unmarshal(b, &ac))
		sdk, err := config.LoadDefaultConfig(ctx)
		must(log, "aws sdk", err)
		orgKey := func(org string) (string, error) {
			k, ok := ac.OrgKeys[org]
			if !ok {
				return "", fmt.Errorf("no KMS key for org %s", org)
			}
			return k, nil
		}
		d, err := awsec2.New(ec2.NewFromConfig(sdk), awsec2.Config{
			CellID: cellID, VPCID: ac.VPCID, LaunchTemplateID: ac.LaunchTemplateID, LaunchTemplateVersion: ac.LaunchTemplateVersion,
			WorkloadSubnetID: ac.WorkloadSubnetID, ObserverSubnetID: ac.ObserverSubnetID, CellAgentGroupID: ac.CellAgentGroupID,
			EgressGroupID: ac.EgressGroupID, ObserverImageRef: ac.ObserverImageRef, OrgKey: orgKey, Hibernate: ac.Hibernate,
		})
		must(log, "aws-ec2", err)
		ssh := &transport.SSH{User: "runner"}
		cfg.Driver, cfg.OrgKey, cfg.Transport = d, orgKey, ssh
		cfg.Keys, cfg.Secrets = ssh, []agent.ClaimSecretSource{ssh}
	case dockergvisor.Kind:
		var limits claimlimits.Manager
		if st.GVisorClaimLimits == "required" {
			manager, err := configureClaimLimits(ctx, dockercli.CLI{}, st, cellID)
			must(log, "claim resource enforcement", err)
			defer manager.Close()
			limits = manager
		}
		d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{
			BakeStateDir: filepath.Join(st.StateDir, "bakes"),
			ClaimLimits:  limits, ClaimLimitBackend: st.GVisorClaimLimitBackend, CellID: cellID, HolderImage: st.GVisorHolderImage, WorkDir: filepath.Join(st.WorkDir, "compose"), EgressContainer: st.GVisorEgressContainer, BuilderImage: st.GVisorBuilderImage, HelperImage: st.GVisorHelperImage, MirrorGoProxy: st.GVisorMirrorGoProxy, MirrorRegistry: st.GVisorMirrorRegistry, MemLimit: st.GVisorMemLimit,
			MemMax: st.GVisorMemMax, CPUsMax: st.GVisorCPUsMax, MemReady: st.GVisorMemReady, HealthStartInterval: st.GVisorHealthStart, NoGoldenData: !st.GVisorGoldenData, BuilderUID: st.GVisorBuilderUID, BuilderGID: st.GVisorBuilderGID,
			PersistBuildState: st.GVisorBuildState, BuildStateKeep: st.GVisorBuildStateKeep, BuildStateMinFreeBytes: int64(st.GVisorBuildStateMinFreeGB) << 30,
			ObserverImage: st.GVisorObserverImage, ObserverTLSDir: st.GVisorObserverTLS, Log: log.With("driver", dockergvisor.Kind),
		})
		must(log, "docker-gvisor", err)
		defer d.Close()
		cfg.BakeCatalog = d
		cfg.RecoveryContext = ctx
		// The project boots from the checkout through the driver (Up), so
		// the transport carries no upload; exec runs in the project's public
		// service container, under gVisor (Driver.Exec).
		cfg.Driver, cfg.Composer, cfg.BakePinner, cfg.Pooler, cfg.Transport = d, d, d, d, transport.Compose{Run: d.Exec}
		cfg.Diagnoser, cfg.BootTimes = d, d
		cfg.FakeSupport, cfg.SQLObservers = true, d
		cfg.ServiceLogs = d // a probe round's service logs (EVIDENCE-CAPTURE-DESIGN)
		if st.GVisorBrowserImage != "" {
			// Browser probes in the runner image, one container per round (ADR-071).
			must(log, "browser image", dockergvisor.CheckBrowserImage(st.GVisorBrowserImage))
			br := dockergvisor.BrowserRunner{Driver: d, Image: st.GVisorBrowserImage}
			cfg.Browser = br
			if st.BrowserExplore {
				must(log, "browser exploration image", d.CheckBrowserExploreImage(ctx, st.GVisorBrowserImage))
				cfg.BrowserExplore = br
			}
		}
		go sweepExpired(ctx, log, "docker-gvisor", d.Sweep)
		gvisor = d
		cfg.OrgKey = func(org string) (string, error) { return "docker-gvisor-" + org, nil }
	case localdocker.Kind:
		d, err := localdocker.New(ctx, localdocker.CLI{}, localdocker.Config{
			CellID: cellID, StateDir: st.StateDir, MachinesDir: filepath.Join(st.WorkDir, "machines"),
			DevInsecure: st.DevInsecureLocalDocker, Log: log,
		})
		must(log, "local-docker", err)
		go sweepLocalDocker(ctx, log, d)
		// The driver's gate passed (flag + KODY_RUNTIME_DEV=1); the hub
		// still refuses the cell unless RUNTIME_DEV_ALLOW_INSECURE_CELLS=1.
		cfg.Driver, cfg.Transport, cfg.DevAllowInsecureIsolation = d, d.Transport(), true
		cfg.Manifests, cfg.BootTimes, cfg.Diagnoser = d, d, d
		cfg.FakeSupport = true
		cfg.OrgKey = func(org string) (string, error) { return "local-docker-" + org, nil }
		localDocker = d
	default:
		must(log, "driver", fmt.Errorf("unknown driver %q", st.Driver))
	}

	switch st.ObsMode {
	case "inprocess":
		if st.Driver != "fake" && st.Driver != localdocker.Kind {
			must(log, "observer", errors.New("in-process observer is for the fake and local-docker cells only (ADR-053)"))
		}
		cfg.Observers = func(_ context.Context, c agent.ClaimInfo, targets []observer.Target) (observer.Client, error) {
			if localDocker != nil {
				// The app is published on a host port Docker picked.
				var err error
				if targets, err = localDocker.Targets(c.ClaimID, targets); err != nil {
					return nil, err
				}
			}
			return observer.InProcess{Runner: observer.New(observer.Config{ImageID: c.Workload.ImageID, Targets: targets})}, nil
		}
	case "http":
		if st.Driver == localdocker.Kind {
			must(log, "observer", errors.New("local-docker has no observer machine; use -observer inprocess"))
		}
		obsTLS, err := tlsutil.Client(st.ObsCert, st.ObsKey, st.ObsCA)
		must(log, "observer tls", err)
		// An observer's address is only known once it runs: its
		// certificate names it instead (the observer CA issues only those).
		obsTLS.ServerName = st.ObsServerName
		hc := &http.Client{Transport: &http.Transport{TLSClientConfig: obsTLS}, Timeout: 11 * time.Minute}
		var targets func(agent.ClaimInfo, []observer.Target) ([]observer.Target, error)
		if gvisor != nil {
			// Each exposed service is a container of its own on the claim network.
			targets = func(c agent.ClaimInfo, in []observer.Target) ([]observer.Target, error) {
				return gvisor.Targets(c.Workload.MachineID, in)
			}
		}
		if gvisor != nil {
			cfg.Observers = httpObservers(hc, targets, gvisor)
		} else {
			cfg.Observers = httpObservers(hc, targets)
		}
	default:
		must(log, "observer", fmt.Errorf("unknown observer mode %q", st.ObsMode))
	}

	if st.EgressEPs != "" {
		// Every component that enforces a claim's policy, by name: the
		// proxy, the resolver and the injector (whose alerts the agent
		// also watches).
		eps, err := control.ParseEndpoints(st.EgressEPs, control.RequiredEndpoints...)
		must(log, "egress-control", err)
		k, err := tlsutil.PrivateKey(st.PolicyKey)
		must(log, "policy key", err)
		var base []string
		if st.EgressBase != "" {
			base = strings.Split(st.EgressBase, ",")
		}
		cellTLS := &http.Transport{TLSClientConfig: holder.ClientTLS(roots)}
		egressPolicy := policyPusher{
			client: control.Pusher{Endpoints: eps, HTTP: &http.Client{Transport: cellTLS, Timeout: 10 * time.Second}, Key: k},
			base:   base,
			log:    log,
			refused: reg.Counter("cell_egress_hosts_denied_total",
				"Hosts a claim's egress allowlist asked for that the platform denies; left out of the signed policy."),
		}
		cfg.Egress = egressPolicy
		cfg.RecipeEgress = egressPolicy
		cfg.Alerts = injectorAlerts{&injector.AlertClient{URL: control.URL(eps, control.EndpointInjector), HTTP: &http.Client{Transport: cellTLS, Timeout: time.Minute}}}
		cfg.DeniedEgress = deniedEgress{r: control.DeniedReader{Endpoints: eps, HTTP: &http.Client{Transport: cellTLS, Timeout: 10 * time.Second}}, log: log}
		cfg.Outbound = outboundCalls{control.OutboundReader{Endpoints: eps, HTTP: &http.Client{Transport: cellTLS, Timeout: 10 * time.Second}}}
	}

	cfg.Driver = driver.Observed(cfg.Driver, reg, log)
	if _, shared := driver.MemoryBudgetOf(cfg.Driver); shared && st.MemoryAdmission {
		mb, err := allocatableMemoryMB(st.MemoryAllocatableMB, st.MemoryReserveMB, readMemTotalMB)
		if err != nil {
			// Never a guess: without a figure the cell admits by free slots, as before.
			log.Warn("memory.admission_off", "err", err)
		} else {
			cfg.MemoryAllocatableMB = mb
			log.Info("memory.admission", "allocatableMb", mb, "reserveMb", st.MemoryReserveMB)
		}
	}
	a, err := agent.New(cfg)
	must(log, "agent", err)
	must(log, "run", a.Run(ctx, agent.RunConfig{HubURL: st.HubURL, TLS: holder.ClientTLS(roots)}))
}

// checkDriverGate refuses a driver this invocation may not run: none is a
// default, and the two without isolation need their development gates.
func checkDriverGate(st settings, getenv func(string) string) error {
	switch st.Driver {
	case "":
		return errors.New("-driver is required: aws-ec2, docker-gvisor, or local-docker / fake for development")
	case dockergvisor.Kind:
		if st.GVisorHolderImage == "" {
			return errors.New("docker-gvisor needs -gvisor-holder-image")
		}
		// Probes run on an observer machine of the claim: without its image
		// the observer is a bare holder and every probe would hang.
		if st.ObsMode == "http" && st.GVisorObserverImage == "" {
			return errors.New("docker-gvisor with -observer http needs -gvisor-observer-image")
		}
	case "fake":
		if !st.Dev {
			return errors.New("the fake driver isolates nothing: it runs only with -dev")
		}
	case localdocker.Kind:
		return localdocker.Gate(st.DevInsecureLocalDocker, getenv)
	}
	return nil
}

// resolveCellID is the cell id: the certificate's CN, which the hub checks
// on every frame. A configured id must be that CN.
func resolveCellID(configured, certCN string) (string, error) {
	if configured != "" && configured != certCN {
		return "", fmt.Errorf("-cell-id %q is not the certificate's CN %q: the hub would refuse every frame", configured, certCN)
	}
	return certCN, nil
}

// serveMetrics serves /metrics on addr until ctx ends ("" or "off": not
// at all).
func serveMetrics(ctx context.Context, log *slog.Logger, addr string, reg *metrics.Registry) error {
	if addr == "" || addr == "off" {
		return nil
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", reg.Handler())
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	go func() {
		if err := srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("metrics.serve", "err", err)
		}
	}()
	log.Info("metrics.listening", "addr", l.Addr().String())
	return nil
}

type awsConfig struct {
	VPCID                 string            `json:"vpcId"`
	LaunchTemplateID      string            `json:"launchTemplateId"`
	LaunchTemplateVersion string            `json:"launchTemplateVersion"`
	WorkloadSubnetID      string            `json:"workloadSubnetId"`
	ObserverSubnetID      string            `json:"observerSubnetId"`
	CellAgentGroupID      string            `json:"cellAgentGroupId"`
	EgressGroupID         string            `json:"egressGroupId"`
	ObserverImageRef      string            `json:"observerImageRef"`
	Hibernate             bool              `json:"hibernate"`
	OrgKeys               map[string]string `json:"orgKeys"`
}

// observerConfig binds the observer machine to its claim: it refuses frames
// for any other.
func observerConfig(c agent.ClaimInfo, targets []observer.Target) observer.ClaimConfig {
	return observer.ClaimConfig{ClaimID: c.ClaimID, ImageID: c.Workload.ImageID, Targets: targets}
}

// httpObservers configures the claim's observer machine, retrying while it
// boots, and returns a client for it.
func httpObservers(hc *http.Client, remap func(agent.ClaimInfo, []observer.Target) ([]observer.Target, error), sqlProviders ...driver.SQLObserverProvisioner) agent.ObserverFactory {
	return func(ctx context.Context, c agent.ClaimInfo, targets []observer.Target) (observer.Client, error) {
		if remap != nil {
			var err error
			if targets, err = remap(c, targets); err != nil {
				return nil, err
			}
		}
		cc := observerConfig(c, targets)
		if c.ObserverGeneration > 0 {
			if len(sqlProviders) != 1 || sqlProviders[0] == nil {
				return nil, errors.New("observer: SQL credentials unavailable")
			}
			cc.Generation = c.ObserverGeneration
			cc.SQL = sqlProviders[0].ObserverSQLCredentials(c.Workload.MachineID)
			if len(cc.SQL) == 0 {
				return nil, errors.New("observer: SQL credentials unavailable")
			}
		}
		base := "https://" + net.JoinHostPort(c.Observer.PrivateAddress, "7443")
		return observerclient.Configure(ctx, hc, base, cc)
	}
}

type policyPusher struct {
	client control.Pusher
	base   []string
	// deny is the platform's deny list; the proxy and the resolver add the
	// operator's own entries on their side.
	deny    netguard.DenyList
	log     *slog.Logger
	refused *metrics.Vec
}

func (p policyPusher) CheckRecipeEgress(rec *recipe.Recipe, approved []string) error {
	return agent.CheckRecipeEgress(rec, p.base, approved, p.deny.Denies)
}

func (p policyPusher) Apply(ctx context.Context, c agent.ClaimInfo) error {
	phase := policy.PhaseTest
	if c.Acquire.Side == protocol.SideSetup {
		phase = policy.PhaseBuild
	}
	hard, err := protocol.ParseTime(c.Acquire.HardExpiresAt)
	if err != nil {
		return fmt.Errorf("egress policy expiry: %w", err)
	}
	pol, refused, err := policy.Build(policy.Spec{
		ClaimID: c.ClaimID, OrgID: c.Acquire.OrgID, EnvironmentID: c.Acquire.EnvironmentID, Phase: phase,
		// The machines, the compose containers and what the driver runs
		// for the claim (the image builder).
		Sources:    append(append([]string{c.Workload.PrivateAddress, c.Observer.PrivateAddress}, c.Sources...), c.Network.Sources...),
		Base:       p.base,
		Extra:      c.ExtraAllow, // the hub's egress.policy
		AppAddress: c.Workload.PrivateAddress,
		// On a network with no route out, every allowed name leads to the proxy.
		SteerTo:   c.Network.EgressAddress,
		GoPins:    c.GoPins,
		ImagePins: c.ImagePins,
		ExpiresAt: hard, IssuedAt: time.Now().UTC(),
	}, p.deny.Denies)
	if err != nil {
		return err
	}
	if len(refused) > 0 {
		p.refused.Add(float64(len(refused)))
		p.log.Warn("egress.policy.denied_hosts", "claim", c.ClaimID, "org", c.Acquire.OrgID, "hosts", refused)
	}
	return p.client.Push(ctx, pol)
}

func (p policyPusher) Remove(ctx context.Context, claimID string) error {
	return p.client.Remove(ctx, claimID)
}

// sweepLocalDocker destroys local-docker projects past their expiry, and
// labelled ones the state file lost (a crashed laptop cell), every minute.
// sweepExpired removes, at start and every minute, what a crashed or killed
// cell left past its claims' ceilings (docker-gvisor builders and machines).
// For docker-gvisor it also starts the reclaim of the disk no build holds
// (its BuildKit states below the disk floor), which runs on a goroutine of
// the driver's and never holds this loop.
func sweepExpired(ctx context.Context, log *slog.Logger, driver string, sweep func(context.Context, time.Time) ([]string, error)) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		gone, err := sweep(ctx, time.Now())
		if len(gone) > 0 || err != nil {
			log.Warn(driver+".sweep", "destroyed", gone, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func sweepLocalDocker(ctx context.Context, log *slog.Logger, d *localdocker.Driver) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		gone, err := d.Sweep(ctx, time.Now())
		if len(gone) > 0 || err != nil {
			log.Warn("local-docker.sweep", "destroyed", gone, "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// deniedEgress is what the proxy and the resolver refused a claim, for its
// failure bundle (the product's catalog offers to approve each host).
type deniedEgress struct {
	r   control.DeniedReader
	log *slog.Logger
}

func (d deniedEgress) Denied(claimID string) []agent.DeniedEgress {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	got, err := d.r.Denied(ctx, claimID)
	if err != nil {
		d.log.Warn("bundle.denied_egress", "claim", claimID, "err", err)
	}
	out := make([]agent.DeniedEgress, 0, len(got))
	for _, g := range got {
		out = append(out, agent.DeniedEgress{Host: g.Host, Port: g.Port, At: g.At, Platform: g.Platform})
	}
	return out
}

// outboundCalls is a claim's egress in a probe round's window, let through
// or refused, for its outbound evidence.
type outboundCalls struct{ r control.OutboundReader }

func (o outboundCalls) Outbound(ctx context.Context, claimID string, since, until time.Time) ([]agent.OutboundCall, error) {
	got, err := o.r.Outbound(ctx, claimID, since, until)
	out := make([]agent.OutboundCall, 0, len(got))
	for _, g := range got {
		out = append(out, agent.OutboundCall{Host: g.Host, Port: g.Port, At: g.At, Allowed: g.Allowed})
	}
	return out, err
}

// injectorAlerts is the injector's alert feed for the agent.
type injectorAlerts struct{ c *injector.AlertClient }

func (i injectorAlerts) Alerts(ctx context.Context, after int64) ([]agent.Alert, error) {
	got, err := i.c.After(ctx, after)
	out := make([]agent.Alert, 0, len(got))
	for _, a := range got {
		out = append(out, agent.Alert{Seq: a.Seq, ClaimID: a.ClaimID, Host: a.Host, Kind: a.Kind, At: a.At})
	}
	return out, err
}

func must(log *slog.Logger, what string, err error) {
	if err != nil {
		log.Error(what, "err", err)
		os.Exit(1)
	}
}

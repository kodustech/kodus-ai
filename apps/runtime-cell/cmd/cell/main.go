// Command cell is the cell agent (docs §4): the outbound connection to the
// runtime-hub, the leases, the dead-man switch, the repo tarball and the
// claim's observer. "cell extract" is the no-network extraction child. This
// file only wires: every part it builds lives in a package.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/evidence"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/cellupdate"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/k8ssandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/enrollment"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/gitsource"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preview"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "-version" || os.Args[1] == "--version") {
		fmt.Println(version.Get())
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "extract" {
		os.Exit(tarball.RunExtractChild(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && (os.Args[1] == "register" || os.Args[1] == "renew") {
		os.Exit(runEnroll(os.Args[1], os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "update" {
		os.Exit(cellupdate.Run(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "local-pki" {
		os.Exit(runLocalPKI(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "template" {
		os.Exit(runTemplate(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "issue-cert" {
		os.Exit(runIssueCert(os.Args[2:], os.Stdout, os.Stderr))
	}
	if len(os.Args) > 1 && os.Args[1] == "probe" {
		os.Exit(k8ssandbox.RunProbe(os.Args[2:], os.Stderr))
	}
	log := slog.New(telemetry.NewHandler(slog.NewJSONHandler(os.Stderr, nil)))
	err := run(log, os.Args[1:])
	switch code := lifecycle.ExitCode(err); code {
	case 0:
	case 2:
		// A bad flag or setting, refused before touching anything else.
		fmt.Fprintln(os.Stderr, err)
		os.Exit(code)
	default:
		log.Error("cell.failed", "err", err)
		os.Exit(code)
	}
}

// run is the cell agent until SIGTERM or SIGINT, or until it fails: every
// defer runs on the way out. A setting it refuses is a lifecycle.Usage
// error (exit 2).
func run(log *slog.Logger, args []string) error {
	st, err := parseSettings(flag.CommandLine, args)
	if err != nil {
		return lifecycle.Usage(err)
	}
	// -driver auto and the isolation backend become a driver here, before
	// anything reads them; then the settings are checked against it.
	sel, entry, err := selectDriver(&st, probeHost(), os.Getenv)
	if err != nil {
		// Refuse before touching anything else (keys, Docker, the hub).
		return lifecycle.Usage(err)
	}
	log.Info("cell.start", "version", version.Get(), "driver", sel.Kind, "why", sel.Why)
	if sel.Backend.Backend != "" {
		log.Info("isolation.backend", "backend", sel.Backend.Backend, "why", sel.Backend.Why)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	// Traces: OTLP when OTEL_EXPORTER_OTLP_ENDPOINT is set (as the TS processes), ids on log lines always.
	shutdownTraces, err := telemetry.Setup(ctx, "runtime-cell")
	if err != nil {
		return fmt.Errorf("telemetry: %w", err)
	}
	defer func() { _ = shutdownTraces(context.Background()) }()

	// One identity for every client of the cell: the hub WebSocket, the
	// egress control, the renewal. Each reads the holder at its handshake,
	// so a renewal reaches all of them; a live connection keeps the
	// certificate it was opened with.
	holder, err := enrollment.LoadCertHolder(st.Cert, st.Key)
	if err != nil {
		return fmt.Errorf("cell identity: %w", err)
	}
	cellID, err := resolveCellID(st.CellID, holder.CellID())
	if err != nil {
		return fmt.Errorf("cell identity: %w", err)
	}
	trustRoots, err := loadRoots(rootFiles{Hub: st.CA, Local: st.LocalCA, CellCA: st.Trust.CellCA, Issuer: st.Issuer, Observer: observerCAFile(st)}, st.EgressEPs != "", st.Dev)
	if err != nil {
		return fmt.Errorf("trust roots: %w", err)
	}
	if trustRoots.Shared && st.EgressEPs != "" {
		log.Warn("trust.shared_pool", "alarm", true, "why", "no -local-ca: the hub and the enforcers are verified with one pool, so a certificate of either CA passes for the other (dev only)")
	}
	roots := trustRoots.Hub
	reg := metrics.NewRegistry()
	var loops []part
	if st.AutoRenew {
		hub, err := enrollment.HTTPSBase(st.HubURL)
		if err != nil {
			return fmt.Errorf("auto-renew: %w", err)
		}
		r := &enrollment.Renewer{
			Holder: holder, Hub: hub, Roots: roots, Log: log, Metrics: reg,
			Paths: enrollment.Paths{Key: st.Key, Cert: st.Cert, CA: st.CA, Issuer: st.Issuer},
		}
		loops = append(loops, part{name: "auto-renew", run: func(ctx context.Context) error { r.Run(ctx); return nil }})
	}
	metricsPart, err := metricsServer(ctx, log, st.MetricsAddr, reg)
	if err != nil {
		return fmt.Errorf("metrics: %w", err)
	}
	if metricsPart != nil {
		defer metricsPart.release() // a setup that fails before the part serves
		loops = append(loops, *metricsPart)
	}
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("executable: %w", err)
	}

	git := gitsource.GitHub{APIBase: st.GitAPI}
	cfg := agent.Config{
		MaxClaimSteps: st.MaxClaimSteps,
		Owner:         protocol.CellOwner(st.Owner),
		CellID:        cellID,
		WorkDir:       st.WorkDir,
		Extractor:     tarball.NetNSExtractor{Command: []string{exe, "extract"}, AllowWithoutNetNS: st.Dev},
		Revoker:       git,
		// claim.acquire names the repo; the cell builds the URL from
		// validated parts, on the Git API it was configured with.
		Repo:    func(acq protocol.ClaimAcquireBody) (string, error) { return git.TarballURL(acq.Repo, acq.Sha) },
		Log:     log,
		Metrics: reg,
	}
	// The trust files a claim with org secrets mounts (trust.go), built
	// once, before any driver boots a machine.
	trust, rootsFrom, err := st.Trust.write(st.WorkDir)
	if err != nil {
		return fmt.Errorf("machine trust: %w", err)
	}
	if trust.Set() {
		log.Info("machine_trust.ready", "roots", rootsFrom, "bundle", trust.Bundle)
	}
	if st.Regions != "" {
		cfg.Regions = strings.Split(st.Regions, ",")
	}
	drv, err := entry.Open(ctx, wiring{st: st, cellID: cellID, trust: trust, log: log}, &cfg)
	if err != nil {
		return fmt.Errorf("%s: %w", sel.Kind, err)
	}
	// From here serveCell owns the driver: it closes it on every way out.
	return serveCell(ctx, lifecycle.Within(shutdownGrace), cellParts{
		log: log, kind: cfg.Driver.Kind(), sweeper: cfg.Parts.Sweeper, loops: loops, closeDriver: drv.close,
		build: func() (func(context.Context) error, func(context.Context) error, error) {
			return buildAgent(log, st, &cfg, drv, holder, trustRoots, reg)
		},
	})
}

// buildAgent finishes the agent's configuration once the driver is open
// (its observers, the preview tunnel, the egress control, the memory
// admission) and makes the agent. It returns the agent's Run and what to
// release once it stopped (the preview tunnel).
func buildAgent(log *slog.Logger, st settings, cfg *agent.Config, drv opened, holder *enrollment.CertHolder, trustRoots roots, reg *metrics.Registry) (func(context.Context) error, func(context.Context) error, error) {
	hubRoots := trustRoots.Hub
	observers, previewUpstreams, err := drv.observers()
	if err != nil {
		return nil, nil, fmt.Errorf("observer: %w", err)
	}
	cfg.Observers = observers

	var release func(context.Context) error
	if st.Preview {
		svc := preview.New(preview.Config{TLS: func() *tls.Config { return holder.ClientTLS(hubRoots) }, Log: log, Metrics: reg})
		release = func(deadline context.Context) error { return lifecycle.WaitWithin(deadline, "preview", svc.Close) }
		cfg.Preview = &agent.PreviewCapability{Service: svc, Upstreams: previewUpstreams}
	}
	fail := func(err error) (func(context.Context) error, func(context.Context) error, error) {
		return nil, release, err
	}

	if st.EgressEPs != "" {
		// Every component that enforces a claim's policy, by name: the
		// proxy, the resolver and the injector (whose alerts the agent
		// also watches).
		eps, err := control.ParseEndpoints(st.EgressEPs, control.RequiredEndpoints...)
		if err != nil {
			return fail(fmt.Errorf("egress-control: %w", err))
		}
		k, err := tlsutil.PrivateKey(st.PolicyKey)
		if err != nil {
			return fail(fmt.Errorf("policy key: %w", err))
		}
		var base []string
		if st.EgressBase != "" {
			base = strings.Split(st.EgressBase, ",")
		}
		cellTLS := &http.Transport{TLSClientConfig: holder.ClientTLS(trustRoots.Local)}
		cfg.InspectEgress = st.EgressRecommended && cfg.CellTrust
		var inspect []policy.InspectRule
		if st.EgressRecommended {
			// Plain HTTP is inspected whatever the trust; TLS only from the
			// machines the claim's boot gave the cell CA (InspectSources).
			inspect = netguard.RecommendedInspectRules()
			log.Info("egress.recommended", "version", netguard.RecommendedVersion(), "hosts", len(inspect), "tlsInspected", cfg.InspectEgress)
		}
		rules := agent.EgressRules{Base: base, Inspect: inspect, Build: agent.BuildPassthroughHosts(st.EgressRecommended, st.EgressBuildHosts)}
		egressPolicy := policyPusher{
			client: control.Pusher{Endpoints: eps, HTTP: &http.Client{Transport: cellTLS, Timeout: 10 * time.Second}, Key: k},
			rules:  rules,
			log:    log,
			refused: reg.Counter("cell_egress_hosts_denied_total",
				"Hosts a claim's egress allowlist asked for that the platform denies; left out of the signed policy."),
		}
		cfg.Egress = egressPolicy
		cfg.RecipeEgress = rules
		cfg.Alerts = alertFeed{&injector.AlertClient{URL: control.URL(eps, control.EndpointInjector), HTTP: &http.Client{Transport: cellTLS, Timeout: time.Minute}}}
		// The proxy's feed (a secret placeholder over plain HTTP) is in the
		// injector's format; both must answer for the cell to take work.
		cfg.EgressAlerts = alertFeed{&injector.AlertClient{URL: control.URL(eps, control.EndpointEgress), HTTP: &http.Client{Transport: cellTLS, Timeout: time.Minute}}}
		cfg.SecretHostDenied = rules.Deny.Denies
		if !cfg.CellTrust {
			// Secrets are advertised with the policy push; without the trust
			// files a machine refuses the injector's leaf for a secret's host.
			log.Warn("machine_trust.unconfigured", "alarm", true, "why", "no -cell-ca-cert: machines of a claim with org secrets do not trust the injector, so HTTPS to a secret's host fails certificate verification")
		}
		cfg.DeniedEgress = deniedEgress{r: control.DeniedReader{Endpoints: eps, HTTP: &http.Client{Transport: cellTLS, Timeout: 10 * time.Second}}, log: log}
		cfg.Outbound = outboundCalls{control.OutboundReader{Endpoints: eps, HTTP: &http.Client{Transport: cellTLS, Timeout: 10 * time.Second}}}
	}

	if err := observeDriver(cfg, st, reg, log, readMemTotalMB); err != nil {
		return fail(fmt.Errorf("memory admission: %w", err))
	}
	a, err := agent.New(*cfg)
	if err != nil {
		return fail(fmt.Errorf("agent: %w", err))
	}
	rc := agent.RunConfig{HubURL: st.HubURL, TLS: holder.ClientTLS(hubRoots)}
	return func(ctx context.Context) error { return a.Run(ctx, rc) }, release, nil
}

// resolveCellID is the cell id: the certificate's CN, which the hub checks
// on every frame. A configured id must be that CN.
func resolveCellID(configured, certCN string) (string, error) {
	if configured != "" && configured != certCN {
		return "", fmt.Errorf("-cell-id %q is not the certificate's CN %q: the hub would refuse every frame", configured, certCN)
	}
	return certCN, nil
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

// httpPreviewUpstreams is a preview claim's upstream on an observer
// machine: the observer configured for the claim as a probe would, then its
// /v1/preview proxy over the agent's mTLS transport.
func httpPreviewUpstreams(observers agent.ObserverFactory, rt http.RoundTripper) agent.PreviewUpstreamFactory {
	return func(ctx context.Context, c agent.ClaimInfo, targets []observer.Target) (http.Handler, error) {
		if _, err := observers(ctx, c, targets); err != nil {
			return nil, err
		}
		return preview.ObserverUpstream("https://"+net.JoinHostPort(c.Observer.PrivateAddress, "7443"), rt)
	}
}

// policyPusher pushes each claim's signed policy (agent.EgressRules) to the
// enforcers and counts the hosts the platform denied.
type policyPusher struct {
	client  control.Pusher
	rules   agent.EgressRules
	log     *slog.Logger
	refused *metrics.Vec
}

func (p policyPusher) Apply(ctx context.Context, c agent.ClaimInfo) error {
	pol, refused, err := p.rules.ClaimPolicy(c, time.Now())
	if err != nil {
		return err
	}
	if len(refused) > 0 {
		p.refused.Add(float64(len(refused)))
		p.log.Warn("egress.policy.denied_hosts", "claim", c.ClaimID, "org", c.Acquire.OrgID, "hosts", refused)
	}
	err = p.client.Push(ctx, pol)
	if errors.Is(err, control.ErrDenyListsDiffer) {
		p.log.Error("egress.deny_lists.differ", "alarm", true, "claim", c.ClaimID, "err", err)
	}
	return err
}

func (p policyPusher) Remove(ctx context.Context, claimID string) error {
	return p.client.Remove(ctx, claimID)
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

func (o outboundCalls) Outbound(ctx context.Context, claimID string, since, until time.Time) ([]evidence.OutboundCall, error) {
	got, err := o.r.Outbound(ctx, claimID, since, until)
	out := make([]evidence.OutboundCall, 0, len(got))
	for _, g := range got {
		out = append(out, evidence.OutboundCall{Host: g.Host, Port: g.Port, At: g.At, Allowed: g.Allowed})
	}
	return out, err
}

// alertFeed is an alert feed for the agent: the injector's, or the proxy's
// in the same format.
type alertFeed struct{ c *injector.AlertClient }

func (i alertFeed) Alerts(ctx context.Context, after int64) ([]agent.Alert, error) {
	got, err := i.c.After(ctx, after)
	out := make([]agent.Alert, 0, len(got))
	for _, a := range got {
		out = append(out, agent.Alert{Seq: a.Seq, ClaimID: a.ClaimID, Host: a.Host, Kind: a.Kind, At: a.At})
	}
	return out, err
}

// observerCAFile is the observer CA the trust rules compare, when observers
// run over HTTP (else the flag's default path names no file).
func observerCAFile(st settings) string {
	if st.ObsMode == "http" {
		return st.ObsCA
	}
	return ""
}

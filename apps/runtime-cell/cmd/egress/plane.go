package main

import (
	"flag"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/resolver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// planeOptions are the flags that decide what a claim's connection meets:
// the proxy, the resolver beside it and their control handler. The
// listeners, the mirror and the control port's TLS stay in main.
type planeOptions struct {
	agentPub, upstream, legacyOwned, claimSubnets, internal, injectorAddr string
	deny                                                                  *netguard.DenyFlags
	transparent                                                           bool
	uploadBudgetMB                                                        int64
}

func registerPlaneOptions(fs *flag.FlagSet) *planeOptions {
	o := &planeOptions{}
	fs.StringVar(&o.agentPub, "agent-pub", "/etc/kodus/egress/agent.pub.pem", "the agent's ed25519 policy key")
	fs.StringVar(&o.upstream, "upstream-dns", "169.254.169.253:53", "recursive resolver the proxy resolves with (host:port), or resolv.conf for the first nameserver of /etc/resolv.conf (a Kubernetes pod's cluster DNS)")
	o.deny = netguard.RegisterDenyFlags(fs)
	fs.StringVar(&o.legacyOwned, "deny-exceptions", "", "deprecated name of -owned-hosts")
	fs.StringVar(&o.injectorAddr, "injector-addr", "", "host:port of the injector's -listen as this proxy reaches it: credentialed hosts (org secrets, credentials) go there; empty: a policy that names one is refused")
	fs.BoolVar(&o.transparent, "transparent", true, "check SO_ORIGINAL_DST against the addresses handed or resolved")
	fs.Int64Var(&o.uploadBudgetMB, "upload-budget-mb", 64, "MB a claim may send out over all its connections before egress.upload_budget.exceeded is logged and counted (D8, observe only: nothing is cut); 0: not measured")
	fs.StringVar(&o.claimSubnets, "claim-subnets", netguard.DefaultClaimSubnets, "comma-separated pool the claim networks take their subnets from; -internal-cidrs may not overlap it")
	fs.StringVar(&o.internal, "internal-cidrs", "", "comma-separated networks the cell owns (mirror, evidence endpoint); every other private address is refused")
	return o
}

// dataPlane is the egress as a claim meets it: one policy store and one
// answer record for the proxy and the resolver, and the control handler
// that fills them.
type dataPlane struct {
	store   *policy.Store
	proxy   *egress.Proxy
	dns     *resolver.Server
	queries *resolver.QueryLog
	alerts  *egress.Alerts
	control *egress.Control
}

func newDataPlane(o *planeOptions, log *slog.Logger) (*dataPlane, error) {
	if err := checkInjectorAddr(o.injectorAddr); err != nil {
		return nil, err
	}
	pub, err := tlsutil.PublicKey(o.agentPub)
	if err != nil {
		return nil, fmt.Errorf("agent-pub: %w", err)
	}
	cidrs, err := netguard.ParseInternalCIDRs(o.internal, o.claimSubnets)
	if err != nil {
		return nil, fmt.Errorf("internal-cidrs: %w", err)
	}
	deny, err := o.deny.List(o.legacyOwned)
	if err != nil {
		return nil, fmt.Errorf("deny-hosts: %w", err)
	}
	upstream, err := resolver.UpstreamAddr(o.upstream, func() ([]byte, error) { return os.ReadFile("/etc/resolv.conf") })
	if err != nil {
		return nil, err
	}
	d := &dataPlane{store: policy.NewStore(nil), queries: resolver.NewQueryLog(10_000), alerts: egress.NewAlerts(10_000)}
	answers := netguard.NewAnswers(nil)
	d.dns = &resolver.Server{Policies: d.store, Upstream: resolver.ForwardTo(upstream), Log: d.queries, Answers: answers, Deny: deny, InternalCIDRs: cidrs, Logger: log}
	metrics := egress.NewMetrics()
	d.proxy = &egress.Proxy{
		Policies: d.store, Events: egress.NewEvents(10_000), Connections: egress.NewEvents(10_000), Resolve: d.dns.LookupA, Answers: answers,
		Deny: deny, InternalCIDRs: cidrs, Metrics: metrics, Log: log, InjectorAddr: o.injectorAddr,
		UploadBudget: max(o.uploadBudgetMB, 0) << 20,
	}
	if o.injectorAddr == "" {
		log.Warn("egress.injector.unconfigured", "alarm", true, "credentialHosts", "refused", "why", "no -injector-addr: a policy that names a secret's or credential's host is refused")
	}
	if o.transparent {
		d.proxy.OriginalDst = egress.OriginalDst
	}
	// A claim's secret placeholder over plain HTTP is refused and raised to
	// the agent, which marks the claim compromised (GET /v1/alerts).
	d.proxy.OnPlaceholderLeak = func(claimID, host string) {
		log.Error("egress.placeholder_leak", "alarm", true, "claim", claimID, "host", host)
		d.alerts.PlaceholderLeak(claimID, host, time.Now())
	}
	d.control = &egress.Control{
		Policies: d.store, Events: d.proxy.Events, Connections: d.proxy.Connections, Alerts: d.alerts, AgentKey: pub, Metrics: metrics,
		Enforceable: d.proxy.Enforceable,
		OnPolicy:    func(pol policy.ClaimPolicy) { d.proxy.Revalidate(pol.ClaimID) },
		OnDelete:    d.forget,
		// The cell compares it with the resolver's on every push.
		DenyFingerprint: deny.Fingerprint(),
	}
	return d, nil
}

// checkInjectorAddr takes an empty address (no injector) or host:port with
// both parts; a name is resolved at each dial, as Proxy.Dial does.
func checkInjectorAddr(addr string) error {
	if addr == "" {
		return nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("injector-addr: %w", err)
	}
	if n, err := strconv.Atoi(port); host == "" || err != nil || n < 1 || n > 65535 {
		return fmt.Errorf("injector-addr: %q is not host:port", addr)
	}
	return nil
}

// forget drops a claim from the data plane: its connections and its answers.
func (d *dataPlane) forget(claim string) {
	d.proxy.CloseClaim(claim)
	d.dns.ForgetClaim(claim)
}

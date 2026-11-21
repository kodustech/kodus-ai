// Command resolver is the only DNS of the VMs and the observer: the
// claim's exact allowlist and app.kody.internal; NXDOMAIN for the rest,
// without asking anyone outside. Every query is logged by claim.
//
// Run standalone, its answer record stays in this process; the proxy then
// checks destinations with its own lookup only. To share the record, run the
// resolver inside the egress process (egress -dns-listen).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/resolver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// shutdownGrace is what a stopping resolver gives the queries and control
// requests in flight.
const shutdownGrace = 10 * time.Second

func main() {
	log := slog.New(telemetry.NewHandler(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(log); err != nil {
		log.Error("resolver.failed", "err", err)
		os.Exit(lifecycle.ExitCode(err))
	}
}

// run serves until SIGTERM or SIGINT, or until a server fails; then it
// stops them all within shutdownGrace. Every defer runs on the way out.
func run(log *slog.Logger) error {
	listen := flag.String("listen", ":53", "DNS address (udp and tcp)")
	ctlAddr := flag.String("control", ":9444", "control port (mTLS, cell agent only)")
	cert := flag.String("cert", "/etc/kodus/resolver/cert.pem", "control certificate")
	key := flag.String("key", "/etc/kodus/resolver/key.pem", "control key")
	ca := flag.String("ca", "/etc/kodus/resolver/ca.pem", "CA of the cell agent certificate")
	agentCN := flag.String("agent-cn", "", "the cell agent's certificate CN (the cell id): the control port answers no other certificate of -ca; empty answers any")
	agentSPKI := flag.String("agent-spki", "", "hex SHA-256 of the agent certificate's public key, pinned with or instead of -agent-cn")
	opts := registerResolverOptions(flag.CommandLine)
	flag.Parse()
	log.Info("resolver.start", "version", version.Get())
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	p, err := newResolverPlane(opts, log)
	if err != nil {
		return fmt.Errorf("resolver: %w", err)
	}
	store, qlog, srv := p.store, p.queries, p.dns
	return lifecycle.Run(ctx, lifecycle.Within(shutdownGrace), func(g *lifecycle.Group) error {
		for _, n := range []string{"udp", "tcp"} {
			g.Go("dns "+n, func(ctx context.Context) error { return resolver.ListenAndServe(ctx, *listen, n, srv) })
		}
		g.Go("sweep", func(ctx context.Context) error {
			t := time.NewTicker(30 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					return nil
				case <-t.C:
					for _, c := range store.Sweep() {
						srv.ForgetClaim(c)
					}
					qlog.Prune(func(c string) bool { _, ok := store.ForClaim(c); return ok }, time.Now().Add(-time.Hour))
				}
			}
		})

		peer := tlsutil.Peer{CN: *agentCN, SPKI: *agentSPKI}
		if peer.IsZero() {
			log.Warn("control.peer.unpinned", "alarm", true, "why", "any certificate of -ca reaches the control port; set -agent-cn")
		}
		mux := http.NewServeMux()
		p.control.Register(mux)
		// Every name a claim resolved: the pinned agent's alone, never any
		// certificate of the CA (no pin: nobody's).
		mux.Handle("GET /v1/queries", tlsutil.RequirePeer(peer, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(qlog.ForClaim(r.URL.Query().Get("claim")))
		})))
		tlsCfg, err := tlsutil.ControlServer(*cert, *key, *ca, peer)
		if err != nil {
			return fmt.Errorf("control tls: %w", err)
		}
		l, err := new(net.ListenConfig).Listen(ctx, "tcp", *ctlAddr)
		if err != nil {
			return fmt.Errorf("control: %w", err)
		}
		hs := &http.Server{Handler: mux, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
		g.Go("control", lifecycle.ServeHTTP(hs, l, shutdownGrace))
		return nil
	})
}

type resolverOptions struct {
	agentPub, upstream, claimSubnets, internal string
	deny                                       *netguard.DenyFlags
}

func registerResolverOptions(fs *flag.FlagSet) *resolverOptions {
	o := &resolverOptions{}
	fs.StringVar(&o.agentPub, "agent-pub", "/etc/kodus/resolver/agent.pub.pem", "the agent's ed25519 policy key")
	fs.StringVar(&o.upstream, "upstream", "169.254.169.253:53", "recursive resolver for allowed names")
	fs.StringVar(&o.claimSubnets, "claim-subnets", netguard.DefaultClaimSubnets, "comma-separated pool the claim networks take their subnets from; -internal-cidrs may not overlap it")
	fs.StringVar(&o.internal, "internal-cidrs", "", "comma-separated networks the cell owns (mirror, evidence endpoint); answers pointing at any other private address are dropped")
	o.deny = netguard.RegisterDenyFlags(fs)
	return o
}

// resolverPlane is the resolver as a claim's query meets it, and the policy
// control handler that fills its store.
type resolverPlane struct {
	store   *policy.Store
	queries *resolver.QueryLog
	dns     *resolver.Server
	control *control.Server
}

func newResolverPlane(o *resolverOptions, log *slog.Logger) (*resolverPlane, error) {
	pub, err := tlsutil.PublicKey(o.agentPub)
	if err != nil {
		return nil, fmt.Errorf("agent-pub: %w", err)
	}
	cidrs, err := netguard.ParseInternalCIDRs(o.internal, o.claimSubnets)
	if err != nil {
		return nil, fmt.Errorf("internal-cidrs: %w", err)
	}
	deny, err := o.deny.List()
	if err != nil {
		return nil, fmt.Errorf("deny-hosts: %w", err)
	}
	p := &resolverPlane{store: policy.NewStore(nil), queries: resolver.NewQueryLog(10_000)}
	p.dns = &resolver.Server{
		Policies: p.store, Upstream: resolver.ForwardTo(o.upstream), Log: p.queries, Answers: netguard.NewAnswers(nil),
		Deny: deny, InternalCIDRs: cidrs, Logger: log,
	}
	// The cell compares the fingerprint with the proxy's on every push.
	p.control = &control.Server{Policies: p.store, AgentKey: pub, OnDelete: p.dns.ForgetClaim, DenyFingerprint: deny.Fingerprint()}
	return p, nil
}

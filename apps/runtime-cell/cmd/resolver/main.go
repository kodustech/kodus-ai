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
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/miekg/dns"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/resolver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

var version = "dev"

func main() {
	listen := flag.String("listen", ":53", "DNS address (udp and tcp)")
	ctlAddr := flag.String("control", ":9444", "control port (mTLS, cell agent only)")
	cert := flag.String("cert", "/etc/kodus/resolver/cert.pem", "control certificate")
	key := flag.String("key", "/etc/kodus/resolver/key.pem", "control key")
	ca := flag.String("ca", "/etc/kodus/resolver/ca.pem", "CA of the cell agent certificate")
	agentPub := flag.String("agent-pub", "/etc/kodus/resolver/agent.pub.pem", "the agent's ed25519 policy key")
	upstream := flag.String("upstream", "169.254.169.253:53", "recursive resolver for allowed names")
	internal := flag.String("internal-cidrs", "", "comma-separated networks the cell owns (mirror, evidence endpoint); answers pointing at any other private address are dropped")
	owned := flag.String("owned-hosts", "", "comma-separated hosts the cell owns (evidence bucket), let through the deny list (same value as the proxy's)")
	denyHosts := flag.String("deny-hosts", "", "comma-separated hosts the operator denies on top of the Kodus list: an exact host, or .domain for every name under it (same value as the proxy's)")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	log.Info("resolver.start", "version", version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	pub, err := tlsutil.PublicKey(*agentPub)
	must(log, "agent key", err)
	cidrs, err := netguard.ParseCIDRs(*internal)
	must(log, "internal-cidrs", err)
	deny, err := netguard.ParseDenyList(*denyHosts, netguard.ParseOwnedHosts(*owned))
	must(log, "deny-hosts", err)
	store := policy.NewStore(nil)
	qlog := resolver.NewQueryLog(10_000)
	srv := &resolver.Server{Policies: store, Upstream: resolver.ForwardTo(*upstream), Log: qlog, Answers: netguard.NewAnswers(nil),
		Deny: deny, InternalCIDRs: cidrs, Logger: log}
	for _, n := range []string{"udp", "tcp"} {
		s := &dns.Server{Addr: *listen, Net: n, Handler: srv}
		go func() { must(log, "dns "+s.Net, s.ListenAndServe()) }()
		go func() { <-ctx.Done(); _ = s.Shutdown() }()
	}
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				for _, c := range store.Sweep() {
					srv.ForgetClaim(c)
				}
				qlog.Prune(func(c string) bool { _, ok := store.ForClaim(c); return ok }, time.Now().Add(-time.Hour))
			}
		}
	}()

	mux := http.NewServeMux()
	(&control.Server{Policies: store, AgentKey: pub, OnDelete: srv.ForgetClaim}).Register(mux)
	mux.HandleFunc("GET /v1/queries", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(qlog.ForClaim(r.URL.Query().Get("claim")))
	})
	tlsCfg, err := tlsutil.Server(*cert, *key, *ca)
	must(log, "control tls", err)
	hs := &http.Server{Addr: *ctlAddr, Handler: mux, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	go func() { <-ctx.Done(); _ = hs.Close() }()
	if err := hs.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		must(log, "control", err)
	}
}

func must(log *slog.Logger, what string, err error) {
	if err != nil {
		log.Error(what, "err", err)
		os.Exit(1)
	}
}

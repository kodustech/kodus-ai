// Command egress is the cell's transparent egress proxy (ADR-040, ADR-056).
// nftables on its host redirects 80 and 443 here; it reads SNI or Host,
// never terminates TLS and holds no credential. The control port takes
// signed policies from the cell agent and serves the refusals
// (GET /v1/events) and the counters (GET /metrics; the OCI mirror's cache
// on GET /metrics/mirror).
//
// With -dns-listen the cell resolver runs in this process too, on the same
// policy store and the same answer record: the proxy then accepts exactly
// the addresses the resolver handed each claim, which a CDN that rotates
// its answers needs (a separate resolver process cannot share that).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/miekg/dns"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/egress"
	cellmetrics "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/mirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/resolver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

var version = "dev"

func main() {
	tlsAddr := flag.String("listen-tls", ":443", "redirected TLS traffic")
	httpAddr := flag.String("listen-http", ":80", "redirected plain HTTP traffic")
	dnsAddr := flag.String("dns-listen", "", "also serve the cell resolver here (udp and tcp), sharing the policy store and answers")
	control := flag.String("control", ":9443", "control port (mTLS, cell agent only)")
	cert := flag.String("cert", "/etc/kodus/egress/cert.pem", "control port certificate")
	key := flag.String("key", "/etc/kodus/egress/key.pem", "control port key")
	ca := flag.String("ca", "/etc/kodus/egress/ca.pem", "CA of the cell agent certificate")
	agentPub := flag.String("agent-pub", "/etc/kodus/egress/agent.pub.pem", "the agent's ed25519 policy key")
	upstream := flag.String("upstream-dns", "169.254.169.253:53", "recursive resolver the proxy resolves with")
	owned := flag.String("owned-hosts", "", "comma-separated hosts the cell owns (evidence bucket), let through the deny list")
	legacyOwned := flag.String("deny-exceptions", "", "deprecated name of -owned-hosts")
	denyHosts := flag.String("deny-hosts", "", "comma-separated hosts the operator denies on top of the Kodus list: an exact host, or .domain for every name under it (same value as the resolver's)")
	transparent := flag.Bool("transparent", true, "check SO_ORIGINAL_DST against the addresses handed or resolved")
	mirrorAddr := flag.String("mirror-listen", "", "address of the registry mirror the claims reach as mirror.cell.internal (empty: no mirror)")
	goUpstream := flag.String("mirror-go-upstream", "https://proxy.golang.org", "the Go module proxy the mirror pulls through")
	goSumDB := flag.String("mirror-go-sumdb", "https://sum.golang.org", "the Go checksum database the mirror proxies (empty: not proxied)")
	ociUpstream := flag.String("mirror-oci-upstream", "https://registry-1.docker.io", "the registry the mirror pulls images through (Docker Hub)")
	ociAuth := flag.String("mirror-oci-auth", "https://auth.docker.io/token", "the token service of that registry")
	cacheDir := flag.String("mirror-cache-dir", "", "directory of the OCI mirror's blob cache, shared by the cell's claims (empty: nothing is kept)")
	cacheGB := flag.Float64("mirror-cache-max-gb", 20, "size bound of that cache; the least recently used blobs go first")
	tagTTL := flag.Duration("mirror-tag-ttl", 10*time.Minute, "how long a tag's manifest is served before the registry is asked again")
	tagStale := flag.Duration("mirror-tag-stale", 6*time.Hour, "how long after the registry last confirmed a tag it may be served while the registry fails")
	ociAuthFile := flag.String("mirror-oci-auth-file", "", `file with {"username","token"} of a Docker Hub account to pull as (empty: anonymous)`)
	internal := flag.String("internal-cidrs", "", "comma-separated networks the cell owns (mirror, evidence endpoint); every other private address is refused")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	log.Info("egress.start", "version", version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	pub, err := tlsutil.PublicKey(*agentPub)
	must(log, "agent key", err)
	cidrs, err := netguard.ParseCIDRs(*internal)
	must(log, "internal-cidrs", err)
	deny, err := netguard.ParseDenyList(*denyHosts, netguard.ParseOwnedHosts(*owned+","+*legacyOwned))
	must(log, "deny-hosts", err)
	store := policy.NewStore(nil)
	answers := netguard.NewAnswers(nil)
	qlog := resolver.NewQueryLog(10_000)
	dnsSrv := &resolver.Server{Policies: store, Upstream: resolver.ForwardTo(*upstream), Log: qlog, Answers: answers, Deny: deny, InternalCIDRs: cidrs, Logger: log}
	metrics := egress.NewMetrics()
	p := &egress.Proxy{Policies: store, Events: egress.NewEvents(10_000), Connections: egress.NewEvents(10_000), Resolve: dnsSrv.LookupA, Answers: answers,
		Deny: deny, InternalCIDRs: cidrs, Metrics: metrics, Log: log}
	if *transparent {
		p.OriginalDst = egress.OriginalDst
	}
	serve := func(addr string, port int, tlsMode bool) {
		l, err := net.Listen("tcp4", addr)
		must(log, "listen "+addr, err)
		go func() { must(log, "serve "+addr, p.Serve(ctx, l, port, tlsMode)) }()
	}
	serve(*tlsAddr, 443, true)
	serve(*httpAddr, 80, false)
	if *dnsAddr != "" {
		for _, n := range []string{"udp", "tcp"} {
			s := &dns.Server{Addr: *dnsAddr, Net: n, Handler: dnsSrv}
			go func() { must(log, "dns "+s.Net, s.ListenAndServe()) }()
			go func() { <-ctx.Done(); _ = s.Shutdown() }()
		}
	}
	forget := func(claim string) {
		p.CloseClaim(claim)
		dnsSrv.ForgetClaim(claim)
	}
	go sweep(ctx, store, qlog, forget)

	mirrorMetrics := cellmetrics.NewRegistry()
	if *mirrorAddr != "" {
		// The registry mirror (docs §4): plain HTTP on the claim networks;
		// what it serves is pinned by the claim's lockfile and verified by
		// the client against it. It alone reaches the registries' upstreams.
		up, err := url.Parse(*goUpstream)
		must(log, "go-upstream", err)
		var sumdb *url.URL
		if *goSumDB != "" {
			sumdb, err = url.Parse(*goSumDB)
			must(log, "go-sumdb", err)
		}
		gp := &mirror.GoProxy{Upstream: up, SumDB: sumdb, Pins: func(r *http.Request, module, version string) bool {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				return false
			}
			pol, ok := store.ForSource(net.ParseIP(host))
			return ok && pol.PinsGo(module, version)
		}}
		mm := http.NewServeMux()
		mm.Handle("/go/", gp)
		// Docker Hub for the claims' builders: only the images their Dockerfiles name.
		reg, err := url.Parse(*ociUpstream)
		must(log, "oci-upstream", err)
		auth, err := url.Parse(*ociAuth)
		must(log, "oci-auth", err)
		oci := &mirror.OCIProxy{Registry: reg, Auth: auth, TagTTL: *tagTTL, StaleFor: *tagStale, Log: log, Pins: func(r *http.Request, repo, ref string) bool {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				return false
			}
			pol, ok := store.ForSource(net.ParseIP(host))
			return ok && pol.PinsImage(repo, ref)
		}}
		if *ociAuthFile != "" {
			// Only the token service sees them; the claims never do.
			oci.Credentials, err = mirror.LoadCredentials(*ociAuthFile)
			must(log, "mirror-oci-auth-file", err)
		}
		if *cacheDir != "" {
			oci.Metrics = mirror.NewCacheMetrics(mirrorMetrics)
			oci.Store, err = mirror.OpenDiskStore(*cacheDir, int64(*cacheGB*(1<<30)), nil, oci.Metrics)
			must(log, "mirror-cache-dir", err)
		}
		log.Info("mirror.oci.start", "cache", *cacheDir != "", "authenticated", oci.Credentials != nil)
		mm.Handle("/v2/", oci)
		ms := &http.Server{Addr: *mirrorAddr, Handler: mm, ReadHeaderTimeout: 10 * time.Second}
		go func() { <-ctx.Done(); _ = ms.Close() }()
		go func() {
			if err := ms.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				must(log, "mirror", err)
			}
		}()
	}
	tlsCfg, err := tlsutil.Server(*cert, *key, *ca)
	must(log, "control tls", err)
	ctl := &egress.Control{Policies: store, Events: p.Events, Connections: p.Connections, AgentKey: pub, Metrics: metrics,
		OnPolicy: func(pol policy.ClaimPolicy) { p.Revalidate(pol.ClaimID) },
		OnDelete: forget,
	}
	mux := http.NewServeMux()
	mux.Handle("/", ctl.Handler())
	mux.Handle("GET /metrics/mirror", mirrorMetrics.Handler())
	mux.HandleFunc("GET /v1/queries", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(qlog.ForClaim(r.URL.Query().Get("claim")))
	})
	hs := &http.Server{Addr: *control, Handler: mux, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	go func() { <-ctx.Done(); _ = hs.Close() }()
	if err := hs.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		must(log, "control", err)
	}
}

// sweep evicts expired policies (cutting their connections, dropping their
// answers) and query logs nobody will read.
func sweep(ctx context.Context, store *policy.Store, qlog *resolver.QueryLog, forget func(string)) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			for _, claim := range store.Sweep() {
				forget(claim)
			}
			qlog.Prune(func(c string) bool { _, ok := store.ForClaim(c); return ok }, time.Now().Add(-time.Hour))
		}
	}
}

func must(log *slog.Logger, what string, err error) {
	if err != nil {
		log.Error(what, "err", err)
		os.Exit(1)
	}
}

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
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	cellmetrics "github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/mirror"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/resolver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// shutdownGrace is what a stopping proxy gives the connections and
// requests in flight on its control port and its mirror.
const shutdownGrace = 10 * time.Second

func main() {
	log := slog.New(telemetry.NewHandler(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(log); err != nil {
		log.Error("egress.failed", "err", err)
		os.Exit(lifecycle.ExitCode(err))
	}
}

// run serves until SIGTERM or SIGINT, or until a server fails; then it
// stops them all within shutdownGrace. Every defer runs on the way out.
func run(log *slog.Logger) error {
	tlsAddr := flag.String("listen-tls", ":443", "redirected TLS traffic")
	httpAddr := flag.String("listen-http", ":80", "redirected plain HTTP traffic")
	dnsAddr := flag.String("dns-listen", "", "also serve the cell resolver here (udp and tcp), sharing the policy store and answers")
	control := flag.String("control", ":9443", "control port (mTLS, cell agent only)")
	cert := flag.String("cert", "/etc/kodus/egress/cert.pem", "control port certificate")
	key := flag.String("key", "/etc/kodus/egress/key.pem", "control port key")
	ca := flag.String("ca", "/etc/kodus/egress/ca.pem", "CA of the cell agent certificate")
	agentCN := flag.String("agent-cn", "", "the cell agent's certificate CN (the cell id): the control port answers no other certificate of -ca; empty answers any")
	agentSPKI := flag.String("agent-spki", "", "hex SHA-256 of the agent certificate's public key, pinned with or instead of -agent-cn")
	mirrorAddr := flag.String("mirror-listen", "", "address of the registry mirror the claims reach as mirror.cell.internal (empty: no mirror)")
	goUpstream := flag.String("mirror-go-upstream", "https://proxy.golang.org", "the Go module proxy the mirror pulls through")
	goSumDB := flag.String("mirror-go-sumdb", "https://sum.golang.org", "the Go checksum database the mirror proxies (empty: not proxied)")
	npmUpstream := flag.String("mirror-npm-upstream", "https://registry.npmjs.org", "the npm registry the mirror reads through, under /npm/ (empty: no npm mirror)")
	pypiIndex := flag.String("mirror-pypi-index", "https://pypi.org", "the PyPI index the mirror reads through, under /pypi/simple/ (empty: no PyPI mirror)")
	pypiFiles := flag.String("mirror-pypi-files", "https://files.pythonhosted.org", "where PyPI's files are, under /pypi/files/")
	mirrorPublic := flag.String("mirror-public-url", "", "the mirror as the machines name it, for the file URLs of an npm or PyPI index (empty: http://mirror.cell.internal:<port of -mirror-listen>)")
	ociUpstream := flag.String("mirror-oci-upstream", "https://registry-1.docker.io", "the registry the mirror pulls images through (Docker Hub)")
	ociAuth := flag.String("mirror-oci-auth", "https://auth.docker.io/token", "the token service of that registry")
	cacheDir := flag.String("mirror-cache-dir", "", "directory of the OCI mirror's blob cache, shared by the cell's claims (empty: nothing is kept)")
	cacheGB := flag.Float64("mirror-cache-max-gb", 20, "size bound of that cache; the least recently used blobs go first")
	tagTTL := flag.Duration("mirror-tag-ttl", 10*time.Minute, "how long a tag's manifest is served before the registry is asked again")
	tagStale := flag.Duration("mirror-tag-stale", 6*time.Hour, "how long after the registry last confirmed a tag it may be served while the registry fails")
	ociAuthFile := flag.String("mirror-oci-auth-file", "", `file with {"username","token"} of a Docker Hub account to pull as, for its rate limit only: a repository an anonymous client cannot pull is refused (empty: anonymous)`)
	plane := registerPlaneOptions(flag.CommandLine)
	flag.Parse()
	log.Info("egress.start", "version", version.Get())
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	d, err := newDataPlane(plane, log)
	if err != nil {
		return fmt.Errorf("egress: %w", err)
	}
	return lifecycle.Run(ctx, lifecycle.Within(shutdownGrace), func(g *lifecycle.Group) error {
		return start(ctx, g, log, d, flags{
			tls: *tlsAddr, http: *httpAddr, dns: *dnsAddr, control: *control, cert: *cert, key: *key, ca: *ca,
			agent: tlsutil.Peer{CN: *agentCN, SPKI: *agentSPKI}, mirror: *mirrorAddr, goUpstream: *goUpstream, goSumDB: *goSumDB,
			npmUpstream: *npmUpstream, pypiIndex: *pypiIndex, pypiFiles: *pypiFiles, mirrorPublic: *mirrorPublic,
			ociUpstream: *ociUpstream, ociAuth: *ociAuth, cacheDir: *cacheDir, cacheGB: *cacheGB, tagTTL: *tagTTL,
			tagStale: *tagStale, ociAuthFile: *ociAuthFile,
		})
	})
}

// flags are the proxy's settings beside its data plane's.
type flags struct {
	tls, http, dns, control, cert, key, ca                         string
	agent                                                          tlsutil.Peer
	mirror, goUpstream, goSumDB, npmUpstream, pypiIndex, pypiFiles string
	mirrorPublic, ociUpstream, ociAuth, cacheDir, ociAuthFile      string
	cacheGB                                                        float64
	tagTTL, tagStale                                               time.Duration
}

// start opens every listener of the proxy and runs its servers and its
// sweep in g. A listener it cannot open, or a setting it refuses, is its
// error, and what it already started stops with g.
func start(ctx context.Context, g *lifecycle.Group, log *slog.Logger, d *dataPlane, f flags) error {
	p := d.proxy
	serve := func(addr string, port int, tlsMode bool) error {
		l, err := new(net.ListenConfig).Listen(ctx, "tcp4", addr)
		if err != nil {
			return fmt.Errorf("listen %s: %w", addr, err)
		}
		g.Go("serve "+addr, func(ctx context.Context) error { return p.Serve(ctx, l, port, tlsMode) })
		return nil
	}
	if err := serve(f.tls, 443, true); err != nil {
		return err
	}
	if err := serve(f.http, 80, false); err != nil {
		return err
	}
	if f.dns != "" {
		for _, n := range []string{"udp", "tcp"} {
			g.Go("dns "+n, func(ctx context.Context) error { return resolver.ListenAndServe(ctx, f.dns, n, d.dns) })
		}
	}
	g.Go("sweep", func(ctx context.Context) error { sweep(ctx, d.store, d.queries, d.forget); return nil })

	mirrorMetrics := cellmetrics.NewRegistry()
	if f.mirror != "" {
		// The registry mirror (docs/runtime/egress-allowlist.md §6): plain
		// HTTP on the claim networks; Go modules and images only as the
		// checkout pins them, npm and PyPI by name, each checked by the
		// client against its lockfile. It alone reaches the upstreams.
		up, err := url.Parse(f.goUpstream)
		if err != nil {
			return fmt.Errorf("go-upstream: %w", err)
		}
		var sumdb *url.URL
		if f.goSumDB != "" {
			if sumdb, err = url.Parse(f.goSumDB); err != nil {
				return fmt.Errorf("go-sumdb: %w", err)
			}
		}
		gp := &mirror.GoProxy{Upstream: up, SumDB: sumdb, Pins: func(r *http.Request, module, version string) bool {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				return false
			}
			pol, ok := d.store.ForSource(net.ParseIP(host))
			return ok && pol.PinsGo(module, version)
		}}
		mm := http.NewServeMux()
		mm.Handle("/go/", gp)
		// Docker Hub for the claims' builders: only the images their Dockerfiles name.
		reg, err := url.Parse(f.ociUpstream)
		if err != nil {
			return fmt.Errorf("oci-upstream: %w", err)
		}
		auth, err := url.Parse(f.ociAuth)
		if err != nil {
			return fmt.Errorf("oci-auth: %w", err)
		}
		oci := &mirror.OCIProxy{Registry: reg, Auth: auth, TagTTL: f.tagTTL, StaleFor: f.tagStale, Log: log, Pins: func(r *http.Request, repo, ref string) bool {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				return false
			}
			pol, ok := d.store.ForSource(net.ParseIP(host))
			return ok && pol.PinsImage(repo, ref)
		}}
		if f.ociAuthFile != "" {
			// Only the token service sees them; the claims never do.
			if oci.Credentials, err = mirror.LoadCredentials(f.ociAuthFile); err != nil {
				return fmt.Errorf("mirror-oci-auth-file: %w", err)
			}
		}
		if f.cacheDir != "" {
			oci.Metrics = mirror.NewCacheMetrics(mirrorMetrics)
			if oci.Store, err = mirror.OpenDiskStore(f.cacheDir, int64(f.cacheGB*(1<<30)), nil, oci.Metrics); err != nil {
				return fmt.Errorf("mirror-cache-dir: %w", err)
			}
		}
		log.Info("mirror.oci.start", "cache", f.cacheDir != "", "authenticated", oci.Credentials != nil)
		mm.Handle("/v2/", oci)
		// npm and PyPI, read only and public only (docs/runtime/egress-allowlist.md D9).
		public, err := mirrorPublicURL(f.mirrorPublic, f.mirror)
		if err != nil {
			return fmt.Errorf("mirror-public-url: %w", err)
		}
		ofClaim := func(r *http.Request) bool {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				return false
			}
			_, ok := d.store.ForSource(net.ParseIP(host))
			return ok
		}
		if f.npmUpstream != "" {
			reg, err := url.Parse(f.npmUpstream)
			if err != nil {
				return fmt.Errorf("mirror-npm-upstream: %w", err)
			}
			mm.Handle("/npm/", mirror.NewNPM(reg, public, ofClaim))
		}
		if f.pypiIndex != "" {
			idx, err := url.Parse(f.pypiIndex)
			if err != nil {
				return fmt.Errorf("mirror-pypi-index: %w", err)
			}
			files, err := url.Parse(f.pypiFiles)
			if err != nil {
				return fmt.Errorf("mirror-pypi-files: %w", err)
			}
			mm.Handle("/pypi/", mirror.NewPyPI(idx, files, public, ofClaim))
		}
		log.Info("mirror.packages.start", "npm", f.npmUpstream != "", "pypi", f.pypiIndex != "", "public", public.String())
		ml, err := new(net.ListenConfig).Listen(ctx, "tcp", f.mirror)
		if err != nil {
			return fmt.Errorf("mirror: %w", err)
		}
		ms, ml := newMirrorServer(mm, ml, mirrorIdleTimeout, mirrorConnsPerSource)
		g.Go("mirror", lifecycle.ServeHTTP(ms, ml, shutdownGrace))
	}
	peer := f.agent
	if peer.IsZero() {
		log.Warn("control.peer.unpinned", "alarm", true, "why", "any certificate of -ca reaches the control port; set -agent-cn")
	}
	tlsCfg, err := tlsutil.ControlServer(f.cert, f.key, f.ca, peer)
	if err != nil {
		return fmt.Errorf("control tls: %w", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/", d.control.Handler())
	mux.Handle("GET /metrics/mirror", mirrorMetrics.Handler())
	// Every name a claim resolved: the pinned agent's alone, never any
	// certificate of the CA (no pin: nobody's).
	mux.Handle("GET /v1/queries", tlsutil.RequirePeer(peer, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(d.queries.ForClaim(r.URL.Query().Get("claim")))
	})))
	cl, err := new(net.ListenConfig).Listen(ctx, "tcp", f.control)
	if err != nil {
		return fmt.Errorf("control: %w", err)
	}
	hs := &http.Server{Handler: mux, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	g.Go("control", lifecycle.ServeHTTP(hs, cl, shutdownGrace))
	return nil
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

// mirrorPublicURL is the mirror's base URL as the machines name it: the
// flag's, or mirror.cell.internal at the listen address's port.
func mirrorPublicURL(flagValue, listen string) (*url.URL, error) {
	if flagValue != "" {
		return url.Parse(flagValue)
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return nil, err
	}
	return url.Parse("http://" + net.JoinHostPort(policy.MirrorHost, port))
}

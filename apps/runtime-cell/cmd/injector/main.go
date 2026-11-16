// Command injector holds the claim's test credentials (Inc. 5). Only the
// proxy reaches it; it terminates the VM's TLS with the cell CA, adds the
// header from the cell vault and goes to the address the proxy validated.
// Its control port takes signed policies and serves the alerts
// (GET /v1/alerts): a credential or a bait leaving is the agent's to turn
// into a blocker.
package main

import (
	"context"
	"crypto"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/lifecycle"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/telemetry"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/version"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector/management"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

// shutdownGrace is what a stopping injector gives the requests in flight.
const shutdownGrace = 10 * time.Second

func main() {
	log := slog.New(telemetry.NewHandler(slog.NewJSONHandler(os.Stderr, nil)))
	if err := run(log); err != nil {
		log.Error("injector.failed", "err", err)
		os.Exit(lifecycle.ExitCode(err))
	}
}

// run serves until SIGTERM or SIGINT, or until a server fails; then it
// stops them all within shutdownGrace. Every defer runs on the way out.
func run(log *slog.Logger) (err error) {
	listen := flag.String("listen", ":8443", "address the proxy forwards credentialed hosts to")
	ctlAddr := flag.String("control", ":9445", "control port (mTLS, cell agent only)")
	proxies := flag.String("trusted-proxies", "", "comma-separated IPv4 addresses the egress proxies connect from, the only ones allowed to send PROXY v1 (the egress's -injector-addr names this injector)")
	claimSubnets := flag.String("claim-subnets", netguard.DefaultClaimSubnets, "comma-separated pool the claim networks take their subnets from; -internal-cidrs may not overlap it")
	internal := flag.String("internal-cidrs", "", "the cell's own networks, as on the proxy; every other private destination is refused")
	caCert := flag.String("cell-ca-cert", "/etc/kodus/injector/cell-ca.pem", "cell CA certificate (signs the VM-facing leaves)")
	caKey := flag.String("cell-ca-key", "/etc/kodus/injector/cell-ca.key.pem", "cell CA key")
	cert := flag.String("cert", "/etc/kodus/injector/cert.pem", "control certificate")
	key := flag.String("key", "/etc/kodus/injector/key.pem", "control key")
	ca := flag.String("ca", "/etc/kodus/injector/ca.pem", "CA of the cell agent certificate")
	vaultOptions := registerVaultOptions(flag.CommandLine)
	secretOptions := registerSecretStoreOptions(flag.CommandLine)
	agentPub := flag.String("agent-pub", "/etc/kodus/injector/agent.pub.pem", "the agent's ed25519 policy key")
	agentCN := flag.String("agent-cn", "", "the cell agent's certificate CN (the cell id): the control port answers no other certificate of -ca; empty answers any")
	agentSPKI := flag.String("agent-spki", "", "hex SHA-256 of the agent certificate's public key, pinned with or instead of -agent-cn")
	metricsAddr := flag.String("metrics-addr", "off", "address of /metrics (Prometheus text format: swaps, alerts, cell_openbao_up), e.g. 127.0.0.1:9467; off disables it")
	flag.Parse()
	log.Info("injector.start", "version", version.Get())
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	pair, err := tls.LoadX509KeyPair(*caCert, *caKey)
	if err != nil {
		return fmt.Errorf("cell ca: %w", err)
	}
	signer, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return fmt.Errorf("cell ca: %w", errNotSigner{})
	}
	pub, err := tlsutil.PublicKey(*agentPub)
	if err != nil {
		return fmt.Errorf("agent key: %w", err)
	}
	cidrs, err := netguard.ParseInternalCIDRs(*internal, *claimSubnets)
	if err != nil {
		return fmt.Errorf("internal-cidrs: %w", err)
	}
	trusted, err := trustedProxies(*proxies)
	if err != nil {
		return fmt.Errorf("trusted-proxies: %w", err)
	}
	if len(trusted) == 0 {
		log.Warn("injector.proxies.unconfigured", "alarm", true, "connections", "refused", "why", "no -trusted-proxies: no proxy can hand a credentialed host to this injector")
	}
	store := policy.NewStore(nil)
	alerts := eventlog.New[injector.Alert](10_000)
	vault, err := vaultOptions.open(ctx, injector.PolicyClaimAuthorizer{Policies: store})
	if err != nil {
		return fmt.Errorf("vault: %w", err)
	}
	defer func() { _ = vault.Close() }()
	if vaultOptions.directory == "" {
		log.Warn("injector.vault.unconfigured", "credentials", "refused")
	}
	secrets, err := secretOptions.open()
	if err != nil {
		return fmt.Errorf("secret store: %w", err)
	}
	if secrets == nil {
		log.Warn("injector.secrets.unconfigured", "placeholders", "refused")
	}
	// Every server and loop below runs in g, which stops them all (before
	// the vault closes) on the way out.
	g := lifecycle.New(ctx)
	defer func() {
		deadline, cancel := lifecycle.Within(shutdownGrace)(ctx)
		defer cancel()
		err = errors.Join(err, g.Stop(deadline))
	}()
	if vaultOptions.adminSocket != "" {
		g.Go("vault management", func(ctx context.Context) error {
			return management.Serve(ctx, vaultOptions.adminSocket, vault, log)
		})
	}
	reg := metrics.NewRegistry()
	im := injector.NewMetrics(reg)
	if err := serveMetrics(ctx, g, log, *metricsAddr, reg); err != nil {
		return fmt.Errorf("metrics: %w", err)
	}
	if bao, ok := secrets.(*injector.OpenBaoSecrets); ok && bao != nil {
		g.Go("openbao watch", func(ctx context.Context) error { im.WatchOpenBao(ctx, bao, 30*time.Second); return nil })
	}
	inj := &injector.Injector{
		Policies: store, CA: pair.Leaf, CAKey: signer, TrustedProxies: trusted, InternalCIDRs: cidrs, Alerts: alerts,
		// Credential values stay inside the owner-managed injector vault.
		Vault: vault, Secrets: secrets, Log: log, Metrics: im,
	}
	l, err := new(net.ListenConfig).Listen(ctx, "tcp4", *listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	g.Go("serve", func(ctx context.Context) error { return inj.Serve(ctx, l) })
	g.Go("sweep", func(ctx context.Context) error {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return nil
			case <-t.C:
				store.Sweep()
			}
		}
	})

	peer := tlsutil.Peer{CN: *agentCN, SPKI: *agentSPKI}
	if peer.IsZero() {
		log.Warn("control.peer.unpinned", "alarm", true, "why", "any certificate of -ca reaches the control port; set -agent-cn")
	}
	tlsCfg, err := tlsutil.ControlServer(*cert, *key, *ca, peer)
	if err != nil {
		return fmt.Errorf("control tls: %w", err)
	}
	mux := http.NewServeMux()
	controlServer := &control.Server{Policies: store, AgentKey: pub}
	if vaultOptions.directory != "" {
		controlServer.DurableDelete = vault.RevokeKnownClaim
	}
	controlServer.Register(mux)
	mux.HandleFunc("GET /v1/alerts", alerts.Handler())
	cl, err := new(net.ListenConfig).Listen(ctx, "tcp", *ctlAddr)
	if err != nil {
		return fmt.Errorf("control: %w", err)
	}
	hs := &http.Server{Handler: mux, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	g.Go("control", lifecycle.ServeHTTP(hs, cl, shutdownGrace))
	<-g.Context().Done() // a signal, or a part that failed (the deferred stop returns its error)
	return nil
}

type errNotSigner struct{}

func (errNotSigner) Error() string { return "cell CA key is not a signer" }

// serveMetrics serves reg on addr in g ("" or off: nothing), as the cell's does.
func serveMetrics(ctx context.Context, g *lifecycle.Group, log *slog.Logger, addr string, reg *metrics.Registry) error {
	if addr == "" || addr == "off" {
		return nil
	}
	l, err := new(net.ListenConfig).Listen(ctx, "tcp", addr)
	if err != nil {
		return err
	}
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", reg.Handler())
	srv := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	serve := lifecycle.ServeHTTP(srv, l, 5*time.Second)
	g.Go("metrics", func(ctx context.Context) error {
		if err := serve(ctx); err != nil {
			log.Error("metrics.serve", "err", err)
		}
		return nil
	})
	log.Info("metrics.listening", "addr", l.Addr().String())
	return nil
}

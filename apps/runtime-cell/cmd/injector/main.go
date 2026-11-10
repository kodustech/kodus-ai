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
	"flag"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/eventlog"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector/management"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

var version = "dev"

func main() {
	listen := flag.String("listen", ":8443", "address the proxy forwards credentialed hosts to")
	ctlAddr := flag.String("control", ":9445", "control port (mTLS, cell agent only)")
	proxies := flag.String("trusted-proxies", "", "comma-separated proxy addresses allowed to send PROXY v1")
	internal := flag.String("internal-cidrs", "", "the cell's own networks, as on the proxy; every other private destination is refused")
	caCert := flag.String("cell-ca-cert", "/etc/kodus/injector/cell-ca.pem", "cell CA certificate (signs the VM-facing leaves)")
	caKey := flag.String("cell-ca-key", "/etc/kodus/injector/cell-ca.key.pem", "cell CA key")
	cert := flag.String("cert", "/etc/kodus/injector/cert.pem", "control certificate")
	key := flag.String("key", "/etc/kodus/injector/key.pem", "control key")
	ca := flag.String("ca", "/etc/kodus/injector/ca.pem", "CA of the cell agent certificate")
	vaultOptions := registerVaultOptions(flag.CommandLine)
	agentPub := flag.String("agent-pub", "/etc/kodus/injector/agent.pub.pem", "the agent's ed25519 policy key")
	flag.Parse()
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	log.Info("injector.start", "version", version)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()

	pair, err := tls.LoadX509KeyPair(*caCert, *caKey)
	must(log, "cell ca", err)
	signer, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		must(log, "cell ca", errNotSigner{})
	}
	pub, err := tlsutil.PublicKey(*agentPub)
	must(log, "agent key", err)
	cidrs, err := netguard.ParseCIDRs(*internal)
	must(log, "internal-cidrs", err)
	var trusted []string
	for _, p := range strings.Split(*proxies, ",") {
		if p = strings.TrimSpace(p); p != "" {
			trusted = append(trusted, p)
		}
	}
	store := policy.NewStore(nil)
	alerts := eventlog.New[injector.Alert](10_000)
	vault, err := vaultOptions.open(ctx, injector.PolicyClaimAuthorizer{Policies: store})
	must(log, "vault", err)
	defer vault.Close()
	if vaultOptions.directory == "" {
		log.Warn("injector.vault.unconfigured", "credentials", "refused")
	}
	if vaultOptions.adminSocket != "" {
		go func() {
			must(log, "vault management", management.Serve(ctx, vaultOptions.adminSocket, vault, log))
		}()
	}
	inj := &injector.Injector{
		Policies: store, CA: pair.Leaf, CAKey: signer, TrustedProxies: trusted, InternalCIDRs: cidrs, Alerts: alerts,
		// Credential values stay inside the owner-managed injector vault.
		Vault: vault, Log: log,
	}
	l, err := net.Listen("tcp4", *listen)
	must(log, "listen", err)
	go func() { must(log, "serve", inj.Serve(ctx, l)) }()
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				store.Sweep()
			}
		}
	}()

	tlsCfg, err := tlsutil.Server(*cert, *key, *ca)
	must(log, "control tls", err)
	mux := http.NewServeMux()
	controlServer := &control.Server{Policies: store, AgentKey: pub}
	if vaultOptions.directory != "" {
		controlServer.DurableDelete = vault.RevokeKnownClaim
	}
	controlServer.Register(mux)
	mux.HandleFunc("GET /v1/alerts", alerts.Handler())
	hs := &http.Server{Addr: *ctlAddr, Handler: mux, TLSConfig: tlsCfg, ReadHeaderTimeout: 10 * time.Second}
	go func() { <-ctx.Done(); _ = hs.Close() }()
	if err := hs.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
		must(log, "control", err)
	}
}

type errNotSigner struct{}

func (errNotSigner) Error() string { return "cell CA key is not a signer" }

func must(log *slog.Logger, what string, err error) {
	if err != nil {
		log.Error(what, "err", err)
		os.Exit(1)
	}
}

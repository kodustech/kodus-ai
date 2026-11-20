package main

// "cell register" enrolls a new cell with a one-time token: it makes the
// cell's key here (the key never leaves this machine), sends a CSR and
// writes the certificate the hub signs. "cell renew" does the same over
// mTLS with the current certificate. Neither prints key material.

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/enrollment"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tlsutil"
)

type registerRequest struct {
	Token string `json:"token"`
	// Topology is omitted unless the operator names one: the hub takes the
	// token's (a token is bound to its topology when it is created).
	Topology string `json:"topology,omitempty"`
	CSR      string `json:"csr"`
}

func runEnroll(cmd string, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("cell "+cmd, flag.ContinueOnError)
	fs.SetOutput(stderr)
	conf := fs.String("config", os.Getenv("KODUS_CELL_CONFIG"), "cell config file: its tls paths are where the files are written (renew: read) and its hubUrl is the default -hub")
	hub := fs.String("hub", os.Getenv("KODUS_HUB_HTTPS_URL"), "hub base URL, https://host:port")
	ca := fs.String("ca", "", "PEM of the CA that signs the hub's TLS certificate; register pins it as the cell's hub CA (renew: default the cell's CA file)")
	out := fs.String("out", "/etc/kodus/cell", "directory for key.pem, cert.pem, ca.pem and issuer.pem (unless -config names them)")
	var token, topology, cert, key, bootstrap *string
	var ifUnregistered *bool
	if cmd == "register" {
		token = fs.String("token", "", "one-time registration token (or KODUS_CELL_REGISTRATION_TOKEN)")
		ifUnregistered = fs.Bool("if-unregistered", false, "do nothing when a cell certificate is already where register would write it (a restarted Kubernetes cell pod keeps its cell; the token is single use)")
		topology = fs.String("topology", "", "the token's topology (hybrid | self_hosted); empty: whatever the token was made for. A topology that is not the token's is refused and burns the token")
		bootstrap = fs.String("bootstrap", "", "a fleet host's bootstrap file (JSON hubUrl, hubCa, token) its provider wrote; register reads it and deletes it once the hub answered. Not with -token, -hub or -ca")
	} else {
		cert = fs.String("cert", "", "current cell certificate (default the cell's cert file)")
		key = fs.String("key", "", "current cell key (default the cell's key file)")
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	var boot *bootstrapFile
	if cmd == "register" && *bootstrap != "" {
		if set["token"] || set["hub"] || set["ca"] {
			fmt.Fprintln(stderr, "cell register: -bootstrap names the hub, its CA and the token; give none of -token, -hub, -ca with it")
			return 2
		}
		b, err := readBootstrap(*bootstrap)
		if err != nil {
			fmt.Fprintf(stderr, "cell register: %v\n", err)
			return 2
		}
		boot = b
		*hub = b.HubURL
	}
	paths, hubURL, err := enrollTargets(*conf, *out, *hub, set["out"])
	if err != nil {
		fmt.Fprintf(stderr, "cell %s: %v\n", cmd, err)
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var res *enrollment.CertificateResponse
	if cmd == "register" && *ifUnregistered && registered(paths) {
		fmt.Fprintf(stdout, "cell register: already registered (%s); nothing to do\n", paths.Cert)
		return 0
	}
	switch {
	case cmd == "register" && boot != nil:
		res, err = registerFromBootstrap(ctx, hubURL, *bootstrap, boot, *topology, paths)
	case cmd == "register":
		tok := *token
		if tok == "" {
			tok = os.Getenv("KODUS_CELL_REGISTRATION_TOKEN")
		}
		res, err = register(ctx, hubURL, *ca, tok, *topology, paths)
	default:
		// Writes the files itself: the agent's renewal loop takes the same path.
		res, err = renew(ctx, hubURL, orValue(*ca, paths.CA), orValue(*cert, paths.Cert), orValue(*key, paths.Key), paths)
	}
	if err != nil {
		fmt.Fprintf(stderr, "cell %s: %v\n", cmd, err)
		return 1
	}
	fmt.Fprintf(stdout, "cell %s: cell %s, serial %s, expires %s; wrote %s\n", cmd, res.CellID, res.Serial, res.ExpiresAt, filepath.Dir(paths.Cert))
	return 0
}

// enrollTargets resolves the files to write and the hub to call. Without
// -config (or with -out given) they are key.pem, cert.pem, ca.pem and
// issuer.pem in -out: the names cmd/cell reads by default. With -config they
// are the file's tls paths, so the cell runs with what register just wrote.
func enrollTargets(conf, out, hub string, outSet bool) (enrollment.Paths, string, error) {
	p := enrollment.Paths{Key: filepath.Join(out, "key.pem"), Cert: filepath.Join(out, "cert.pem"), CA: filepath.Join(out, "ca.pem"), Issuer: filepath.Join(out, "issuer.pem")}
	if conf == "" {
		return p, hub, nil
	}
	var cell settings
	cellFlags := flag.NewFlagSet("cell", flag.ContinueOnError)
	cell.register(cellFlags)
	fc, err := loadFile(conf, cellFlags)
	if err != nil {
		return p, hub, err
	}
	if !outSet {
		p.Key, p.Cert, p.CA = orValue(fc["key"], p.Key), orValue(fc["cert"], p.Cert), orValue(fc["ca"], p.CA)
		p.Issuer = orValue(fc["issuer"], filepath.Join(filepath.Dir(p.Cert), "issuer.pem"))
	}
	if hub == "" && fc["hub-url"] != "" {
		hub, err = enrollment.HTTPSBase(fc["hub-url"])
		if err != nil {
			return p, hub, err
		}
	}
	return p, hub, nil
}

// registered reports whether a cell certificate and its key are in place.
func registered(p enrollment.Paths) bool {
	for _, f := range []string{p.Cert, p.Key} {
		if st, err := os.Stat(f); err != nil || st.Size() == 0 {
			return false
		}
	}
	return true
}

func orValue(v, def string) string {
	if v != "" {
		return v
	}
	return def
}

// bootstrapFile is what runtime-fleet hands a new host through its provider
// (boat files, user data, cloud-init): the only secret is the token, single
// use and short-lived (docs/runtime/host-providers.md §8.1).
type bootstrapFile struct {
	HubURL string `json:"hubUrl"`
	HubCA  string `json:"hubCa"`
	Token  string `json:"token"`
}

func readBootstrap(path string) (*bootstrapFile, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // G304: the operator's -bootstrap flag
	if err != nil {
		return nil, err
	}
	var b bootstrapFile
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		return nil, fmt.Errorf("bootstrap file: %w", err)
	}
	if b.HubURL == "" || b.Token == "" || !strings.Contains(b.HubCA, "BEGIN CERTIFICATE") {
		return nil, errors.New("bootstrap file needs hubUrl, hubCa and token")
	}
	return &b, nil
}

// registerFromBootstrap registers with the bootstrap's token and CA, then
// deletes the bootstrap file once the hub answered, accepted or refused: the
// token is burned either way. A hub never reached (a transport error) keeps
// the file, so a retry can still use the unspent token.
func registerFromBootstrap(ctx context.Context, hub, path string, b *bootstrapFile, topology string, p enrollment.Paths) (*enrollment.CertificateResponse, error) {
	caTmp, err := os.CreateTemp("", "kodus-hub-ca-*.pem")
	if err != nil {
		return nil, err
	}
	defer os.Remove(caTmp.Name()) //nolint:errcheck // a temp copy of a public CA
	if _, err := caTmp.WriteString(b.HubCA); err != nil {
		_ = caTmp.Close()
		return nil, err
	}
	if err := caTmp.Close(); err != nil {
		return nil, err
	}
	res, err := register(ctx, hub, caTmp.Name(), b.Token, topology, p)
	var transport *url.Error
	if err == nil || !errors.As(err, &transport) {
		if rmErr := os.Remove(path); rmErr != nil && !os.IsNotExist(rmErr) && err == nil { //nolint:gosec // G703: the -bootstrap file the operator named, removed once used
			return nil, fmt.Errorf("registered, but the bootstrap file was not removed: %w", rmErr)
		}
	}
	if err != nil {
		return nil, err
	}
	// A fleet token makes a Kodus cell (the hub binds it); the hello says so.
	if strings.HasPrefix(b.Token, "kcf_") {
		if err := os.WriteFile(ownerFile(p.Cert), []byte("kodus\n"), 0o644); err != nil { //nolint:gosec // G306: not a secret
			return nil, err
		}
	}
	return res, nil
}

// register enrolls with the token over TLS verified by the operator's hub
// CA, writes the identity and pins that CA as the cell's hub CA.
func register(ctx context.Context, hub, caFile, token, topology string, p enrollment.Paths) (*enrollment.CertificateResponse, error) {
	if token == "" || caFile == "" {
		return nil, errors.New("-token and -ca are required")
	}
	caPEM, err := os.ReadFile(caFile) //nolint:gosec // G304: caFile is the operator's -ca flag
	if err != nil {
		return nil, err
	}
	pool, err := tlsutil.Pool(caFile)
	if err != nil {
		return nil, err
	}
	key, csr, err := enrollment.NewKeyAndCSR()
	if err != nil {
		return nil, err
	}
	hc := enrollment.HTTPClient(&tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS13})
	got, err := enrollment.RequestCertificate(ctx, hc, hub, "/cells/register", registerRequest{Token: token, Topology: topology, CSR: string(csr)}, key, nil)
	if err != nil {
		return nil, err
	}
	if err := enrollment.WriteIdentity(p, key, got); err != nil {
		return nil, err
	}
	if err := enrollment.WriteHubCA(p.CA, caPEM); err != nil {
		return nil, err
	}
	// A cell that redeemed a token is a customer cell; its hello says so.
	if err := os.WriteFile(ownerFile(p.Cert), []byte("customer\n"), 0o644); err != nil { //nolint:gosec // G306: not a secret
		return nil, err
	}
	return got.Response, nil
}

func renew(ctx context.Context, hub, caFile, certFile, keyFile string, out enrollment.Paths) (*enrollment.CertificateResponse, error) {
	holder, err := enrollment.LoadCertHolder(certFile, keyFile)
	if err != nil {
		return nil, err
	}
	pool, err := tlsutil.Pool(caFile)
	if err != nil {
		return nil, err
	}
	res, _, err := enrollment.Renew(ctx, hub, holder.ClientTLS(pool), holder.CellID(), out)
	return res, err
}

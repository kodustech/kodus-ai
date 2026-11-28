package preflight

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The network checks (`cell preflight -network`): what a fresh install
// fails on that the host checks cannot see. Each only reads: the hub is
// asked GET /health over the cell's own mTLS (no hello, nothing
// registered), an image is looked up on the host or its manifest read
// (no layer pulled), a registry is asked GET /v2/ (nothing pushed), a Git
// host is asked GET / with no token.

// Names of the network checks: stable, docs and scripts grep them.
const (
	NameHub              = "hub"
	NameEgressContainer  = "egress-container"
	NameBuildCacheRemote = "build-cache-remote"
	NameBakeShare        = "bake-share"
	NameBakeSharePull    = "bake-share-pull"
	NameGitAPI           = "git-api"
)

// NetCheck is one network check for RunNetwork: Below is the status it is
// reported at when it gives no answer before the run's bound.
type NetCheck struct {
	Name  string
	Below Status
	Run   func(ctx context.Context) Result
}

// RunNetwork runs the checks at once, each under its own perCheck timeout
// and all under ctx (the run's bound), and returns their results in the
// order given. A check still running when ctx ends is reported at its
// Below status, so one hung probe never holds the report.
func RunNetwork(ctx context.Context, perCheck time.Duration, checks []NetCheck) []Result {
	type done struct {
		i int
		r Result
	}
	ch := make(chan done, len(checks))
	for i, c := range checks {
		go func() {
			cctx, cancel := context.WithTimeout(ctx, perCheck)
			defer cancel()
			r := c.Run(cctx)
			if r.Status != OK && errors.Is(cctx.Err(), context.DeadlineExceeded) {
				r.Reason += fmt.Sprintf(" (no answer within the check's %s)", perCheck)
			}
			ch <- done{i, r}
		}()
	}
	out := make([]Result, len(checks))
	got := make([]bool, len(checks))
	for n := 0; n < len(checks); n++ {
		select {
		case d := <-ch:
			out[d.i], got[d.i] = d.r, true
		case <-ctx.Done():
			for i, c := range checks {
				if !got[i] {
					out[i] = Result{
						Name: c.Name, Status: c.Below, Reason: "no answer before the -network run's bound passed",
						Fix: "check the network path from this host to what this check names, then run cell preflight -network again",
					}
				}
			}
			return out
		}
	}
	return out
}

// Hub is the cell's way to the hub: -hub-url, and the client TLS the agent
// dials it with (enrollment.CertHolder.ClientTLS on the hub roots).
type Hub struct {
	URL string
	TLS *tls.Config
	// LoadErr is why TLS is nil: the certificate or the hub CA did not load.
	LoadErr error
	// LookupHost is net.DefaultResolver.LookupHost when nil.
	LookupHost func(ctx context.Context, host string) ([]string, error)
}

// CheckHub reaches the hub as the agent's WebSocket would (internal/agent
// session.go, hubclient.Dial: direct TCP, TLS 1.3 with the cell's
// certificate, the chain checked against -ca only), then asks the public
// listener's GET /health, which says nothing about who is connected and
// changes nothing. No hello is sent: whether the hub accepts the
// certificate is decided at the WebSocket, at cell start. No hub, no
// claims: every failure is a fail.
func CheckHub(ctx context.Context, h Hub) Result {
	u, err := url.Parse(h.URL)
	if h.URL == "" || err != nil || (u.Scheme != "wss" && u.Scheme != "https") || u.Hostname() == "" {
		return fail(NameHub, fmt.Sprintf("-hub-url %q is not wss://host[:port]/<path>", h.URL), "set -hub-url (or KODUS_HUB_URL) to the hub address cell register was given")
	}
	if h.TLS == nil {
		reason := "not dialed: the cell's certificate or the hub CA did not load"
		if h.LoadErr != nil {
			reason += ": " + oneLine(h.LoadErr.Error())
		}
		return fail(NameHub, reason, "fix the cell-cert and trust-roots checks first")
	}
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = "443"
	}
	where := net.JoinHostPort(host, port)
	var steps []string
	addrs := []string{host}
	if net.ParseIP(host) == nil {
		lookup := h.LookupHost
		if lookup == nil {
			lookup = net.DefaultResolver.LookupHost
		}
		t0 := time.Now()
		addrs, err = lookup(ctx, host)
		if err != nil || len(addrs) == 0 {
			return fail(NameHub, "DNS: "+host+" does not resolve: "+errText(err),
				"check this host's resolver (resolvectl status, /etc/resolv.conf) and that -hub-url names the hub")
		}
		steps = append(steps, "DNS "+ms(time.Since(t0)))
	}
	var conn net.Conn
	var dialErr error
	t0 := time.Now()
	for _, a := range addrs {
		var d net.Dialer
		if conn, dialErr = d.DialContext(ctx, "tcp", net.JoinHostPort(a, port)); dialErr == nil {
			break
		}
	}
	if conn == nil {
		return fail(NameHub, fmt.Sprintf("TCP to %s (%s) does not connect: %s", where, strings.Join(addrs, ", "), oneLine(dialErr.Error())),
			"open outbound TCP "+port+" from this host to the hub (firewall, security group, egress proxy rules) and check that the hub listens there")
	}
	defer func() { _ = conn.Close() }()
	if dl, set := ctx.Deadline(); set {
		_ = conn.SetDeadline(dl)
	}
	ip, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
	steps = append(steps, "TCP "+ms(time.Since(t0))+" (one round trip)")
	cfg := h.TLS.Clone()
	cfg.ServerName = host
	if cfg.MinVersion < tls.VersionTLS13 {
		cfg.MinVersion = tls.VersionTLS13
	}
	tc := tls.Client(conn, cfg)
	t0 = time.Now()
	if err := tc.HandshakeContext(ctx); err != nil {
		var verr *tls.CertificateVerificationError
		if errors.As(err, &verr) {
			return fail(NameHub, "the certificate "+where+" presents does not verify against the hub CA: "+oneLine(err.Error()),
				"-ca must be the hub CA cell register wrote; a TLS-inspecting proxy between this host and the hub breaks mTLS: exempt the hub's address from it")
		}
		return fail(NameHub, "TLS handshake with "+where+" failed: "+oneLine(err.Error()),
			"check that "+where+" is the hub itself (TLS 1.3, no proxy that terminates TLS in front of it)")
	}
	steps = append(steps, "TLS "+ms(time.Since(t0)))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+where+"/health", nil)
	if err != nil {
		return fail(NameHub, oneLine(err.Error()), "check -hub-url")
	}
	req.Close = true
	t0 = time.Now()
	resp, err := roundTrip(tc, req)
	if err != nil {
		return warn(NameHub, fmt.Sprintf("%s at %s took TLS but GET /health did not answer: %s", where, ip, oneLine(err.Error())),
			"check that the hub behind "+where+" is up")
	}
	defer func() { _ = resp.Body.Close() }()
	steps = append(steps, fmt.Sprintf("GET /health %d in %s", resp.StatusCode, ms(time.Since(t0))))
	reason := where + ": " + strings.Join(steps, ", ")
	if ip != host {
		reason = where + " at " + ip + ": " + strings.Join(steps, ", ")
	}
	if resp.StatusCode != http.StatusOK {
		return warn(NameHub, reason+": the listener answers but the hub may not be serving", "check the hub's logs and whatever proxies "+where)
	}
	if leaf := tc.ConnectionState().PeerCertificates; len(leaf) > 0 {
		reason += "; its certificate (CN " + leaf[0].Subject.CommonName + ") chains to -ca"
	}
	return ok(NameHub, reason)
}

func roundTrip(c net.Conn, req *http.Request) (*http.Response, error) {
	if err := req.Write(c); err != nil {
		return nil, err
	}
	resp, err := http.ReadResponse(bufio.NewReader(c), req)
	if err != nil {
		return nil, err
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	return resp, nil
}

// NetworkDocker is what the network checks ask the host's Docker.
type NetworkDocker interface {
	// ImagePresent is whether the daemon has ref (false, nil when not).
	ImagePresent(ctx context.Context, ref string) (bool, error)
	// ManifestReadable reads ref's manifest from its registry with the
	// credentials the cell's docker would use, pulling nothing.
	ManifestReadable(ctx context.Context, ref string) error
	// ContainerStatus is a container's state ("running", "exited"); found
	// false when there is none by that name.
	ContainerStatus(ctx context.Context, name string) (status string, found bool, err error)
}

// Image is one image the cell runs, by the flag that names it.
type Image struct {
	Name, Flag, Ref string
	// Below is Fail for an image every claim runs, Warn for one only some
	// claims run; Why says which.
	Below Status
	Why   string
}

// CheckImage checks that an image resolves: the driver pulls an image the first time it runs it, so an
// image that does not resolve fails the claim that needs it there. It
// resolves when the host has it, or when its manifest is readable from
// its registry; no layer is pulled.
func CheckImage(ctx context.Context, d NetworkDocker, im Image) Result {
	present, err := d.ImagePresent(ctx, im.Ref)
	if err != nil {
		return Result{Name: im.Name, Status: im.Below, Reason: im.Flag + ": Docker cannot say whether " + im.Ref + " is on this host: " + oneLine(err.Error()), Fix: "check that Docker answers (the docker check)"}
	}
	if present {
		return ok(im.Name, im.Ref+" is present locally")
	}
	reg := registryOf(im.Ref)
	if err := d.ManifestReadable(ctx, im.Ref); err != nil {
		reason := fmt.Sprintf("%s: %s is not on this host and its manifest is not readable from %s: %s", im.Flag, im.Ref, reg, oneLine(err.Error()))
		if im.Why != "" {
			reason += ": " + im.Why
		}
		return Result{
			Name: im.Name, Status: im.Below, Reason: reason,
			Fix: "check that " + reg + " answers from this host and that the digest exists; for a private registry give the cell's unit DOCKER_CONFIG with a login (the cell runs docker with its own HOME), or pull it ahead: docker pull " + im.Ref,
		}
	}
	return ok(im.Name, im.Ref+" is not on this host yet; its manifest is readable from "+reg+" (pulled at first use)")
}

// registryOf is the registry a reference pulls from (docker.io when its
// first segment names no host).
func registryOf(ref string) string {
	first, _, found := strings.Cut(ref, "/")
	if !found || (!strings.ContainsAny(first, ".:") && first != "localhost") {
		return "docker.io"
	}
	return first
}

// CheckEgressContainer checks the egress container: dockergvisor attaches -gvisor-egress-container to
// every claim network (network.go, AttachEgress) and refuses a claim it
// cannot attach; a stopped one leaves every claim without a resolver or a
// way out.
func CheckEgressContainer(ctx context.Context, d NetworkDocker, name string) Result {
	status, found, err := d.ContainerStatus(ctx, name)
	switch {
	case err != nil:
		return fail(NameEgressContainer, "Docker cannot inspect "+name+": "+oneLine(err.Error()), "check that Docker answers (the docker check)")
	case !found:
		return fail(NameEgressContainer, "no container named "+name+" (-gvisor-egress-container): every claim network joins it, and a claim it cannot join is refused",
			"start the egress container (cmd/egress with -dns-listen and -transparent=false) under that name with --restart unless-stopped, as the installer does")
	case status != "running":
		return fail(NameEgressContainer, name+" is "+status+", not running: claims would have no resolver and no way out",
			"docker start "+name+", and give it --restart unless-stopped; its logs say why it stopped (docker logs "+name+")")
	}
	return ok(NameEgressContainer, name+" is running")
}

// Registry is one registry off the cell that the cell itself pushes to or
// pulls from (dockergvisor remotecache: -gvisor-build-cache-remote,
// -gvisor-bake-share, -gvisor-bake-share-pull).
type Registry struct {
	Name, Flag, Where string
	// AuthFlag is the flag of its credential file; HasAuth whether one is
	// set.
	AuthFlag string
	HasAuth  bool
	// StartErr is a refusal the cell makes at start (the credential file
	// does not load, the store does not open): a fail, Check not run.
	StartErr error
	// Check is remotecache.Registry.Check: GET /v2/ with the credential.
	Check func(ctx context.Context) error
	// Why is what the cell does without it.
	Why string
}

// CheckRegistry checks the optional registry: the cell runs without the registry (builds run cold,
// bakes stay on the cell, claims build instead of pulling), so a registry
// that does not answer or refuses the credential warns.
func CheckRegistry(ctx context.Context, r Registry) Result {
	if r.StartErr != nil {
		return fail(r.Name, r.Flag+": "+oneLine(r.StartErr.Error())+": the cell refuses to start",
			"write user:password on the first line of the file "+r.AuthFlag+" names, readable by the cell's user, or fix "+r.Flag)
	}
	t0 := time.Now()
	if err := r.Check(ctx); err != nil {
		reason := r.Where + ": " + oneLine(err.Error())
		if r.Why != "" {
			reason += ": " + r.Why
		}
		fix := "check that " + r.Where + " answers from this host (an egress proxy: HTTPS_PROXY in the cell's unit)"
		if r.HasAuth {
			fix += ", and that " + r.AuthFlag + " holds a user:password the registry takes over basic auth (the cell sends no other)"
		} else {
			fix += "; a registry that asks for a credential needs " + r.AuthFlag
		}
		return warn(r.Name, reason, fix)
	}
	with := "without a credential"
	if r.HasAuth {
		with = "with the credential of " + r.AuthFlag
	}
	return ok(r.Name, fmt.Sprintf("%s answered GET /v2/ in %s, %s", r.Where, ms(time.Since(t0)), with))
}

// CheckGit checks the Git API: the agent downloads every repository of a claim from the Git
// API (gitsource.TarballURL, tarball.FetchExtractRevoke, with the
// process's proxy settings and the system roots) and revokes its token
// there. Each URL is asked GET with no token and no redirect followed: any
// HTTP answer means the host is reachable over trusted TLS. No code, no
// claim: one that does not answer fails.
func CheckGit(ctx context.Context, client *http.Client, urls []string) Result {
	c := http.Client{}
	if client != nil {
		c = *client
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	var answered, failed, hosts []string
	for _, raw := range urls {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			failed = append(failed, fmt.Sprintf("%q is not a URL", raw))
			continue
		}
		hosts = append(hosts, u.Host)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
		if err != nil {
			failed = append(failed, u.Host+": "+oneLine(err.Error()))
			continue
		}
		t0 := time.Now()
		resp, err := c.Do(req)
		if err != nil {
			failed = append(failed, u.Host+" does not answer: "+oneLine(err.Error()))
			continue
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		_ = resp.Body.Close()
		answered = append(answered, fmt.Sprintf("%s answered %d in %s", u.Host, resp.StatusCode, ms(time.Since(t0))))
	}
	if len(failed) > 0 {
		return fail(NameGitAPI, strings.Join(append(failed, answered...), "; ")+": claims cannot download their code",
			"open outbound HTTPS from this host to "+strings.Join(hosts, " and ")+" (through a proxy: HTTPS_PROXY in the cell's unit; a TLS-inspecting proxy's CA must be in the system roots), or point -git-api at the forge's API (GitHub Enterprise: https://<host>/api/v3)")
	}
	return ok(NameGitAPI, strings.Join(answered, "; "))
}

func ms(d time.Duration) string {
	if d < time.Millisecond {
		return "<1ms"
	}
	return d.Round(time.Millisecond).String()
}

func errText(err error) string {
	if err == nil {
		return "no address"
	}
	return oneLine(err.Error())
}

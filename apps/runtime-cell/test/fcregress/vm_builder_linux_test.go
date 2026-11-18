//go:build linux

package fcregress

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/microvm"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// A build in an environment VM reaches a host the cell ends TLS for (the
// injector: a credentialed host here, a registry the cell inspects in a
// Run) only when its RUN steps trust the cell CA. The VM dockerd's stock
// BuildKit keeps each base image's trust store, so such a RUN fails on the
// injector's leaf: that is how kodus-ai's `bun install -g` failed on
// Firecracker. A claim whose machines trust the cell CA builds with the
// kit's buildkitd (the cell builder's, exec-ca-bundle.patch), and the same
// RUN passes.
//
// The control is the same build on the same VM without the cell's trust:
// it must fail on the certificate, or the test proves nothing.
func TestFirecrackerABuildOfATrustingClaimReachesAHostTheCellInspects(t *testing.T) {
	const host = "example.com"
	ctx := context.Background()
	ca, err := testpki.NewCA("fc-vmbuilder-cell-ca")
	if err != nil {
		t.Fatal(err)
	}
	// The cell's trust files: the host's public roots plus the cell CA, as
	// machinetrust builds them.
	trustDir := t.TempDir()
	roots, err := os.ReadFile("/etc/ssl/certs/ca-certificates.crt")
	if err != nil {
		t.Fatal(err)
	}
	bundle, cellCA := filepath.Join(trustDir, "bundle.pem"), filepath.Join(trustDir, "cell-ca.pem")
	if err := os.WriteFile(bundle, append(append(roots, '\n'), ca.PEM...), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cellCA, ca.PEM, 0o644); err != nil {
		t.Fatal(err)
	}
	s := open(t, func(f *microvm.Firecracker) {
		f.Trust = machinetrust.Files{Bundle: bundle, CellCA: cellCA}
		f.DataGB = 10
	})
	stamp := time.Now().Format("150405")
	claim := "fc-vmb-" + stamp
	n := claimNet(t, s.Driver, claim)

	// The host behind the injector: a local TLS server that records each
	// request and answers a mark the build prints.
	upstreamCA, _ := testpki.NewCA("fc-vmbuilder-upstream-ca")
	upCert, _ := upstreamCA.Issue(host, time.Hour, host)
	var mu sync.Mutex
	var seen []string
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.URL.Path)
		mu.Unlock()
		_, _ = w.Write([]byte("kodus-vmbuilder-reached-" + stamp + "\n"))
	}))
	up.TLS = &tls.Config{Certificates: []tls.Certificate{upCert}, MinVersion: tls.VersionTLS12}
	up.StartTLS()
	t.Cleanup(up.Close)
	store := policy.NewStore(time.Now)
	inj := &injector.Injector{
		Policies: store, Vault: injectorVault{claim: claim, host: host, value: "kfc-vmb-" + stamp, bait: "kfc-vmb-bait-" + stamp},
		CA: ca.Cert, CAKey: ca.Key, TrustedProxies: []string{"127.0.0.1"}, UpstreamRoots: upstreamCA.Pool(),
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", up.Listener.Addr().String())
		},
	}
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ictx, stop := context.WithCancel(ctx)
	t.Cleanup(stop)
	go func() { _ = inj.Serve(ictx, l) }()
	e := startEgress(t, s.Place.Egress().String(), "-injector-addr", l.Addr().String())

	ref, err := s.Driver.Create(ctx, machineSpec(claim, n, driver.RoleWorkload, func(m *driver.MachineSpec) {
		m.ImageID, m.ImageRef = "environment", "environment"
		m.ClaimSize = driver.ClaimSize{MemoryMB: 4096, CPUs: 2}
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Driver.Destroy(context.WithoutCancel(ctx), ref) })
	// Docker Hub over TLS straight through (the base image), the host
	// through the injector.
	pol := policy.ClaimPolicy{
		ClaimID: claim, OrgID: "org-fc", Sources: []string{ref.PrivateAddress},
		Allow:           []string{host, "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "production.cloudfront.docker.com"},
		CredentialHosts: []string{host}, InspectSources: []string{ref.PrivateAddress},
		SteerTo: n.EgressAddress, Phase: policy.PhaseBuild, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	}
	if err := e.Push(ctx, pol); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(pol); err != nil {
		t.Fatal(err)
	}
	c := answer(t, func() (*guest.Client, error) {
		rw, err := s.Driver.DialGuest(ctx, ref)
		if err != nil {
			return nil, err
		}
		return guest.NewClient(rw, cellID, claim), nil
	}, time.Minute)
	t.Cleanup(func() { _ = c.Close() })
	if v := run(t, c, "buildkitd --version", 10_000); v.ExitCode != 0 || !strings.Contains(v.Stdout, "-kodus.") {
		t.Fatalf("the kit's buildkitd is not the cell builder's: %q %q", v.Stdout, v.Stderr)
	}
	waitDocker := run(t, c, "for i in $(seq 60); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1", 90_000)
	if waitDocker.ExitCode != 0 {
		t.Fatalf("dockerd never answered in the VM: %q", waitDocker.Stderr)
	}

	project := t.TempDir()
	// node, as kodus-ai's build: its image sets no trust of its own, so the
	// builder's NODE_EXTRA_CA_CERTS reaches the RUN (an image that sets its
	// own, such as curlimages/curl's CURL_CA_BUNDLE, keeps it by design).
	dockerfile := "FROM docker.io/library/node:22.23.4-slim\n" +
		"RUN node -e \"fetch('https://" + host + "/from-a-build-step').then(r => r.text()).then(t => console.log(t.trim())).catch(e => { console.error(String(e.cause || e)); process.exit(1) })\"\n" +
		"ENTRYPOINT [\"sleep\", \"3600\"]\n"
	if err := os.WriteFile(filepath.Join(project, "Dockerfile"), []byte(dockerfile), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := s.Driver.Upload(ctx, ref, project, "workspace/repo", nil); err != nil {
		t.Fatal(err)
	}
	compose := []byte("services:\n  app:\n    build: {context: ., no_cache: true}\n    image: kodus-fc-vmbuilder:" + stamp + "\n")
	up1 := func(trust bool) (string, error) {
		var mu sync.Mutex
		var out strings.Builder
		start := time.Now()
		_, err := s.Driver.Up(ctx, driver.UpRequest{Ref: ref, Compose: compose, ProjectDir: project, CellTrust: trust, Output: func(line string) {
			mu.Lock()
			out.WriteString(line + "\n")
			mu.Unlock()
		}})
		t.Logf("up (cell trust %v): %d ms, err %v", trust, time.Since(start).Milliseconds(), err)
		mu.Lock()
		defer mu.Unlock()
		return out.String(), err
	}

	// The control: the VM dockerd's build, whose RUN keeps curl's own trust.
	out, err := up1(false)
	if err == nil {
		t.Fatalf("the control passed: a RUN with its image's trust store reached the injector's host, so this test proves nothing\n%s", out)
	}
	if !strings.Contains(err.Error()+out, "certificate") && !strings.Contains(err.Error()+out, "UNABLE_TO_GET_ISSUER_CERT") {
		t.Fatalf("the control failed for another reason than the certificate: %v\n%s", err, out)
	}
	mu.Lock()
	before := len(seen)
	mu.Unlock()
	if before != 0 {
		t.Fatalf("the host was reached by a build that does not trust the cell CA: %v", seen)
	}
	t.Logf("EVIDENCE control: the VM dockerd's build refused the injector's leaf: %s", firstLineWith(err.Error()+"\n"+out, "ertificate")+firstLineWith(err.Error()+"\n"+out, "UNABLE_TO_GET_ISSUER_CERT"))

	// The claim that trusts the cell CA: the VM builder's RUN reaches it.
	out, err = up1(true)
	if err != nil {
		t.Fatalf("the trusting claim's build failed: %v\n%s", err, out)
	}
	mu.Lock()
	got := append([]string(nil), seen...)
	mu.Unlock()
	if len(got) != 1 || got[0] != "/from-a-build-step" {
		t.Fatalf("the host saw %v, want the build step's one request", got)
	}
	if !strings.Contains(out, "kodus-vmbuilder-reached-"+stamp) {
		t.Fatalf("the build's output lacks the host's answer:\n%s", out)
	}
	t.Logf("EVIDENCE the trusting claim's RUN step reached %s through the injector: %s", host, firstLineWith(out, "kodus-vmbuilder-reached-"))
	if b := run(t, c, "docker buildx ls; pgrep -a buildkitd", 10_000); !strings.Contains(b.Stdout, "kodus") || !strings.Contains(b.Stdout, "buildkitd --config") {
		t.Fatalf("the build did not run on the VM's own builder: %q", b.Stdout)
	} else {
		t.Logf("EVIDENCE the VM's builder: %s", strings.Join(strings.Fields(firstLineWith(b.Stdout, "buildkitd --config")), " "))
	}
	if ps := run(t, c, "docker ps --format '{{.Image}} {{.Status}}'", 10_000); !strings.Contains(ps.Stdout, "kodus-fc-vmbuilder:"+stamp+" Up") {
		t.Fatalf("the project is not up from the VM builder's image: %q", ps.Stdout)
	}
}

func firstLineWith(s, sub string) string {
	for _, l := range strings.Split(s, "\n") {
		if strings.Contains(l, sub) {
			return strings.TrimSpace(l)
		}
	}
	return ""
}

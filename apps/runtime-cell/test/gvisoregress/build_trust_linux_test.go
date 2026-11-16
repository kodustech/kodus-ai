//go:build linux

package gvisoregress

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/drivertest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/dockergvisor"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/injector"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// The hosts of the trusted-build claims: Docker Hub and the PyPI and Alpine
// file hosts go straight (the build's passthrough, as the recommended list
// has them), the registries through the injector, the secret's host with
// its value swapped in.
var (
	trustPassthrough = []string{"registry-1.docker.io", "auth.docker.io", "production.cloudfront.docker.com", "files.pythonhosted.org", allowed}
	trustInspected   = []policy.InspectRule{
		{Host: "registry.npmjs.org", Paths: []string{"/"}, ExceptPaths: []string{"/-/"}},
		{Host: "pypi.org", Paths: []string{"/simple/", "/pypi/"}},
	}
)

const echoHost = "postman-echo.com"

// memSecrets is the org secret store with one synthetic value.
type memSecrets struct{ value string }

func (m memSecrets) Secret(context.Context, string, string) (injector.StoredSecret, error) {
	return injector.StoredSecret{Value: m.value, Hosts: []string{echoHost}}, nil
}

// syncBuffer is the injector's log, read while it writes.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// The cell's own builder (builder-image/, with exec-ca-bundle.patch) under
// runsc, its RUN steps trusting the cell CA (G1 option 3, G6):
//   - a repository's own Dockerfile, which declares none of the mirror's
//     build args, installs from npm and PyPI through the injector, which
//     inspects each request (GET and HEAD under the paths);
//   - a RUN npm publish (a PUT) is refused there;
//   - a tool that does not trust the bundle (a Dockerfile that points Node
//     elsewhere) fails closed: it refuses the injector's leaf, nothing goes
//     out uninspected;
//   - a BuildKit secret carries the claim's placeholder, which the injector
//     swaps for the value toward the secret's host only: the value is in no
//     layer, no build log line and no egress log;
//   - kodus_egress_inspect_bypassed_total stays 0, and the image keeps
//     neither the bundle's mount point nor the trust variables.
//
// Opt-in: KODY_E2E_GVISOR=1 and KODY_E2E_TRUSTED_BUILDER, a build of
// builder-image/ in this Docker (docker buildx bake runtime-builder --load,
// or the release's image by digest). The injector runs in this process on
// the default bridge's gateway; its CA is the cell CA of the trust bundle.
func TestATrustedBuildIsInspectedAndGetsItsSecretsAsPlaceholders(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	builder := os.Getenv("KODY_E2E_TRUSTED_BUILDER")
	if builder == "" {
		t.Skip("KODY_E2E_TRUSTED_BUILDER names a build of builder-image/")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	gateway := docker(t, "network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}")
	injectorAddr := net.JoinHostPort(gateway, "18443")
	e := startEgress(t, dir, "kodus-egress-trust", "-injector-addr", injectorAddr)
	egressIP := ipOn(t, e.name, "bridge")

	// The cell CA, as cmd/cell takes it: its certificate in the machines'
	// bundle with this host's public roots, its key with the injector only.
	cellCA, err := testpki.NewCA("e2e cell CA")
	if err != nil {
		t.Fatal(err)
	}
	roots, _, err := machinetrust.ReadRoots(machinetrust.SystemRootFiles)
	if err != nil {
		t.Fatal(err)
	}
	trust, err := machinetrust.Write(filepath.Join(dir, "trust"), roots, cellCA.PEM)
	if err != nil {
		t.Fatal(err)
	}

	value := "e2e-synthetic-" + randHex(t)
	store := policy.NewStore(nil)
	reg := metrics.NewRegistry()
	var injLog syncBuffer
	inj := &injector.Injector{
		Policies: store, CA: cellCA.Cert, CAKey: cellCA.Key, TrustedProxies: []string{egressIP},
		Secrets: memSecrets{value}, Log: slog.New(slog.NewJSONHandler(&injLog, nil)), Metrics: injector.NewMetrics(reg),
	}
	l, err := new(net.ListenConfig).Listen(ctx, "tcp4", injectorAddr)
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = inj.Serve(ctx, l) }()

	d, err := dockergvisor.New(ctx, dockercli.CLI{}, dockergvisor.Config{
		CellID: "cell-e2e", HolderImage: "alpine:3.20", WorkDir: filepath.Join(dir, "cell"), EgressContainer: e.name,
		BuilderImage: builder, BuilderTrustsCellCA: true, Trust: trust,
	})
	if err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name, dockerfile string
		boots            bool
		check            func(t *testing.T, image, out string)
	}{
		{
			name: "own dockerfile installs from npm and pypi through the injector",
			dockerfile: "FROM node:22-alpine\n" +
				"RUN npm view is-number@7.0.0 version > /npm-view.txt && mkdir /app && cd /app && npm install --no-audit --no-fund is-number@7.0.0\n" +
				"CMD [\"sleep\", \"300\"]\n",
			boots: true,
			check: func(t *testing.T, image, _ string) {
				if out := run(t, image, "cat", "/npm-view.txt", "/app/node_modules/is-number/package.json"); !strings.Contains(out, "7.0.0") {
					t.Fatalf("npm did not install: %s", out)
				}
			},
		},
		{
			name: "pip download through the injector",
			dockerfile: "FROM python:3.12-alpine\n" +
				"RUN pip download --no-deps --disable-pip-version-check -d /wheels six==1.16.0\n" +
				"CMD [\"sleep\", \"300\"]\n",
			boots: true,
			check: func(t *testing.T, image, _ string) {
				if out := run(t, image, "ls", "/wheels"); !strings.Contains(out, "six-1.16.0") {
					t.Fatalf("pip did not download: %s", out)
				}
			},
		},
		{
			name: "npm publish is refused",
			dockerfile: "FROM node:22-alpine\n" +
				"RUN mkdir /p && cd /p && npm init -y >/dev/null && sed -i 's/\"name\": \"p\"/\"name\": \"kodus-egress-probe-never-published\"/' package.json && " +
				"npm publish --//registry.npmjs.org/:_authToken=e2e-not-a-token\n",
			check: func(t *testing.T, _, out string) {
				// npm shows the status, not the body: the injector's log says who refused it.
				refused := regexp.MustCompile(`"msg":"injector\.inspect\.refused".*"host":"registry\.npmjs\.org","reason":"inspect_method"`)
				if !strings.Contains(out, "403 Forbidden - PUT https://registry.npmjs.org/") || !refused.MatchString(injLog.String()) {
					t.Fatalf("the publish did not meet the injector's refusal:\n%s\ninjector:\n%s", tail(out), tail(injLog.String()))
				}
			},
		},
		{
			name: "a tool that does not trust the bundle fails closed",
			dockerfile: "FROM node:22-alpine\n" +
				"ENV NODE_EXTRA_CA_CERTS=/nonexistent.pem\n" +
				"RUN npm view is-number@7.0.0 version\n",
			check: func(t *testing.T, _, out string) {
				if !regexp.MustCompile(`(?i)certificate|UNABLE_TO_GET_ISSUER|SELF_SIGNED`).MatchString(out) {
					t.Fatalf("not a TLS refusal:\n%s", tail(out))
				}
			},
		},
		{
			name: "a build secret carries the placeholder, swapped only toward its host",
			dockerfile: "FROM node:22-alpine\n" +
				"RUN --mount=type=secret,id=ECHO_TOKEN,env=ECHO_TOKEN node -e \"fetch('https://" + echoHost + "/headers',{headers:{authorization:'Bearer '+process.env.ECHO_TOKEN}}).then(r=>r.text()).then(t=>{require('fs').writeFileSync('/echo.json',t);console.log('echo',t)})\" && echo \"token=$ECHO_TOKEN\" && printf %s \"$ECHO_TOKEN\" > /token.txt\n" +
				"CMD [\"sleep\", \"300\"]\n",
			boots: true,
			check: func(t *testing.T, image, out string) {
				ph := strings.TrimSpace(run(t, image, "cat", "/token.txt"))
				if !policy.ValidPlaceholder(ph) {
					t.Fatalf("the build's secret is not a placeholder: %q", ph)
				}
				if echo := run(t, image, "cat", "/echo.json"); !strings.Contains(echo, injector.Masked) || strings.Contains(echo, ph) {
					t.Fatalf("the echo does not show the swapped, masked value: %s", echo)
				}
				fs := exportImage(t, image)
				if !bytes.Contains(fs, []byte(ph)) {
					t.Fatal("the exported image does not hold the placeholder: the search below proves nothing")
				}
				for what, b := range map[string][]byte{
					"image filesystem": fs, "image config": []byte(docker(t, "image", "inspect", image)),
					"build log": []byte(out), "egress log": []byte(docker(t, "logs", e.name)),
				} {
					if bytes.Contains(b, []byte(value)) {
						t.Errorf("the secret's value is in the %s", what)
					}
				}
				if !strings.Contains(out, "token="+ph) {
					t.Errorf("the build log does not show the placeholder the RUN printed")
				}
			},
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			claim := "claim-trust-" + randHex(t)[:8]
			n, err := d.PrepareClaim(ctx, driver.ClaimNetworkSpec{CellID: "cell-e2e", OrgID: "org-e2e", ClaimID: claim})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = d.ReleaseClaim(context.WithoutCancel(ctx), n) })
			if !n.SourcesTrustCellCA {
				t.Fatal("the cell's own builder with the trust files is not trusted")
			}
			spec := drivertest.BaseSpec("cell-e2e", claim, n)
			spec.OrgID, spec.ExpiresAt, spec.HardExpiresAt = "org-e2e", time.Now().Add(20*time.Minute), time.Now().Add(time.Hour)
			ref, err := d.Create(ctx, spec)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = d.Destroy(context.WithoutCancel(ctx), ref) })
			ph, err := policy.NewPlaceholder()
			if err != nil {
				t.Fatal(err)
			}
			pol, _, err := policy.Build(policy.Spec{
				ClaimID: claim, OrgID: "org-e2e", Phase: policy.PhaseBuild,
				Sources: append([]string{ref.PrivateAddress}, n.Sources...), SteerTo: n.EgressAddress,
				Base:    append(append([]string{}, trustPassthrough...), "registry.npmjs.org", "pypi.org"),
				Inspect: trustInspected, Secrets: []policy.Secret{{ID: "echo", Placeholder: ph, Hosts: []string{echoHost}}},
				BuildSources: n.Sources, BuildPassthrough: trustPassthrough, BuildTrusted: n.SourcesTrustCellCA,
				ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
			}, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := e.push.Push(ctx, pol); err != nil {
				t.Fatalf("push policy: %v", err)
			}
			if err := store.Put(pol); err != nil {
				t.Fatalf("injector policy: %v", err)
			}
			project := filepath.Join(t.TempDir(), "checkout")
			if err := os.MkdirAll(filepath.Join(project, "app"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(project, "app", "Dockerfile"), []byte(c.dockerfile), 0o644); err != nil {
				t.Fatal(err)
			}
			var out syncBuffer
			_, err = d.Up(ctx, driver.UpRequest{
				Ref: ref, Compose: []byte("services:\n  api:\n    build: ./app\n"), ProjectDir: project,
				BuildSecrets: map[string]string{"ECHO_TOKEN": ph}, Output: func(line string) { _, _ = out.Write([]byte(line + "\n")) },
			})
			log := out.String()
			if err != nil {
				log += "\n" + err.Error()
			}
			if c.boots && err != nil {
				t.Fatalf("up: %v\n%s\negress:\n%s\ninjector:\n%s", err, tail(log), tail(docker(t, "logs", e.name)), tail(injLog.String()))
			}
			if !c.boots && err == nil {
				t.Fatal("the build went through")
			}
			image := "kodus-build/" + ref.MachineID + "-api:claim"
			if c.boots {
				env := docker(t, "image", "inspect", "--format", "{{json .Config.Env}}", image)
				if strings.Contains(env, "SSL_CERT_FILE") || strings.Contains(env, "NODE_EXTRA_CA_CERTS") {
					t.Errorf("the trust variables reached the image config: %s", env)
				}
				if got := run(t, image, "sh", "-c", "test -e /run/buildkit && echo present || echo absent"); strings.TrimSpace(got) != "absent" {
					t.Errorf("the bundle's mount point is in the image: %s", got)
				}
			}
			c.check(t, image, log)
			t.Logf("injector counters:\n%s", injectorCounters(reg))
			for _, line := range strings.Split(docker(t, "logs", e.name), "\n") {
				if strings.Contains(line, claim) && (strings.Contains(line, "egress.allowed") || strings.Contains(line, "egress.blocked")) {
					t.Logf("egress: %s", line)
				}
			}
		})
	}
	if got := egressMetric(t, e, "kodus_egress_inspect_bypassed_total"); got != "0" {
		t.Errorf("kodus_egress_inspect_bypassed_total %s", got)
	}
	counters := injectorCounters(reg)
	for _, want := range []string{`outcome="allowed"`, `outcome="inspect_method"`, `cell_injector_swaps_total{outcome="swapped"}`} {
		if !strings.Contains(counters, want) {
			t.Errorf("injector counters miss %s:\n%s", want, counters)
		}
	}
	if strings.Contains(injLog.String(), value) {
		t.Error("the secret's value is in the injector's log")
	}
}

func randHex(t *testing.T) string {
	t.Helper()
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(b)
}

// run runs a command in a throwaway container of the image, no network.
func run(t *testing.T, image string, cmd ...string) string {
	t.Helper()
	return docker(t, append([]string{"run", "--rm", "--network", "none", "--entrypoint", ""}, append([]string{image}, cmd...)...)...)
}

// exportImage is the image's whole filesystem, as an uncompressed tar.
func exportImage(t *testing.T, image string) []byte {
	t.Helper()
	id := docker(t, "create", image)
	defer func() { _ = exec.Command("docker", "rm", "-f", id).Run() }()
	b, err := exec.Command("docker", "export", id).Output()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// egressMetric reads one counter from the egress's control port.
func egressMetric(t *testing.T, e egress, name string) string {
	t.Helper()
	resp, err := e.push.HTTP.Get(e.push.Endpoints[0].URL + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, name+" "); ok {
			return strings.TrimSpace(v)
		}
	}
	t.Fatalf("no %s in\n%s", name, b)
	return ""
}

func injectorCounters(reg *metrics.Registry) string {
	rec := httptest.NewRecorder()
	reg.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	var keep []string
	for _, line := range strings.Split(rec.Body.String(), "\n") {
		if strings.HasPrefix(line, "cell_injector_") {
			keep = append(keep, line)
		}
	}
	return strings.Join(keep, "\n")
}

func tail(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > 60 {
		lines = lines[len(lines)-60:]
	}
	return strings.Join(lines, "\n")
}

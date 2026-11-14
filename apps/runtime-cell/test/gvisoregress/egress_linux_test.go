//go:build linux

// Package gvisoregress proves docker-gvisor's way out on a real Docker with
// gVisor: a claim network with no route, the cell's egress (proxy and
// resolver) joined to it, a client under runsc. Opt-in: KODY_E2E_GVISOR=1 on
// a Linux host whose Docker has the runsc runtime and reaches the internet.
package gvisoregress

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy/control"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

const (
	network  = "kodus-claim-e2e"
	egressCt = "kodus-egress-e2e"
	clientCt = "kodus-client-e2e"
	allowed  = "dl-cdn.alpinelinux.org"
)

func docker(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// try runs a command in the client and reports whether it succeeded.
func try(args ...string) (string, bool) {
	out, err := exec.Command("docker", append([]string{"exec", clientCt}, args...)...).CombinedOutput()
	return string(out), err == nil
}

func ipOn(t *testing.T, container, net string) string {
	t.Helper()
	return docker(t, "inspect", "--format", `{{(index .NetworkSettings.Networks "`+net+`").IPAddress}}`, container)
}

func TestClaimReachesOnlyAllowedHostsThroughTheCellEgress(t *testing.T) {
	if os.Getenv("KODY_E2E_GVISOR") != "1" {
		t.Skip("KODY_E2E_GVISOR=1 runs it on a Linux Docker with runsc")
	}
	dir := t.TempDir()
	cleanup := func() {
		for _, c := range []string{clientCt, egressCt} {
			_ = exec.Command("docker", "rm", "-f", c).Run()
		}
		_ = exec.Command("docker", "network", "rm", network).Run()
	}
	cleanup()
	t.Cleanup(cleanup)

	// The egress binary, static, as the cell image ships it: built here, or
	// given prebuilt (KODY_E2E_EGRESS_BIN) on a host without Go.
	if bin := os.Getenv("KODY_E2E_EGRESS_BIN"); bin != "" {
		b, err := os.ReadFile(bin)
		if err != nil || os.WriteFile(filepath.Join(dir, "egress"), b, 0o755) != nil {
			t.Fatalf("egress binary %s: %v", bin, err)
		}
	} else {
		build := exec.Command("go", "build", "-o", filepath.Join(dir, "egress"), "../../cmd/egress")
		build.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build egress: %v\n%s", err, out)
		}
	}
	// Control mTLS and the agent's policy key.
	ca, err := testpki.NewCA("e2e-ca")
	if err != nil {
		t.Fatal(err)
	}
	server, _ := ca.Issue("kodus-egress", time.Hour, "kodus-egress")
	if err := ca.WriteFiles(dir, "", server); err != nil {
		t.Fatal(err)
	}
	agent, _ := ca.Issue("cell-e2e", time.Hour)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	if err := os.WriteFile(filepath.Join(dir, "agent.pub.pem"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"cert.pem", "key.pem", "ca.pem"} {
		_ = os.Chmod(filepath.Join(dir, f), 0o644) // read by the container's user
	}

	// The cell's egress on the default bridge (its way out), proxy and
	// resolver in one process, not transparent: the network steers by DNS.
	docker(t, "run", "-d", "--name", egressCt, "-v", dir+":/e:ro", "alpine:3.20", "/e/egress",
		"-listen-tls", ":443", "-listen-http", ":80", "-dns-listen", ":53", "-control", ":9443",
		"-cert", "/e/cert.pem", "-key", "/e/key.pem", "-ca", "/e/ca.pem", "-agent-pub", "/e/agent.pub.pem",
		"-upstream-dns", "1.1.1.1:53", "-transparent=false")
	// The claim network: no route out. The egress joins it, as PrepareClaim does.
	docker(t, "network", "create", "--internal", network)
	docker(t, "network", "connect", network, egressCt)
	steer := ipOn(t, egressCt, network)
	control := ipOn(t, egressCt, "bridge")

	// The claim's machine, under gVisor, resolving through the cell only.
	// Docker's embedded resolver forwards nothing on an internal network, so
	// the machine's resolv.conf names the cell resolver alone.
	resolv := filepath.Join(dir, "resolv.conf")
	if err := os.WriteFile(resolv, []byte("nameserver "+steer+"\noptions ndots:0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	docker(t, "run", "-d", "--name", clientCt, "--runtime", "runsc", "--network", network, "-v", resolv+":/etc/resolv.conf:ro", "alpine:3.20", "sleep", "300")
	source := ipOn(t, clientCt, network)

	push := control2(t, ca, agent, priv, control)
	if err := push.Push(context.Background(), policy.ClaimPolicy{
		ClaimID: "claim-e2e", OrgID: "org-e2e", Phase: policy.PhaseTest, Sources: []string{source},
		Allow: []string{allowed, "pastebin.com"}, SteerTo: steer,
		ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now(),
	}); err != nil {
		t.Fatalf("push policy: %v (egress logs: %s)", err, docker(t, "logs", egressCt))
	}

	if out, ok := try("wget", "-q", "-T", "15", "-O", "-", "https://"+allowed+"/alpine/"); !ok || !strings.Contains(out, "v3.") {
		conf, _ := try("cat", "/etc/resolv.conf")
		direct, _ := try("nslookup", allowed, steer)
		t.Fatalf("allowed host not reached through the egress: %s\nresolv.conf: %s\nasked of the cell resolver: %s\negress: %s", out, conf, direct, docker(t, "logs", egressCt))
	}
	cases := map[string][]string{
		// On the allowlist, and on the Kodus deny list: the deny list wins.
		"denied host":      {"wget", "-q", "-T", "8", "-O", "-", "https://pastebin.com/"},
		"host not allowed": {"wget", "-q", "-T", "8", "-O", "-", "https://example.com/"},
		// No resolver needed: the network itself has no route.
		"direct address": {"wget", "-q", "-T", "8", "-O", "-", "http://1.1.1.1/"},
		// Docker's own resolver is not reachable either.
		"other resolver": {"nslookup", "example.com", "8.8.8.8"},
	}
	for name, cmd := range cases {
		if out, ok := try(cmd...); ok {
			t.Errorf("%s went through: %s", name, out)
		}
	}
}

// control2 is the agent's pusher to the egress control port over mTLS.
func control2(t *testing.T, ca *testpki.CA, agent tls.Certificate, key ed25519.PrivateKey, addr string) control.Pusher {
	t.Helper()
	tr := &http.Transport{TLSClientConfig: &tls.Config{Certificates: []tls.Certificate{agent}, RootCAs: ca.Pool(), ServerName: "kodus-egress", MinVersion: tls.VersionTLS13}}
	return control.Pusher{Endpoints: []control.Endpoint{{Name: control.EndpointEgress, URL: "https://" + addr + ":9443"}}, HTTP: &http.Client{Transport: tr, Timeout: 10 * time.Second}, Key: key}
}

// egress is a running cell egress: its container and the agent's pusher.
type egress struct {
	name string
	push control.Pusher
}

// startEgress runs the cell's egress (proxy and resolver, not transparent)
// on the default bridge, with control mTLS and a policy key of its own.
func startEgress(t *testing.T, dir, name string) egress {
	t.Helper()
	_ = exec.Command("docker", "rm", "-f", name).Run()
	t.Cleanup(func() { _ = exec.Command("docker", "rm", "-f", name).Run() })
	if bin := os.Getenv("KODY_E2E_EGRESS_BIN"); bin != "" {
		b, err := os.ReadFile(bin)
		if err != nil || os.WriteFile(filepath.Join(dir, "egress"), b, 0o755) != nil {
			t.Fatalf("egress binary %s: %v", bin, err)
		}
	} else {
		build := exec.Command("go", "build", "-o", filepath.Join(dir, "egress"), "../../cmd/egress")
		build.Env = append(os.Environ(), "CGO_ENABLED=0")
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build egress: %v\n%s", err, out)
		}
	}
	ca, err := testpki.NewCA("e2e-ca")
	if err != nil {
		t.Fatal(err)
	}
	server, _ := ca.Issue("kodus-egress", time.Hour, "kodus-egress")
	if err := ca.WriteFiles(dir, "", server); err != nil {
		t.Fatal(err)
	}
	agent, _ := ca.Issue("cell-e2e", time.Hour)
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(pub)
	if err := os.WriteFile(filepath.Join(dir, "agent.pub.pem"), pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"cert.pem", "key.pem", "ca.pem"} {
		_ = os.Chmod(filepath.Join(dir, f), 0o644)
	}
	docker(t, "run", "-d", "--name", name, "-v", dir+":/e:ro", "alpine:3.20", "/e/egress",
		"-listen-tls", ":443", "-listen-http", ":80", "-dns-listen", ":53", "-control", ":9443",
		"-cert", "/e/cert.pem", "-key", "/e/key.pem", "-ca", "/e/ca.pem", "-agent-pub", "/e/agent.pub.pem",
		"-upstream-dns", "1.1.1.1:53", "-transparent=false")
	return egress{name: name, push: control2(t, ca, agent, priv, ipOn(t, name, "bridge"))}
}

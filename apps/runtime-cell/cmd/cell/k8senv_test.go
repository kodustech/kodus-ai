package main

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preflight"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

var testDigest = "@sha256:" + strings.Repeat("ab", 32)

// k8sEnvArgs are k8sArgs with environment Runs on, as the chart passes them.
func k8sEnvArgs(extra ...string) []string {
	return k8sArgs(append([]string{
		"-k8s-env-namespace", "kodus-runtime-environments",
		"-k8s-env-egress-namespace", "kodus-runtime", "-k8s-env-egress-pod-labels", "app.kubernetes.io/name=kodus-runtime-cell",
		"-k8s-env-observer-image", "registry.example/kodus/cell" + testDigest,
		"-observer", "http", "-observer-server-name", "kodus-observer",
	}, extra...)...)
}

func gateErr(t *testing.T, args ...string) error {
	t.Helper()
	st, err := parse(t, args...)
	if err != nil {
		t.Fatal(err)
	}
	return checkK8sGate(st)
}

func TestAK8sCellWithoutTheEnvironmentNamespaceRunsSandboxesOnlyAndRefusesAnEnvFlag(t *testing.T) {
	if err := gateErr(t, k8sArgs()...); err != nil {
		t.Fatal(err)
	}
	err := gateErr(t, k8sArgs("-k8s-env-observer-image", "c"+testDigest)...)
	if err == nil || !strings.Contains(err.Error(), "-k8s-env-observer-image is set without -k8s-env-namespace") {
		t.Fatalf("err = %v", err)
	}
}

func TestAK8sCellWithTheEnvironmentNamespacePassesItsGateWithItsCompanions(t *testing.T) {
	if err := gateErr(t, k8sEnvArgs()...); err != nil {
		t.Fatal(err)
	}
	if err := gateErr(t, k8sEnvArgs("-k8s-env-builder-image", "b"+testDigest, "-k8s-env-build-registry", "registry.kodus-runtime.svc:5000",
		"-k8s-env-build-registry-insecure", "-k8s-env-build-mirror", "mirror.kodus-runtime.svc:5000")...); err != nil {
		t.Fatal(err)
	}
}

func TestAK8sEnvironmentCellIsRefusedNamingTheFlagItLacks(t *testing.T) {
	without := func(drop string) []string {
		var out []string
		args := k8sEnvArgs()
		for i := 0; i < len(args); i++ {
			if args[i] == drop {
				i++
				continue
			}
			out = append(out, args[i])
		}
		return out
	}
	for want, args := range map[string][]string{
		"is not a namespace name":                    k8sEnvArgs("-k8s-env-namespace", "Bad_NS"),
		"must not be -k8s-namespace":                 k8sEnvArgs("-k8s-env-namespace", "kodus-runtime-sandboxes"),
		"-k8s-env-egress-pod-labels":                 without("-k8s-env-egress-pod-labels"),
		"needs -k8s-env-observer-image":              without("-k8s-env-observer-image"),
		"-k8s-env-observer-image \"cell:latest\"":    k8sEnvArgs("-k8s-env-observer-image", "cell:latest"),
		"needs -observer http":                       without("-observer"),
		"needs -observer-server-name":                without("-observer-server-name"),
		"go together":                                k8sEnvArgs("-k8s-env-builder-image", "b"+testDigest),
		"need -k8s-env-build-registry":               k8sEnvArgs("-k8s-env-build-mirror", "mirror:5000"),
		"-k8s-env-build-registry \"http://r\"":       k8sEnvArgs("-k8s-env-builder-image", "b"+testDigest, "-k8s-env-build-registry", "http://r"),
		"-k8s-env-egress-pod-labels: \"app\"":        k8sEnvArgs("-k8s-env-egress-pod-labels", "app"),
		"-k8s-env-egress-ports: \"53/SCTP\"":         k8sEnvArgs("-k8s-env-egress-ports", "53/SCTP"),
		"-k8s-env-observer-millicpu are never negat": k8sEnvArgs("-k8s-env-observer-memory-mb", "-1"),
	} {
		t.Run(want, func(t *testing.T) {
			if err := gateErr(t, args...); err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("err = %v, want %q", err, want)
			}
		})
	}
}

func TestTheEnvironmentFlagsBecomeTheDriversEnvConfigWithTheBuildersAddressesResolved(t *testing.T) {
	st, err := parse(t, k8sEnvArgs("-k8s-env-builder-image", "b"+testDigest, "-k8s-env-build-registry", "registry.kodus-runtime.svc:5000",
		"-k8s-env-build-registry-pull", "localhost:5001", "-k8s-env-build-registry-insecure", "-k8s-env-build-mirror", "10.96.0.60:5000",
		"-k8s-env-observer-memory-mb", "512", "-k8s-env-volume-size", "2Gi")...)
	if err != nil {
		t.Fatal(err)
	}
	lookup := func(_ context.Context, name string) ([]string, error) {
		if name != "registry.kodus-runtime.svc" {
			t.Fatalf("looked up %s", name)
		}
		return []string{"fd00::1", "10.96.0.50"}, nil
	}
	c, err := envConfig(context.Background(), st, nil, lookup)
	if err != nil {
		t.Fatal(err)
	}
	if c.Namespace != "kodus-runtime-environments" || c.VolumeSize != "2Gi" || c.ObserverImage != "registry.example/kodus/cell"+testDigest ||
		c.ObserverTLSDir != "/etc/kodus/cell/observer-server" || c.ObserverMemoryMB != 512 || c.BuildRegistryPull != "localhost:5001" || !c.BuildRegistryInsecure {
		t.Fatalf("%+v", c)
	}
	wantEgress := []kube.EgressPeer{{
		NamespaceLabels: map[string]string{"kubernetes.io/metadata.name": "kodus-runtime"},
		PodLabels:       map[string]string{"app.kubernetes.io/name": "kodus-runtime-cell"},
		Ports:           []kube.Port{{Protocol: "UDP", Port: 53}, {Protocol: "TCP", Port: 53}, {Protocol: "TCP", Port: 80}, {Protocol: "TCP", Port: 443}},
	}}
	if !reflect.DeepEqual(c.Egress, wantEgress) {
		t.Errorf("egress %+v", c.Egress)
	}
	if !reflect.DeepEqual(c.BuildHosts, map[string]string{"registry.kodus-runtime.svc": "10.96.0.50"}) {
		t.Errorf("hosts %v", c.BuildHosts)
	}
	wantBuild := []kube.EgressPeer{
		{CIDR: "10.96.0.50/32", Ports: []kube.Port{{Protocol: "TCP", Port: 5000}}},
		{CIDR: "10.96.0.60/32", Ports: []kube.Port{{Protocol: "TCP", Port: 5000}}},
	}
	if !reflect.DeepEqual(c.BuildEgress, wantBuild) {
		t.Errorf("build egress %+v", c.BuildEgress)
	}
}

// observerServerDir is an observer TLS directory whose certificate names name.
func observerServerDir(t *testing.T, name string) string {
	t.Helper()
	dir := t.TempDir()
	ca, err := testpki.NewCA("observer")
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := ca.Issue(name, time.Hour, name)
	if err != nil {
		t.Fatal(err)
	}
	if err := ca.WriteFiles(dir, "", leaf); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestPreflightOfAK8sCellFailsAnImageThatIsNotByDigest(t *testing.T) {
	dir := cellFiles(t)
	p := testProbes(t)
	p.docker = nil
	base := []string{"-cert", filepath.Join(dir, "cert.pem"), "-key", filepath.Join(dir, "key.pem"), "-ca", filepath.Join(dir, "ca.pem")}
	_, got := runPreflightJSON(t, p, k8sArgs(base...)...)
	if r, _ := check(got, nameK8sImages); r.Status != preflight.Fail || !strings.Contains(r.Reason, "-k8s-holder-image h@sha256:a") {
		t.Fatalf("%+v", r)
	}
	digests := []string{"-k8s-holder-image", "h" + testDigest, "-k8s-sandbox-image", "s" + testDigest, "-k8s-probe-image", "c" + testDigest}
	_, got = runPreflightJSON(t, p, k8sArgs(append(base, digests...)...)...)
	if r, _ := check(got, nameK8sImages); r.Status != preflight.OK {
		t.Fatalf("%+v", r)
	}
	if _, shown := check(got, nameK8sObserverTLS); shown {
		t.Fatal("a cell without environment Runs has no observer TLS to check")
	}
}

func TestPreflightOfAK8sEnvironmentCellChecksTheObserverTLSAgainstTheServerName(t *testing.T) {
	dir := cellFiles(t)
	p := testProbes(t)
	p.docker = nil
	base := []string{"-cert", filepath.Join(dir, "cert.pem"), "-key", filepath.Join(dir, "key.pem"), "-ca", filepath.Join(dir, "ca.pem"),
		"-observer-cert", filepath.Join(dir, "obs-cert.pem"), "-observer-key", filepath.Join(dir, "obs-key.pem"), "-observer-ca", filepath.Join(dir, "obs-ca.pem")}
	for name, c := range map[string]struct {
		dir  string
		want preflight.Status
		msg  string
	}{
		"a certificate for the server name passes": {dir: observerServerDir(t, "kodus-observer"), want: preflight.OK},
		"a certificate for another name fails":     {dir: observerServerDir(t, "other"), want: preflight.Fail, msg: "-observer-server-name"},
		"a missing directory fails":                {dir: filepath.Join(t.TempDir(), "none"), want: preflight.Fail, msg: "cert.pem"},
	} {
		t.Run(name, func(t *testing.T) {
			_, got := runPreflightJSON(t, p, k8sEnvArgs(append(base, "-k8s-env-observer-tls-dir", c.dir)...)...)
			r, _ := check(got, nameK8sObserverTLS)
			if r.Status != c.want || !strings.Contains(r.Reason, c.msg) {
				t.Fatalf("%+v", r)
			}
		})
	}
}

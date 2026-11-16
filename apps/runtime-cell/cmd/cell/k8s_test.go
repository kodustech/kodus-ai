package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/testpki"
)

// -driver auto runs k8s-sandbox in a pod with a service account and
// docker-gvisor on a host; a named driver is kept as named.
func TestDriverAutoPicksKubernetesInAPod(t *testing.T) {
	args := k8sArgs()
	args[1] = "auto"
	if d, err := startOn(t, true, "", args...); err != nil || d != "k8s-sandbox" {
		t.Fatalf("in a pod: %s %v", d, err)
	}
	if d, err := startOn(t, false, "gvisor", "-driver", "auto", "-gvisor-holder-image", "h@sha256:x", "-observer", "http", "-gvisor-observer-image", "o@sha256:y"); err != nil || d != "docker-gvisor" {
		t.Fatalf("on a host: %s %v", d, err)
	}
	if d, err := startOn(t, true, "", "-driver", "aws-ec2", "-observer", "http"); err != nil || d != "aws-ec2" {
		t.Fatalf("named: %s %v", d, err)
	}
}

func k8sArgs(extra ...string) []string {
	return append([]string{
		"-driver", "k8s-sandbox", "-k8s-namespace", "kodus-runtime-sandboxes",
		"-k8s-holder-image", "h@sha256:a", "-k8s-sandbox-image", "s@sha256:b", "-k8s-probe-image", "c@sha256:c",
		"-k8s-egress-service", "kodus-runtime-cell-egress.kodus-runtime-cell.svc",
		"-egress-control", "egress=https://127.0.0.1:9443,resolver=https://127.0.0.1:9443,injector=https://127.0.0.1:9445",
	}, extra...)
}

// cmd/cell could not select k8s-sandbox: the driver switch had no case for
// it and the cell exited "unknown driver". It now parses and passes its
// gate with the chart's flags.
func TestK8sSandboxIsSelectable(t *testing.T) {
	st, err := parse(t, k8sArgs()...)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := startOn(t, false, "", k8sArgs()...); err != nil {
		t.Fatal(err)
	}
	if st.K8s.RuntimeClass != "gvisor" || st.K8s.KernelMustContain != "gvisor" {
		t.Fatalf("defaults %+v", st.K8s)
	}
}

// The gate names each thing a k8s-sandbox cell cannot run without: its
// namespace, its images, its egress Service and its enforcers.
func TestK8sSandboxGateNamesWhatIsMissing(t *testing.T) {
	for drop, want := range map[string]string{
		"-k8s-namespace": "-k8s-namespace", "-k8s-sandbox-image": "-k8s-sandbox-image",
		"-k8s-egress-service": "-k8s-egress-service", "-egress-control": "-egress-control",
	} {
		args := k8sArgs()
		for i := 0; i < len(args); i += 2 {
			if args[i] == drop {
				args = append(args[:i:i], args[i+2:]...)
				break
			}
		}
		if _, err := startOn(t, false, "", args...); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("without %s: %v", drop, err)
		}
	}
}

// The egress Service's address is waited for while cluster DNS catches up,
// and an IP literal is taken as it is.
func TestResolveEgressWaitsForTheService(t *testing.T) {
	calls := 0
	lookup := func(context.Context, string) ([]string, error) {
		calls++
		if calls < 2 {
			return nil, errors.New("no such host")
		}
		return []string{"fd00::1", "10.96.12.7"}, nil
	}
	ip, err := resolveEgress(context.Background(), "egress.svc", lookup)
	if err != nil || ip != "10.96.12.7" || calls != 2 {
		t.Fatalf("%s %v after %d lookups", ip, err, calls)
	}
	if ip, _ := resolveEgress(context.Background(), "10.96.0.9", nil); ip != "10.96.0.9" {
		t.Fatalf("literal %s", ip)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, err := resolveEgress(ctx, "never.svc", func(context.Context, string) ([]string, error) { return nil, errors.New("nx") }); err == nil {
		t.Fatal("a name that never resolves")
	}
}

// `cell local-pki` reads what `cell register` wrote and writes the
// enforcers' files; without an identity it fails and says so.
func TestLocalPKICommand(t *testing.T) {
	hub, _ := testpki.NewCA("hub")
	leaf, _ := hub.Issue("cell-3", time.Hour)
	id := t.TempDir()
	if err := hub.WriteFiles(id, "", leaf); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(id, "issuer.pem"), hub.PEM, 0o600)
	dir := t.TempDir()
	var out, errOut bytes.Buffer
	if code := runLocalPKI([]string{"-dir", dir, "-identity", id}, &out, &errOut); code != 0 {
		t.Fatalf("code %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "cell cell-3") {
		t.Fatalf("out %s", out.String())
	}
	if _, err := os.Stat(filepath.Join(dir, "egress", "agent.pub.pem")); err != nil {
		t.Fatal(err)
	}
	if code := runLocalPKI([]string{"-dir", dir, "-identity", t.TempDir()}, &out, &errOut); code != 1 {
		t.Fatal("no identity accepted")
	}
}

// `cell issue-cert` refuses a call without its inputs, before it reads a file.
func TestIssueCertNeedsItsInputs(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := runIssueCert([]string{"-cn", "runtime-worker"}, &out, &errOut); code != 2 || !strings.Contains(errOut.String(), "required") {
		t.Fatalf("code %d: %s", code, errOut.String())
	}
}

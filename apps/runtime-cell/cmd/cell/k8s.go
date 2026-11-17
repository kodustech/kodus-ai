package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"runtime"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/k8ssandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// k8sSettings are the k8s-sandbox driver's (docs/runtime/kubernetes.md):
// the sandbox namespace the chart made, its RuntimeClass, the images, the
// egress Service claim pods resolve and dial through, and the preflight.
type k8sSettings struct {
	Namespace     string
	RuntimeClass  string
	HolderImage   string
	SandboxImage  string
	ProbeImage    string
	EgressService string
	// KernelMustContain is what the preflight probe's kernel must name.
	KernelMustContain string
	MaxMemoryMB       int
	MaxCPUs           int
	// Env turns on environment Runs (k8senv.go).
	Env k8sEnvSettings
}

func (s *k8sSettings) register(fs *flag.FlagSet) {
	fs.StringVar(&s.Namespace, "k8s-namespace", "", "k8s-sandbox: the sandbox namespace (Pod Security restricted, the chart's policies); every claim pod lives there and the cell's Role reaches nothing else")
	fs.StringVar(&s.RuntimeClass, "k8s-runtime-class", "gvisor", "k8s-sandbox: the RuntimeClass every claim pod runs on (gvisor; GKE Sandbox's is gvisor, kata-deploy's kata-*)")
	fs.StringVar(&s.HolderImage, "k8s-holder-image", "", "k8s-sandbox: the image of a machine pod that is not a sandbox, by digest")
	fs.StringVar(&s.SandboxImage, "k8s-sandbox-image", "", "k8s-sandbox: the code sandbox's tool image with the guest agent at /usr/local/bin/kody-guest, by digest")
	fs.StringVar(&s.ProbeImage, "k8s-probe-image", "", "k8s-sandbox: the image of the preflight probe pod, the cell's own (it runs `cell probe`), by digest")
	fs.StringVar(&s.EgressService, "k8s-egress-service", "", "k8s-sandbox: the DNS name of the Service in front of this cell's proxy and resolver (53, 80, 443): claim pods' only DNS server and way out")
	fs.StringVar(&s.KernelMustContain, "k8s-kernel-must-contain", "gvisor", "k8s-sandbox: what the preflight probe's kernel release must name under the RuntimeClass (gVisor's names gvisor); empty for Kata or another runtime")
	fs.IntVar(&s.MaxMemoryMB, "k8s-max-memory-mb", 8192, "k8s-sandbox: the most memory (MB) one claim may ask; keep it at or under the sandbox namespace's LimitRange")
	s.Env.register(fs)
	fs.IntVar(&s.MaxCPUs, "k8s-max-cpus", 4, "k8s-sandbox: the most CPUs one claim may ask; keep it at or under the sandbox namespace's LimitRange")
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// checkK8sGate refuses a k8s-sandbox cell that would run without its
// isolation: no namespace, images or enforcers.
func checkK8sGate(st settings) error {
	k := st.K8s
	switch {
	case k.Namespace == "":
		return errors.New("k8s-sandbox needs -k8s-namespace, the sandbox namespace the chart made")
	case k.RuntimeClass == "":
		return errors.New("k8s-sandbox needs -k8s-runtime-class")
	case k.HolderImage == "" || k.SandboxImage == "" || k.ProbeImage == "":
		return errors.New("k8s-sandbox needs -k8s-holder-image, -k8s-sandbox-image and -k8s-probe-image, by digest")
	case k.EgressService == "":
		return errors.New("k8s-sandbox needs -k8s-egress-service: without the proxy and resolver a claim pod has no way out and no policy")
	case st.EgressEPs == "" && !st.Dev:
		return errors.New("k8s-sandbox needs -egress-control: the egress, resolver and injector enforce every claim's policy")
	}
	return checkK8sEnv(st)
}

// resolveEgress is the egress Service's address, waited for while the
// cluster's DNS has not caught up with a new Service.
func resolveEgress(ctx context.Context, name string, lookup func(context.Context, string) ([]string, error)) (string, error) {
	if ip := net.ParseIP(name); ip != nil {
		return ip.String(), nil
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	last := errors.New("no IPv4 address yet")
	for {
		addrs, err := lookup(ctx, name)
		for _, a := range addrs {
			if ip := net.ParseIP(a); ip != nil && ip.To4() != nil {
				return ip.String(), nil
			}
		}
		if err != nil {
			last = err
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("k8s-sandbox: the egress Service %s has no IPv4 address: %w", name, last)
		case <-time.After(2 * time.Second):
		}
	}
}

func hostArch() string {
	if runtime.GOARCH == "amd64" {
		return "x86_64"
	}
	return runtime.GOARCH
}

// openK8s builds the k8s-sandbox driver with the pod's service account,
// after the preflight proved the sandbox namespace enforces what it needs.
func openK8s(ctx context.Context, st settings, cellID string) (*k8ssandbox.Driver, k8ssandbox.PreflightReport, error) {
	k, err := k8ssandbox.InClusterClient()
	if err != nil {
		return nil, k8ssandbox.PreflightReport{}, err
	}
	egressIP, err := resolveEgress(ctx, st.K8s.EgressService, net.DefaultResolver.LookupHost)
	if err != nil {
		return nil, k8ssandbox.PreflightReport{}, err
	}
	rep, err := k8ssandbox.Preflight{
		Kube: k, CellID: cellID, Namespace: st.K8s.Namespace, RuntimeClass: st.K8s.RuntimeClass, ProbeImage: st.K8s.ProbeImage,
		DialTarget:        net.JoinHostPort(os.Getenv("KUBERNETES_SERVICE_HOST"), os.Getenv("KUBERNETES_SERVICE_PORT")),
		KernelMustContain: st.K8s.KernelMustContain, ResolverIP: egressIP, EnvNamespace: st.K8s.Env.Namespace,
	}.Run(ctx)
	if err != nil {
		return nil, rep, err
	}
	// -cell-ca-cert: a sandbox of a claim with org secrets trusts the injector (the driver checks it is one CA certificate).
	var cellCA []byte
	if st.Trust.CellCA != "" {
		if cellCA, err = os.ReadFile(st.Trust.CellCA); err != nil {
			return nil, rep, fmt.Errorf("-cell-ca-cert: %w", err)
		}
	}
	var env *k8ssandbox.EnvConfig
	if st.K8s.Env.on() {
		if err := k8sEnvFiles(st.K8s.Env.ObserverTLSDir, st.ObsServerName); err != nil {
			return nil, rep, fmt.Errorf("-k8s-env-observer-tls-dir: %w", err)
		}
		if env, err = envConfig(ctx, st, k, net.DefaultResolver.LookupHost); err != nil {
			return nil, rep, err
		}
	}
	d, err := k8ssandbox.New(k, k, k8ssandbox.Config{
		CellID: cellID, Namespace: st.K8s.Namespace, RuntimeClass: st.K8s.RuntimeClass,
		HolderImage: st.K8s.HolderImage, SandboxImage: st.K8s.SandboxImage, EgressAddress: egressIP, Arch: hostArch(),
		MaxClaimSize:     driver.ClaimSize{MemoryMB: st.K8s.MaxMemoryMB, CPUs: st.K8s.MaxCPUs},
		DefaultClaimSize: driver.ClaimSize{MemoryMB: st.Sandbox.MemoryMB, CPUs: st.Sandbox.CPUs},
		CellCA:           cellCA,
		Env:              env,
	})
	return d, rep, err
}

// errNoObservers: a k8s-sandbox cell without -k8s-env-namespace runs no
// Run, so no observer.
var errNoObservers = errors.New("observer: this k8s-sandbox cell runs no environment Run (no -k8s-env-namespace), so no observer")

func noObservers(context.Context, agent.ClaimInfo, []observer.Target) (observer.Client, error) {
	return nil, errNoObservers
}

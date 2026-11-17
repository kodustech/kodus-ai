package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/compose/kube"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/drivers/k8ssandbox"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observerclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/preview"
)

// k8sEnvSettings turn on environment Runs on a k8s-sandbox cell
// (docs/runtime/kubernetes-environment-runs.md): off unless -k8s-env-namespace
// is set, the chart's environment namespace
// (deploy/kubernetes/environment-namespace.yaml).
type k8sEnvSettings struct {
	Namespace string
	// EgressNamespace and EgressPodLabels select the cell's proxy and
	// resolver pods, EgressPorts their ports (the pods', not the Service's):
	// a claim's pods may connect there and to each other only.
	EgressNamespace string
	EgressPodLabels string
	EgressPorts     string
	VolumeSize      string
	StorageClass    string
	// Builds: BuilderImage and BuildRegistry both, or neither.
	BuilderImage          string
	BuildRegistry         string
	BuildRegistryPull     string
	BuildRegistryInsecure bool
	BuildMirror           string
	BuildStorage          string
	// The claim's observer pod.
	ObserverImage    string
	ObserverTLSDir   string
	ObserverMemoryMB int
	ObserverMilliCPU int
}

func (s *k8sEnvSettings) register(fs *flag.FlagSet) {
	fs.StringVar(&s.Namespace, "k8s-env-namespace", "", "k8s-sandbox: the cell's environment namespace (Pod Security privileged, the environment gate, default deny; deploy/kubernetes/environment-namespace.yaml); set, the cell runs environment Runs there; empty, code sandboxes only")
	fs.StringVar(&s.EgressNamespace, "k8s-env-egress-namespace", "", "k8s-sandbox environments: the namespace of the cell's proxy and resolver pods (the cell namespace)")
	fs.StringVar(&s.EgressPodLabels, "k8s-env-egress-pod-labels", "", "k8s-sandbox environments: key=value[,key=value] selecting the cell's proxy and resolver pods there")
	fs.StringVar(&s.EgressPorts, "k8s-env-egress-ports", "53/UDP,53/TCP,80/TCP,443/TCP", "k8s-sandbox environments: the proxy's and resolver's ports on their pods (the egress Service's target ports), port/PROTOCOL[,...]")
	fs.StringVar(&s.VolumeSize, "k8s-env-volume-size", "", "k8s-sandbox environments: each named volume's claim size (1Gi when empty)")
	fs.StringVar(&s.StorageClass, "k8s-env-storage-class", "", "k8s-sandbox environments: the volume claims' StorageClass (the cluster's default when empty)")
	fs.StringVar(&s.BuilderImage, "k8s-env-builder-image", "", "k8s-sandbox environments: rootless BuildKit, by digest; with -k8s-env-build-registry, a build section runs in a builder pod (without both it is refused)")
	fs.StringVar(&s.BuildRegistry, "k8s-env-build-registry", "", "k8s-sandbox environments: host[:port] of the registry the builder pushes to; a name is resolved at start and is the builder's only way out besides the mirror")
	fs.StringVar(&s.BuildRegistryPull, "k8s-env-build-registry-pull", "", "k8s-sandbox environments: host[:port] the nodes pull built images from (-k8s-env-build-registry when empty)")
	fs.BoolVar(&s.BuildRegistryInsecure, "k8s-env-build-registry-insecure", false, "k8s-sandbox environments: push to the build registry over plain HTTP (an in-cluster registry)")
	fs.StringVar(&s.BuildMirror, "k8s-env-build-mirror", "", "k8s-sandbox environments: host:port of a docker.io pull-through mirror (plain HTTP) BuildKit pulls base images through; empty, none")
	fs.StringVar(&s.BuildStorage, "k8s-env-build-storage", "", "k8s-sandbox environments: the bound on BuildKit's state on the node (10Gi when empty)")
	fs.StringVar(&s.ObserverImage, "k8s-env-observer-image", "", "k8s-sandbox environments: the image of each claim's observer pod (the cell image, cmd/observer at "+kube.ObserverBinary+"), by digest; required with -k8s-env-namespace")
	fs.StringVar(&s.ObserverTLSDir, "k8s-env-observer-tls-dir", "/etc/kodus/cell/observer-server", "k8s-sandbox environments: cert.pem and key.pem of the observers (for -observer-server-name) and ca.pem, the CA of -observer-cert; laid into each observer pod")
	fs.IntVar(&s.ObserverMemoryMB, "k8s-env-observer-memory-mb", 0, "k8s-sandbox environments: the observer pod's share of the claim's memory (256 when 0)")
	fs.IntVar(&s.ObserverMilliCPU, "k8s-env-observer-millicpu", 0, "k8s-sandbox environments: the observer pod's share of the claim's CPU, in mCPU (250 when 0)")
}

var (
	dnsLabel = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	// imageRef is a reference by digest: repository@sha256:<64 hex>.
	imageRef = regexp.MustCompile(`^[a-z0-9]+([._/:-][a-z0-9]+)*@sha256:[a-f0-9]{64}$`)
	hostPort = regexp.MustCompile(`^[A-Za-z0-9]([-.A-Za-z0-9]*[A-Za-z0-9])?(:[0-9]{1,5})?$`)
)

// on says the cell runs environment Runs.
func (s k8sEnvSettings) on() bool { return s.Namespace != "" }

// checkK8sEnv refuses environment settings the driver could not run, each
// error naming the flag to fix: none of them without -k8s-env-namespace, and
// with it the egress, the observer (its image, -observer http and
// -observer-server-name: its certificate cannot name a pod's address) and
// a build registry with a builder image, or neither.
func checkK8sEnv(st settings) error {
	e := st.K8s.Env
	if !e.on() {
		for flag, v := range map[string]string{
			"-k8s-env-builder-image": e.BuilderImage, "-k8s-env-build-registry": e.BuildRegistry, "-k8s-env-build-mirror": e.BuildMirror,
			"-k8s-env-observer-image": e.ObserverImage, "-k8s-env-egress-pod-labels": e.EgressPodLabels, "-k8s-env-egress-namespace": e.EgressNamespace,
		} {
			if v != "" {
				return fmt.Errorf("%s is set without -k8s-env-namespace: environment Runs are off", flag)
			}
		}
		return nil
	}
	switch {
	case !dnsLabel.MatchString(e.Namespace) || len(e.Namespace) > 63:
		return fmt.Errorf("-k8s-env-namespace %q is not a namespace name", e.Namespace)
	case e.Namespace == st.K8s.Namespace:
		return errors.New("-k8s-env-namespace must not be -k8s-namespace: environment pods run in their own namespace (Pod Security privileged, the environment gate), never the restricted sandbox one")
	case e.EgressNamespace == "" || e.EgressPodLabels == "":
		return errors.New("-k8s-env-namespace needs -k8s-env-egress-namespace and -k8s-env-egress-pod-labels: the cell's proxy and resolver pods, a claim's only way out")
	case !dnsLabel.MatchString(e.EgressNamespace):
		return fmt.Errorf("-k8s-env-egress-namespace %q is not a namespace name", e.EgressNamespace)
	case e.ObserverImage == "":
		return errors.New("-k8s-env-namespace needs -k8s-env-observer-image: every probe of an environment Run goes through the claim's observer pod")
	case !imageRef.MatchString(e.ObserverImage):
		return fmt.Errorf("-k8s-env-observer-image %q is not an image by digest (repository@sha256:...)", e.ObserverImage)
	case st.ObsMode != observerHTTP:
		return errors.New("-k8s-env-namespace needs -observer http: the claim's observer is a pod of its own")
	case st.ObsServerName == "":
		return errors.New("-k8s-env-namespace needs -observer-server-name: the observer's certificate cannot name a pod's address")
	case e.ObserverTLSDir == "":
		return errors.New("-k8s-env-namespace needs -k8s-env-observer-tls-dir")
	case e.ObserverMemoryMB < 0 || e.ObserverMilliCPU < 0:
		return errors.New("-k8s-env-observer-memory-mb and -k8s-env-observer-millicpu are never negative")
	case (e.BuilderImage == "") != (e.BuildRegistry == ""):
		return errors.New("-k8s-env-builder-image and -k8s-env-build-registry go together: a build section runs only with both")
	case e.BuilderImage != "" && !imageRef.MatchString(e.BuilderImage):
		return fmt.Errorf("-k8s-env-builder-image %q is not an image by digest (repository@sha256:...)", e.BuilderImage)
	case e.BuildRegistry == "" && (e.BuildRegistryPull != "" || e.BuildMirror != "" || e.BuildRegistryInsecure):
		return errors.New("-k8s-env-build-registry-pull, -k8s-env-build-mirror and -k8s-env-build-registry-insecure need -k8s-env-build-registry")
	}
	for flag, v := range map[string]string{"-k8s-env-build-registry": e.BuildRegistry, "-k8s-env-build-registry-pull": e.BuildRegistryPull, "-k8s-env-build-mirror": e.BuildMirror} {
		if v != "" && !hostPort.MatchString(v) {
			return fmt.Errorf("%s %q is not host[:port]", flag, v)
		}
	}
	if _, err := parseLabels(e.EgressPodLabels); err != nil {
		return fmt.Errorf("-k8s-env-egress-pod-labels: %w", err)
	}
	if _, err := parsePorts(e.EgressPorts); err != nil {
		return fmt.Errorf("-k8s-env-egress-ports: %w", err)
	}
	return nil
}

func parseLabels(s string) (map[string]string, error) {
	out := map[string]string{}
	for _, kv := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(kv), "=")
		if !ok || k == "" || v == "" {
			return nil, fmt.Errorf("%q is not key=value", kv)
		}
		out[k] = v
	}
	return out, nil
}

func parsePorts(s string) ([]kube.Port, error) {
	var out []kube.Port
	for _, p := range strings.Split(s, ",") {
		num, proto, _ := strings.Cut(strings.TrimSpace(p), "/")
		n, err := strconv.Atoi(num)
		if proto == "" {
			proto = "TCP"
		}
		if err != nil || n < 1 || n > 65535 || (proto != "TCP" && proto != "UDP") {
			return nil, fmt.Errorf("%q is not port/TCP or port/UDP", p)
		}
		out = append(out, kube.Port{Protocol: proto, Port: n})
	}
	return out, nil
}

// envConfig is the driver's environment configuration from the flags; lookup
// resolves the build registry's and the mirror's names (the builder's
// resolver is the cell's, which knows no cluster name: it gets them in its
// /etc/hosts, and its NetworkPolicy lets it reach those addresses only).
func envConfig(ctx context.Context, st settings, k *k8ssandbox.Client, lookup func(context.Context, string) ([]string, error)) (*k8ssandbox.EnvConfig, error) {
	e := st.K8s.Env
	labels, err := parseLabels(e.EgressPodLabels)
	if err != nil {
		return nil, err
	}
	ports, err := parsePorts(e.EgressPorts)
	if err != nil {
		return nil, err
	}
	cfg := &k8ssandbox.EnvConfig{
		Namespace: e.Namespace, VolumeSize: e.VolumeSize, StorageClass: e.StorageClass,
		Egress:       []kube.EgressPeer{{NamespaceLabels: map[string]string{"kubernetes.io/metadata.name": e.EgressNamespace}, PodLabels: labels, Ports: ports}},
		BuilderImage: e.BuilderImage, BuildRegistry: e.BuildRegistry, BuildRegistryPull: e.BuildRegistryPull,
		BuildRegistryInsecure: e.BuildRegistryInsecure, BuildMirror: e.BuildMirror, BuildStorage: e.BuildStorage,
		ObserverImage: e.ObserverImage, ObserverTLSDir: e.ObserverTLSDir, ObserverMemoryMB: e.ObserverMemoryMB, ObserverMilliCPU: e.ObserverMilliCPU,
	}
	if k != nil {
		cfg.API, cfg.Exec = k, k
	}
	if e.BuildRegistry != "" {
		cfg.BuildHosts = map[string]string{}
		defPort := 443
		if e.BuildRegistryInsecure {
			defPort = 80
		}
		for _, r := range []struct {
			addr string
			port int
		}{{e.BuildRegistry, defPort}, {e.BuildMirror, 80}} {
			if r.addr == "" {
				continue
			}
			peer, err := buildPeer(ctx, r.addr, r.port, cfg.BuildHosts, lookup)
			if err != nil {
				return nil, err
			}
			cfg.BuildEgress = append(cfg.BuildEgress, peer)
		}
	}
	return cfg, nil
}

// buildPeer is the builder's way to host[:port]: its address (a name
// resolved, waited for while a new Service is not in DNS yet, and kept in
// hosts) as a /32 on that port.
func buildPeer(ctx context.Context, addr string, defPort int, hosts map[string]string, lookup func(context.Context, string) ([]string, error)) (kube.EgressPeer, error) {
	host, port := addr, defPort
	if h, p, err := net.SplitHostPort(addr); err == nil {
		n, err := strconv.Atoi(p)
		if err != nil {
			return kube.EgressPeer{}, fmt.Errorf("%s: port %q", addr, p)
		}
		host, port = h, n
	}
	ip, err := resolveEgress(ctx, host, lookup)
	if err != nil {
		return kube.EgressPeer{}, fmt.Errorf("k8s-sandbox environments: %s: %w", addr, err)
	}
	if net.ParseIP(host) == nil {
		hosts[host] = ip
	}
	return kube.EgressPeer{CIDR: ip + "/32", Ports: []kube.Port{{Protocol: "TCP", Port: port}}}, nil
}

// k8sObservers is each claim's observer pod, reached through its bridge
// over pods/exec (k8ssandbox.Driver.DialObserver) with the cell's observer
// client certificate: the cell opens no TCP connection into the
// environment namespace. The targets are the service pods' addresses.
func k8sObservers(obsTLS *tls.Config, d *k8ssandbox.Driver) agent.ObserverFactory {
	return func(ctx context.Context, c agent.ClaimInfo, targets []observer.Target) (observer.Client, error) {
		targets, err := d.Targets(c.Workload.MachineID, targets)
		if err != nil {
			return nil, err
		}
		hc := &http.Client{Timeout: 11 * time.Minute, Transport: observerPodTransport(obsTLS, d, c.Observer.MachineID)}
		return observerclient.Configure(ctx, hc, observerPodURL(c), observerConfig(c, targets))
	}
}

// k8sPreviewUpstreams is a preview claim's upstream: its observer pod
// configured as a probe would, then its /v1/preview proxy over the same
// pods/exec bridge.
func k8sPreviewUpstreams(observers agent.ObserverFactory, obsTLS *tls.Config, d *k8ssandbox.Driver) agent.PreviewUpstreamFactory {
	return func(ctx context.Context, c agent.ClaimInfo, targets []observer.Target) (http.Handler, error) {
		if _, err := observers(ctx, c, targets); err != nil {
			return nil, err
		}
		return preview.ObserverUpstream(observerPodURL(c), observerPodTransport(obsTLS, d, c.Observer.MachineID))
	}
}

// observerPodTransport dials every connection through the observer pod's
// bridge; one exec stream per request, so a POST is never sent on a stream
// the observer closed.
func observerPodTransport(obsTLS *tls.Config, d *k8ssandbox.Driver, machine string) *http.Transport {
	return &http.Transport{
		DisableKeepAlives: true,
		TLSClientConfig:   obsTLS,
		DialContext:       func(ctx context.Context, _, _ string) (net.Conn, error) { return d.DialObserver(ctx, machine) },
	}
}

// observerPodURL only names the endpoint (the client checks it is an
// address): the pod's address and the observer's loopback port.
func observerPodURL(c agent.ClaimInfo) string {
	_, port, _ := net.SplitHostPort(kube.ObserverListen)
	return "https://" + net.JoinHostPort(c.Observer.PrivateAddress, port)
}

// k8sEnvFiles checks the observer TLS files the cell lays into each
// observer pod: readable, the key the certificate's, and the certificate
// valid for serverName (-observer-server-name, what the cell checks).
func k8sEnvFiles(dir, serverName string) error {
	var errs []error
	for _, f := range []string{"cert.pem", "key.pem", "ca.pem"} {
		if _, err := os.ReadFile(filepath.Join(dir, f)); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) == 0 {
		pair, err := tls.LoadX509KeyPair(filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem"))
		switch {
		case err != nil:
			errs = append(errs, fmt.Errorf("observer certificate: %w", err))
		case pair.Leaf == nil:
			errs = append(errs, errors.New("observer certificate: no leaf"))
		default:
			if err := pair.Leaf.VerifyHostname(serverName); err != nil {
				errs = append(errs, fmt.Errorf("observer certificate and -observer-server-name: %w", err))
			}
		}
	}
	return errors.Join(errs...)
}

package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
)

// fileConfig is the -config file (JSON, or YAML by extension). Every field
// is optional; a flag given on the command line wins over the file, and the
// file wins over the flag's default. It holds no secrets: only paths to
// them. The -dev-insecure-local-docker flag is deliberately not in it.
type fileConfig struct {
	GVisorClaimLimitBackend string   `json:"claimLimitBackend" yaml:"claimLimitBackend"`
	GVisorClaimRootSlice    string   `json:"claimRootSlice" yaml:"claimRootSlice"`
	GVisorClaimLimits       string   `json:"claimLimits" yaml:"claimLimits"`
	GVisorClaimCgroupRoot   string   `json:"claimCgroupRoot" yaml:"claimCgroupRoot"`
	MaxClaimSteps           *int     `json:"maxClaimSteps" yaml:"maxClaimSteps"`
	HubURL                  string   `json:"hubUrl" yaml:"hubUrl"`
	CellID                  string   `json:"cellId" yaml:"cellId"`
	Driver                  string   `json:"driver" yaml:"driver"`
	Regions                 []string `json:"regions" yaml:"regions"`
	WorkDir                 string   `json:"workDir" yaml:"workDir"`
	StateDir                string   `json:"stateDir" yaml:"stateDir"`
	GitAPI                  string   `json:"gitApi" yaml:"gitApi"`
	Dev                     *bool    `json:"dev" yaml:"dev"`
	// AutoRenew renews the client certificate with a third of it left (default true).
	AutoRenew *bool `json:"autoRenew" yaml:"autoRenew"`
	// MetricsAddr serves /metrics (Prometheus text); "off" disables it.
	MetricsAddr string `json:"metricsAddr" yaml:"metricsAddr"`
	TLS         struct {
		CA     string `json:"ca" yaml:"ca"`
		Cert   string `json:"cert" yaml:"cert"`
		Key    string `json:"key" yaml:"key"`
		Issuer string `json:"issuer" yaml:"issuer"`
	} `json:"tls" yaml:"tls"`
	Observer struct {
		Mode string `json:"mode" yaml:"mode"`
		CA   string `json:"ca" yaml:"ca"`
		Cert string `json:"cert" yaml:"cert"`
		Key  string `json:"key" yaml:"key"`
	} `json:"observer" yaml:"observer"`
}

// settings is what the cell runs with, after flags and the file.
type settings struct {
	GVisorClaimLimits, GVisorClaimCgroupRoot      string
	GVisorClaimLimitBackend, GVisorClaimRootSlice string
	MaxClaimSteps                                 int
	Config                                        string
	HubURL                                        string
	CellID                                        string
	Cert                                          string
	Key                                           string
	CA                                            string
	Issuer                                        string
	Driver                                        string
	Regions                                       string
	WorkDir                                       string
	StateDir                                      string
	GitAPI                                        string
	ObsMode                                       string
	ObsCert                                       string
	ObsKey                                        string
	ObsCA                                         string
	// ObsServerName is the name an observer's certificate carries; empty:
	// its address.
	ObsServerName string
	EgressEPs     string
	// GVisorHolderImage is docker-gvisor's holder image.
	GVisorHolderImage string
	// GVisorEgressContainer is the cell's egress container on the same
	// Docker, which joins every claim network (docker-gvisor).
	GVisorEgressContainer string
	// GVisorBuilderImage is rootless BuildKit, by digest (docker-gvisor).
	GVisorBuilderImage string
	// GVisorHelperImage copies data volumes under gVisor for bakes (docker-gvisor).
	GVisorHelperImage string
	// GVisorMirrorGoProxy is the GOPROXY every docker-gvisor build gets (the cell's mirror).
	GVisorMirrorGoProxy string
	// GVisorMirrorRegistry is the registry mirror (host:port) every docker-gvisor build pulls docker.io through.
	GVisorMirrorRegistry string
	// GVisorMemLimit is the memory every docker-gvisor service and build gets ("4g" when empty)
	// when its claim asks no size; GVisorMemMax and GVisorCPUsMax are the
	// largest size one claim may ask (the default when unset).
	GVisorMemLimit string
	GVisorMemMax   string
	GVisorCPUsMax  int
	// GVisorMemReady is what a ready docker-gvisor claim is counted for in
	// the memory admission ("2g" when empty; ADR-070).
	GVisorMemReady string
	// GVisorHealthStart is how often a starting service's healthcheck runs
	// until it first passes (0: the driver's default, negative: as written).
	GVisorHealthStart time.Duration
	// GVisorGoldenData keeps a copy of each machine's first-boot database
	// for its round resets (dockergvisor golden data); false: every reset
	// initializes the database from nothing.
	GVisorGoldenData bool
	// MemoryAdmission takes a claim only when its memory fits what the cell
	// may commit (ADR-070): MemoryAllocatableMB, else the host's memory less
	// MemoryReserveMB. Only for a driver whose claims share the host.
	MemoryAdmission     bool
	MemoryReserveMB     int
	MemoryAllocatableMB int
	// GVisorBuildState keeps BuildKit's state per environment (layers and
	// cache mounts), GVisorBuildStateKeep bounds one (BuildKit GC) and
	// GVisorBuildStateMinFreeGB is the disk floor under which the least
	// recently used states go.
	GVisorBuildState          bool
	GVisorBuildStateKeep      string
	GVisorBuildStateMinFreeGB int
	// GVisorBuilderUID and GVisorBuilderGID are the builder's ids as the
	// host sees them, the owner of what it writes; needed only when Docker
	// remaps user namespaces (0: the image's user, 1000).
	GVisorBuilderUID, GVisorBuilderGID int
	// GVisorBrowserImage is the browser runner (browser-runner/, ADR-071),
	// by digest; empty: no browser runner, and browser probes are refused
	// with browser_unavailable as before.
	GVisorBrowserImage string
	// BrowserExplore enables native local exploration only after the product API upgrade.
	BrowserExplore bool
	// GVisorObserverImage runs each claim's observer (cmd/observer at
	// /observer, by digest); GVisorObserverTLS is the directory with its
	// server certificate and the CA of -observer-cert.
	GVisorObserverImage string
	GVisorObserverTLS   string
	PolicyKey           string
	EgressBase          string
	AWSConfig           string
	Dev                 bool
	AutoRenew           bool
	MetricsAddr         string
	// DevInsecureLocalDocker is one half of the local-docker gate (the other
	// is KODY_RUNTIME_DEV=1). Flag only, never from the file.
	DevInsecureLocalDocker bool
}

func (s *settings) register(fs *flag.FlagSet) {
	fs.StringVar(&s.GVisorClaimLimits, "gvisor-claim-limits", "off", "off | required: aggregate container CPU/memory/host-task enforcement (Linux cgroup v2 only)")
	fs.StringVar(&s.GVisorClaimLimitBackend, "gvisor-claim-limit-backend", "cgroupfs", "cgroupfs | systemd: explicit aggregate resource controller backend")
	fs.StringVar(&s.GVisorClaimRootSlice, "gvisor-claim-root-slice", "", "explicit active owned per-cell root slice for systemd backend; never created by cell")
	fs.StringVar(&s.GVisorClaimCgroupRoot, "gvisor-claim-cgroup-root", "", "exclusive predelegated cgroup v2 root on the Docker host; never created or delegated by cell")
	fs.IntVar(&s.MaxClaimSteps, "max-claim-steps", agent.DefaultMaxClaimSteps, "maximum active exec, probe and reset steps per claim (1..64); full claims refuse new steps")
	fs.StringVar(&s.Config, "config", os.Getenv("KODUS_CELL_CONFIG"), "config file (JSON, or YAML by extension); flags override it")
	fs.StringVar(&s.HubURL, "hub-url", os.Getenv("KODUS_HUB_URL"), "wss://runtime-hub/v1/cell")
	fs.StringVar(&s.CellID, "cell-id", os.Getenv("KODUS_CELL_ID"), "cell id (default: the certificate CN); refused when it is not the CN")
	fs.StringVar(&s.Cert, "cert", "/etc/kodus/cell/cert.pem", "cell client certificate")
	fs.StringVar(&s.Key, "key", "/etc/kodus/cell/key.pem", "cell client key")
	fs.StringVar(&s.CA, "ca", "/etc/kodus/cell/ca.pem", "CA of the hub's server certificate (cell register copies the -ca it was given here)")
	fs.StringVar(&s.Issuer, "issuer", "", "CA that signed the cell certificate, every renewal must chain to it (default issuer.pem next to -cert)")
	fs.StringVar(&s.Driver, "driver", "", "aws-ec2 | docker-gvisor | local-docker (dev only, no isolation) | fake (dev only, no isolation); required")
	fs.StringVar(&s.Regions, "regions", "", "comma-separated regions")
	fs.StringVar(&s.WorkDir, "workdir", "/var/lib/kodus-cell", "scratch directory for tarballs")
	fs.StringVar(&s.StateDir, "state-dir", "", "driver state (default <workdir>/state)")
	fs.StringVar(&s.GitAPI, "git-api", "https://api.github.com", "Git API base for tarballs and token revocation")
	fs.StringVar(&s.ObsMode, "observer", "inprocess", "inprocess (fake and local-docker only) | http")
	fs.StringVar(&s.ObsCert, "observer-cert", "/etc/kodus/cell/observer-client-cert.pem", "client certificate for observers")
	fs.StringVar(&s.ObsKey, "observer-key", "/etc/kodus/cell/observer-client-key.pem", "client key for observers")
	fs.StringVar(&s.ObsCA, "observer-ca", "/etc/kodus/cell/observer-ca.pem", "CA of observer certificates")
	fs.StringVar(&s.ObsServerName, "observer-server-name", "", "name in the observers' certificate (docker-gvisor: kodus-observer); empty: the observer's address")
	fs.StringVar(&s.EgressEPs, "egress-control", "", "control URLs of the policy enforcers, by name: egress=https://h:9443,resolver=https://h:9444,injector=https://h:9445")
	fs.StringVar(&s.GVisorHolderImage, "gvisor-holder-image", "", "docker-gvisor: the holder image, by digest")
	fs.StringVar(&s.GVisorBuilderImage, "gvisor-builder-image", "", "docker-gvisor: rootless BuildKit by digest, which builds a project's build sections under gVisor on the claim network; without it a project that builds is refused")
	fs.StringVar(&s.GVisorMirrorGoProxy, "gvisor-mirror-goproxy", "", "docker-gvisor: GOPROXY every build gets as a build argument, the cell's registry mirror (http://mirror.cell.internal:8080/go,off)")
	fs.StringVar(&s.GVisorMirrorRegistry, "gvisor-mirror-registry", "", "docker-gvisor: the registry mirror (host:port, e.g. mirror.cell.internal:8080) every build pulls docker.io images through")
	fs.BoolVar(&s.GVisorBuildState, "gvisor-build-state", false, "docker-gvisor: keep BuildKit's state per environment, written by the default branch's setup and read by every other build through a throwaway overlay (needs root)")
	fs.IntVar(&s.GVisorBuilderUID, "gvisor-builder-uid", 0, "docker-gvisor: the builder's uid on the host, owner of the directories it writes; required when Docker remaps user namespaces (userns-remap, rootless), else 1000, the rootless BuildKit image's user")
	fs.IntVar(&s.GVisorBuilderGID, "gvisor-builder-gid", 0, "docker-gvisor: the builder's gid on the host (see -gvisor-builder-uid)")
	fs.StringVar(&s.GVisorBuildStateKeep, "gvisor-build-state-keep", "20GB", "docker-gvisor: what BuildKit's GC keeps in one environment's state")
	fs.IntVar(&s.GVisorBuildStateMinFreeGB, "gvisor-build-state-min-free-gb", 20, "docker-gvisor: below this much free disk, the least recently used environment states are removed")
	fs.StringVar(&s.GVisorMemLimit, "gvisor-mem-limit", "", "docker-gvisor: the memory limit of every service and build whose claim asks no size, as docker takes it (4g when empty; a large Go or JS build needs more)")
	fs.StringVar(&s.GVisorMemMax, "gvisor-mem-max", "", "docker-gvisor: the most memory one claim may ask for its builds and services (an environment's machine size), as docker takes it (-gvisor-mem-limit when empty); a claim that asks more is refused with size_unavailable")
	fs.BoolVar(&s.GVisorGoldenData, "gvisor-golden-data", true, "docker-gvisor: a round reset gives postgres a copy of the machine's first-boot data instead of a new initdb and seed, where nothing of the app ran before it (false: recreate every round)")
	fs.DurationVar(&s.GVisorHealthStart, "gvisor-health-start-interval", 0, "docker-gvisor: how often a starting service's healthcheck runs until it first passes, on every boot and round reset (0: 200ms; negative: as the compose file says)")
	fs.StringVar(&s.GVisorMemReady, "gvisor-mem-ready", "", "docker-gvisor: what a ready claim is counted for in the memory admission, as docker takes it (2g when empty, never above the claim's own memory); a count, not a limit")
	fs.BoolVar(&s.MemoryAdmission, "memory-admission", true, "docker-gvisor: take a claim only when its memory fits what the cell may commit (a booting claim at its build size, a ready one at -gvisor-mem-ready); a claim that does not fit waits in the worker (ADR-070)")
	fs.IntVar(&s.MemoryReserveMB, "memory-reserve-mb", 1024, "memory the admission leaves to the host (Docker, the cell, the egress and mirror containers), in MB, from the host's MemTotal")
	fs.IntVar(&s.MemoryAllocatableMB, "memory-allocatable-mb", 0, "memory the cell may commit to claims, in MB; 0: the host's MemTotal less -memory-reserve-mb")
	fs.IntVar(&s.GVisorCPUsMax, "gvisor-cpus-max", 0, "docker-gvisor: the most CPUs one claim may ask for its builds and services (the default 2 when 0)")
	fs.StringVar(&s.GVisorHelperImage, "gvisor-helper-image", "", "docker-gvisor: image with sh and cp that copies a bake's data volumes under gVisor, by digest in production (busybox:1.36 when empty)")
	fs.StringVar(&s.GVisorObserverImage, "gvisor-observer-image", "", "docker-gvisor: the observer image (cmd/observer at /observer), by digest; each claim's observer runs it under gVisor on the claim network (-observer http)")
	fs.BoolVar(&s.BrowserExplore, "browser-explore", false, "docker-gvisor: enable local agent-browser exploration with a compatible pinned browser image; upgrade the product planner API first")
	fs.StringVar(&s.GVisorBrowserImage, "gvisor-browser-image", "", "docker-gvisor: the browser runner image (apps/runtime-cell/browser-runner), by digest; each browser probe round runs it under gVisor on the claim network (ADR-071)")
	fs.StringVar(&s.GVisorObserverTLS, "gvisor-observer-tls-dir", "/etc/kodus/cell/observer-server", "docker-gvisor: cert.pem and key.pem of the observers (for -observer-server-name) and ca.pem, the CA of -observer-cert; mounted read-only into each observer")
	fs.StringVar(&s.GVisorEgressContainer, "gvisor-egress-container", "", "docker-gvisor: the egress container (proxy and resolver) that joins every claim network; without it a claim has no way out")
	fs.StringVar(&s.PolicyKey, "policy-key", "/etc/kodus/cell/policy.key.pem", "ed25519 key that signs egress policies")
	fs.StringVar(&s.EgressBase, "egress-allow", "", "comma-separated hosts every VM may reach (mirror)")
	fs.BoolVar(&s.AutoRenew, "auto-renew", true, "renew the client certificate over mTLS (POST /cells/renew) when a third of its validity is left")
	fs.BoolVar(&s.Dev, "dev", false, "local development: allow extraction without a network namespace, and the fake driver")
	// 9466: the Runtime's metrics ports on one host are hub 9464, worker
	// 9465, cell 9466 (docker-compose.dev.yml publishes the first two).
	fs.StringVar(&s.MetricsAddr, "metrics-addr", "127.0.0.1:9466", "address of /metrics (Prometheus text format); off disables it")
	fs.StringVar(&s.AWSConfig, "aws-config", "/etc/kodus/cell/aws.json", "aws-ec2 driver settings (VPC, subnets, groups, launch template, org keys)")
	fs.BoolVar(&s.DevInsecureLocalDocker, "dev-insecure-local-docker", false, "allow the local-docker driver (NO isolation; also needs KODY_RUNTIME_DEV=1)")
}

func loadFile(path string) (fileConfig, error) {
	var fc fileConfig
	b, err := os.ReadFile(path)
	if err != nil {
		return fc, err
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".yaml", ".yml":
		dec := yaml.NewDecoder(bytes.NewReader(b))
		dec.KnownFields(true)
		err = dec.Decode(&fc)
	default:
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.DisallowUnknownFields()
		err = dec.Decode(&fc)
	}
	if err != nil {
		return fc, fmt.Errorf("config %s: %w", path, err)
	}
	return fc, nil
}

// applyFile takes each value from the file unless its flag was given.
func (s *settings) applyFile(fc fileConfig, set map[string]bool) {
	if fc.MaxClaimSteps != nil && !set["max-claim-steps"] {
		s.MaxClaimSteps = *fc.MaxClaimSteps
	}
	str := func(name string, dst *string, v string) {
		if v != "" && !set[name] {
			*dst = v
		}
	}
	str("gvisor-claim-limits", &s.GVisorClaimLimits, fc.GVisorClaimLimits)
	str("gvisor-claim-cgroup-root", &s.GVisorClaimCgroupRoot, fc.GVisorClaimCgroupRoot)
	str("gvisor-claim-limit-backend", &s.GVisorClaimLimitBackend, fc.GVisorClaimLimitBackend)
	str("gvisor-claim-root-slice", &s.GVisorClaimRootSlice, fc.GVisorClaimRootSlice)
	str("hub-url", &s.HubURL, fc.HubURL)
	str("cell-id", &s.CellID, fc.CellID)
	str("driver", &s.Driver, fc.Driver)
	str("regions", &s.Regions, strings.Join(fc.Regions, ","))
	str("workdir", &s.WorkDir, fc.WorkDir)
	str("state-dir", &s.StateDir, fc.StateDir)
	str("git-api", &s.GitAPI, fc.GitAPI)
	str("ca", &s.CA, fc.TLS.CA)
	str("cert", &s.Cert, fc.TLS.Cert)
	str("key", &s.Key, fc.TLS.Key)
	str("issuer", &s.Issuer, fc.TLS.Issuer)
	str("metrics-addr", &s.MetricsAddr, fc.MetricsAddr)
	str("observer", &s.ObsMode, fc.Observer.Mode)
	str("observer-ca", &s.ObsCA, fc.Observer.CA)
	str("observer-cert", &s.ObsCert, fc.Observer.Cert)
	str("observer-key", &s.ObsKey, fc.Observer.Key)
	if fc.Dev != nil && !set["dev"] {
		s.Dev = *fc.Dev
	}
	if fc.AutoRenew != nil && !set["auto-renew"] {
		s.AutoRenew = *fc.AutoRenew
	}
}

// parseSettings parses the flags, then fills what they left unset from the
// config file.
func parseSettings(fs *flag.FlagSet, args []string) (settings, error) {
	var s settings
	s.register(fs)
	if err := fs.Parse(args); err != nil {
		return s, err
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	var fc fileConfig
	if s.Config != "" {
		var err error
		fc, err = loadFile(s.Config)
		if err != nil {
			return s, err
		}
		s.applyFile(fc, set)
	}
	if value, present := os.LookupEnv("KODUS_CELL_MAX_CLAIM_STEPS"); present && !set["max-claim-steps"] && fc.MaxClaimSteps == nil {
		var err error
		s.MaxClaimSteps, err = strconv.Atoi(value)
		if err != nil {
			return s, fmt.Errorf("max claim steps must be an integer in 1..%d", agent.MaxClaimStepsLimit)
		}
	}
	if s.MaxClaimSteps < 1 || s.MaxClaimSteps > agent.MaxClaimStepsLimit {
		return s, fmt.Errorf("max claim steps must be 1..%d", agent.MaxClaimStepsLimit)
	}
	if s.GVisorClaimLimits != "off" && s.GVisorClaimLimits != "required" {
		return s, fmt.Errorf("gvisor claim limits must be off or required")
	}
	if s.GVisorClaimLimitBackend != "cgroupfs" && s.GVisorClaimLimitBackend != "systemd" {
		return s, fmt.Errorf("gvisor claim limit backend must be cgroupfs or systemd")
	}
	if s.GVisorClaimLimits == "off" && (s.GVisorClaimCgroupRoot != "" || s.GVisorClaimRootSlice != "" || s.GVisorClaimLimitBackend != "cgroupfs") {
		return s, fmt.Errorf("claim roots/backend require claim limits mode required")
	}
	if s.GVisorClaimLimits == "required" {
		if s.Driver != "docker-gvisor" || !s.MemoryAdmission {
			return s, fmt.Errorf("required claim limits need docker-gvisor and physical memory admission")
		}
		if s.GVisorClaimLimitBackend == "cgroupfs" && (s.GVisorClaimCgroupRoot == "" || s.GVisorClaimRootSlice != "") {
			return s, fmt.Errorf("cgroupfs needs only a delegated cgroup root")
		}
		if s.GVisorClaimLimitBackend == "systemd" && (s.GVisorClaimRootSlice == "" || s.GVisorClaimCgroupRoot != "") {
			return s, fmt.Errorf("systemd needs only an explicit owned root slice")
		}
	}
	if s.BrowserExplore && (s.Driver != "docker-gvisor" || s.GVisorBrowserImage == "") {
		return s, fmt.Errorf("browser exploration requires docker-gvisor and a compatible pinned browser image")
	}
	if s.StateDir == "" {
		s.StateDir = filepath.Join(s.WorkDir, "state")
	}
	if s.Issuer == "" {
		s.Issuer = filepath.Join(filepath.Dir(s.Cert), "issuer.pem")
	}
	return s, nil
}

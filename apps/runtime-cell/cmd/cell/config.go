package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// defaultBuilderImage is the cell's image builder (builder-image/): rootless
// BuildKit with the overlay differ fixed for gVisor and the cell's trust
// bundle in every RUN step, by the digest of its reproducible build. The
// release workflow publishes it and stops when it builds another digest;
// change it only with builder-image/README.md.
const defaultBuilderImage = "ghcr.io/kodustech/kodus-runtime-builder@sha256:07f926354bfd21b8af9526f63924a0ca4e8cf89dfe56527e6dd7ed68ca5d16c1"

// builderTrustsCellCA reports whether the builder image's RUN steps trust
// the cell CA (builder-image/exec-ca-bundle.patch): the cell's own builder by
// its pinned digest, under whatever name a host pulls it (a local registry
// of the same digest), or one the operator says is a build of builder-image/
// (-gvisor-builder-trust). A stock BuildKit is not: its RUN steps would
// refuse every inspected host, so the cell keeps refusing their TLS instead.
func builderTrustsCellCA(image string, operator bool) bool {
	_, pinned, _ := strings.Cut(defaultBuilderImage, "@")
	return operator || (image != "" && strings.HasSuffix(image, "@"+pinned))
}

// defaultRegistryImage is the distribution registry (Apache-2.0) a registry
// transfer pushes to, by digest (registry 3).
const defaultRegistryImage = "docker.io/library/registry:3@sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c"

// The -config file (JSON, or YAML by extension) sets any of the cell's flags
// by its name ("gvisor-mem-limit": "8g"); a list is a comma-separated flag's
// value. A flag given on the command line wins over the file, and the file
// wins over the flag's default. It holds no secrets: only paths to them.
// -config and -dev-insecure-local-docker are not in it, and a key that names
// no flag is refused. The keys of the file's first format (camelCase, with
// the tls and observer sections) are still read, as their flags (oldFileKeys),
// an empty string among them meaning unset as it did.

// fileOnlyByFlag are the flags the file never sets (json is cell
// preflight's own).
var fileOnlyByFlag = map[string]bool{"config": true, "dev-insecure-local-docker": true, "json": true}

// oldFileKeys are the first format's keys and the flag each one sets.
var oldFileKeys = map[string]string{
	"claimLimitBackend": "gvisor-claim-limit-backend", "claimRootSlice": "gvisor-claim-root-slice",
	"claimLimits": "gvisor-claim-limits", "claimCgroupRoot": "gvisor-claim-cgroup-root",
	"maxClaimSteps": "max-claim-steps", "hubUrl": "hub-url", "owner": "owner", "cellId": "cell-id",
	"driver": "driver", "regions": "regions", "workDir": "workdir", "stateDir": "state-dir",
	"gitApi": "git-api", "dev": "dev", "autoRenew": "auto-renew", "metricsAddr": "metrics-addr",
	"tls.ca": "ca", "tls.cert": "cert", "tls.key": "key", "tls.issuer": "issuer", "tls.localCa": "local-ca",
	"observer.mode": "observer", "observer.ca": "observer-ca", "observer.cert": "observer-cert", "observer.key": "observer-key",
}

// oldFileSections are the first format's sections; a scalar under the same
// key is the flag of that name (observer).
var oldFileSections = map[string]bool{"tls": true, "observer": true}

// loadFile reads the -config file as flag name to value, refusing a key
// that is not a flag of fs the file may set.
func loadFile(path string, fs *flag.FlagSet) (map[string]string, error) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: path is the operator's -config flag
	if err != nil {
		return nil, err
	}
	var raw map[string]any
	switch strings.ToLower(filepath.Ext(path)) {
	case ".yaml", ".yml":
		err = yaml.Unmarshal(b, &raw)
	default:
		dec := json.NewDecoder(bytes.NewReader(b))
		dec.UseNumber()
		err = dec.Decode(&raw)
	}
	if err != nil {
		return nil, fmt.Errorf("config %s: %w", path, err)
	}
	out := map[string]string{}
	from := map[string]string{} // flag name to the key that set it
	add := func(key, name string, v any, old bool) error {
		if v == nil {
			return nil
		}
		if f := fs.Lookup(name); f == nil || fileOnlyByFlag[name] {
			return fmt.Errorf("config %s: unknown key %q", path, key)
		}
		value, err := fileValue(v)
		if err != nil {
			return fmt.Errorf("config %s: %s: %w", path, key, err)
		}
		if old && value == "" {
			return nil
		}
		if prev, ok := from[name]; ok {
			return fmt.Errorf("config %s: %q and %q both set -%s", path, prev, key, name)
		}
		out[name], from[name] = value, key
		return nil
	}
	for key, v := range raw {
		if section, ok := v.(map[string]any); ok && oldFileSections[key] {
			for sub, sv := range section {
				name, ok := oldFileKeys[key+"."+sub]
				if !ok {
					return nil, fmt.Errorf("config %s: unknown key %q", path, key+"."+sub)
				}
				if err := add(key+"."+sub, name, sv, true); err != nil {
					return nil, err
				}
			}
			continue
		}
		name, old := oldFileKeys[key]
		if !old {
			name = key
		}
		if err := add(key, name, v, old); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// applyFile sets each flag of the file the command line did not give (set
// names those) and adds it to set.
func applyFile(fs *flag.FlagSet, path string, set map[string]bool) error {
	file, err := loadFile(path, fs)
	if err != nil {
		return err
	}
	for _, name := range slices.Sorted(maps.Keys(file)) {
		if set[name] {
			continue
		}
		if err := fs.Set(name, file[name]); err != nil {
			return fmt.Errorf("config %s: -%s: %w", path, name, err)
		}
		set[name] = true
	}
	return nil
}

// fileValue is a file value as its flag's text: a scalar as written, a list
// joined by commas.
func fileValue(v any) (string, error) {
	switch v := v.(type) {
	case string:
		return v, nil
	case []any:
		parts := make([]string, 0, len(v))
		for _, e := range v {
			p, err := fileValue(e)
			if err != nil {
				return "", err
			}
			parts = append(parts, p)
		}
		return strings.Join(parts, ","), nil
	case map[string]any:
		return "", fmt.Errorf("a value, not a section")
	default:
		return fmt.Sprint(v), nil
	}
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
	LocalCA                                       string
	Owner                                         string
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
	// Sandbox is the code sandbox's image, pool and default size (sandbox.go).
	Sandbox sandboxSettings
	// Trust is what a claim with org secrets trusts (trust.go).
	Trust trustSettings
	// GVisorHolderImage is docker-gvisor's holder image.
	GVisorHolderImage string
	// IsolationBackend is docker-gvisor's isolation backend: gvisor, or
	// firecracker, which runs the cell's machines as microVMs on the
	// microvm driver (MicroVM).
	IsolationBackend string
	// HostPolicy is -host-policy: shared, dedicated or auto (hostcheck).
	HostPolicy string
	MicroVM    microvmSettings
	// GVisorEgressContainer is the cell's egress container on the same
	// Docker, which joins every claim network (docker-gvisor).
	GVisorEgressContainer string
	// GVisorBuilderImage is rootless BuildKit, by digest (docker-gvisor).
	GVisorBuilderImage string
	// GVisorBuilderTrust: GVisorBuilderImage carries the cell's
	// exec-ca-bundle.patch although it is not the pinned digest (builderTrustsCellCA).
	GVisorBuilderTrust bool
	// GVisorHelperImage copies data volumes under gVisor for bakes (docker-gvisor).
	GVisorHelperImage string
	// GVisorMirrorGoProxy is the GOPROXY every docker-gvisor build gets (the cell's mirror).
	GVisorMirrorGoProxy string
	// GVisorMirrorNPM and GVisorMirrorPyPI: the npm registry and PyPI index
	// every docker-gvisor build gets as build arguments (the cell's mirror).
	GVisorMirrorNPM, GVisorMirrorPyPI string
	// GVisorMirrorArtifacts is the root of the mirror's artifacts every docker-gvisor build gets the mirror variables of.
	GVisorMirrorArtifacts string
	// GVisorMirrorRegistry is the registry mirror (host:port) every docker-gvisor build pulls docker.io through.
	GVisorMirrorRegistry string
	// GVisorMemLimit is the memory every docker-gvisor service and build gets ("4g" when empty)
	// when its claim asks no size; GVisorMemMax and GVisorCPUsMax are the
	// largest size one claim may ask (the default when unset).
	GVisorMemLimit  string
	GVisorMemMax    string
	GVisorCPUsMax   int
	GVisorMaxBuilds int
	// GVisorClaimBuilds is how many builds of one claim run at once.
	GVisorClaimBuilds int
	// GVisorMemReady is the least ceiling a ready docker-gvisor claim keeps
	// under claim limits ("2g" when empty; ADR-070).
	GVisorMemReady string
	// GVisorHealthStart is how often a starting service's healthcheck runs
	// until it first passes (0: the driver's default, negative: as written).
	GVisorHealthStart time.Duration
	// GVisorGoldenData keeps a copy of each machine's first-boot database
	// for its round resets (dockergvisor golden data); false: every reset
	// initializes the database from nothing.
	GVisorGoldenData bool
	// GVisorWarmForkReset keeps a warm spare of a Run's compose project
	// booted while a round runs, so the next reset is a swap (dockergvisor
	// spare.go); off by default.
	GVisorWarmForkReset bool
	// GVisorToolLayer keeps tool layers (dockergvisor toollayers.go,
	// docs/runtime/persistent-state.md section 4): a custom agent's CLI built
	// once per org in a clean builder and mounted read-only into its reviews.
	// The limits are one layer, one org and the whole store; off by default.
	GVisorToolLayer         bool
	GVisorToolLayerMaxMB    int
	GVisorToolLayerOrgGB    int
	GVisorToolLayerBudgetGB int
	// MemoryAdmission takes a claim only when its memory fits what the cell
	// may commit (ADR-070): MemoryAllocatableMB, else the host's memory less
	// MemoryReserveMB. Only for a driver whose claims share the host
	// (docker-gvisor, and microvm under -isolation-backend firecracker).
	MemoryAdmission     bool
	MemoryReserveMB     int
	MemoryAllocatableMB int
	// GVisorBuildState keeps BuildKit's state per environment (layers and
	// cache mounts), GVisorBuildStateKeep bounds one (BuildKit GC) and
	// GVisorBuildStateMinFreeGB is the disk floor under which the states
	// cheapest to keep go, then the exported caches.
	GVisorBuildState          bool
	GVisorBuildStateKeep      string
	GVisorBuildStateMinFreeGB int
	// GVisorBuildStateViewsDir holds each build's throwaway view of a state
	// apart from the states (a disk that takes an overlay's upper layer, when
	// the work directory's does not). Empty: under the state's root.
	GVisorBuildStateViewsDir string
	// GVisorBuildCacheRemote is the build cache's store off the cell (an OCI
	// registry, docs/runtime/build-cache.md); GVisorBuildCacheRemoteAuthFile
	// holds its "user:password". Empty: the cache lives on the cell only.
	GVisorBuildCacheRemote         string
	GVisorBuildCacheRemoteAuthFile string
	// GVisorBakeShare is the org's registry of baked images
	// (docs/runtime/shared-baked-environments.md); GVisorBakeSharePull a
	// mirror near the cell pulls go to instead; GVisorBakeShareAuthFile
	// holds user:password for both.
	GVisorBakeShare         string
	GVisorBakeSharePull     string
	GVisorBakeShareAuthFile string
	// GVisorBuilderUID and GVisorBuilderGID are the builder's ids as the
	// host sees them, the owner of what it writes; needed only when Docker
	// remaps user namespaces (0: the image's user, 1000).
	GVisorBuilderUID, GVisorBuilderGID int
	// GVisorMaxImageGB bounds what one build may leave for the cell to load
	// (its output directory and its image tarball).
	GVisorMaxImageGB int
	// GVisorImageTransfer is how a build's image reaches the cell's Docker
	// (tarball | registry); GVisorRegistryImage the distribution registry a
	// registry build pushes to (by digest), GVisorRegistryKeepGB the most an
	// environment's registry storage keeps.
	GVisorImageTransfer  string
	GVisorRegistryImage  string
	GVisorRegistryKeepGB int
	// GVisorContainerDisk caps the writable layer of each holder, builder and
	// compose service (docker --storage-opt size=); empty: no cap.
	GVisorContainerDisk string
	// GVisorServiceLogMaxSize and GVisorServiceLogMaxFile bound every
	// compose service's logs (the local log driver, forced on every service).
	GVisorServiceLogMaxSize string
	GVisorServiceLogMaxFile int
	// DockerDataRoot is where the cell's Docker writes containers, volumes
	// and logs; under DiskMinFreeGB free there (0: no watchdog) the
	// docker-gvisor cell stops its claims (agent.DiskWatch).
	DockerDataRoot string
	DiskMinFreeGB  int
	// DiskPerRunFreeGB is the room one more Run needs above the floor (0:
	// one floor); DiskOuterPath a path on the filesystem under the
	// build-state volume's sparse file; DiskReadyGrace how long a claim that
	// turned ready is spared as a disk victim.
	DiskPerRunFreeGB int
	DiskOuterPath    string
	DiskReadyGrace   time.Duration
	// GVisorBrowserImage is the browser runner (browser-runner/, ADR-071),
	// by digest; empty: no browser runner, and browser probes are refused
	// with browser_unavailable as before.
	GVisorBrowserImage string
	// BrowserExplore enables native local exploration only after the product API upgrade.
	BrowserExplore bool
	// Preview serves preview URLs (docs/runtime/preview-urls.md): the cell
	// names the feature and dials the edge the hub's preview.tunnel names.
	Preview bool
	// ExercisedLines answers claim.exercised (feature exercisedLines): a
	// Run's Node services write V8 coverage on a driver that flushes it.
	ExercisedLines bool
	// GVisorObserverImage runs each claim's observer (cmd/observer at
	// /observer, by digest); GVisorObserverTLS is the directory with its
	// server certificate and the CA of -observer-cert.
	GVisorObserverImage string
	GVisorObserverTLS   string
	PolicyKey           string
	EgressBase          string
	EgressRecommended   bool
	EgressBuildHosts    string
	Dev                 bool
	AutoRenew           bool
	MetricsAddr         string
	// DevInsecureLocalDocker is one half of the local-docker gate (the other
	// is KODY_RUNTIME_DEV=1). Flag only, never from the file.
	DevInsecureLocalDocker bool
	// explicit names every flag the command line or the file set, whatever
	// its value (selectDriver refuses one another driver owns).
	explicit map[string]bool
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
	fs.StringVar(&s.Owner, "owner", "", "kodus | customer, as the hub registered the cell; empty: customer when cell register enrolled it (the owner file next to -cert), else kodus")
	fs.StringVar(&s.LocalCA, "local-ca", "", "the cell-local CA that signs the egress, resolver and injector control certificates: the agent verifies them with it only, and the hub with -ca only (they may share no key); required with -egress-control outside -dev")
	fs.StringVar(&s.Issuer, "issuer", "", "CA that signed the cell certificate, every renewal must chain to it (default issuer.pem next to -cert)")
	fs.StringVar(&s.Driver, "driver", "", "docker-gvisor | auto (docker-gvisor) | local-docker (dev only, no isolation) | fake (dev only, no isolation); required")
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
	fs.StringVar(&s.IsolationBackend, "isolation-backend", isolation.Auto, "docker-gvisor: the isolation backend its machines run under: auto (firecracker when /dev/kvm opens, a kit is given and microVMs run environments; gvisor otherwise) | gvisor | firecracker (microVMs; the cell does not start on a host without KVM, the verified kit (-firecracker-kit, -firecracker-kit-digest) or the host's prerequisites, and names which)")
	fs.StringVar(&s.HostPolicy, "host-policy", "auto", "docker-gvisor and firecracker: shared (the cell's sandboxes are many orgs': it refuses a host with SMT, KSM or swap on or a CPU vulnerability the kernel does not mitigate) | dedicated (one org's: it starts and reports them) | auto (shared on firecracker, dedicated on docker-gvisor until its hosts run one thread per core); either sends what it found to the hub")
	s.Sandbox.register(fs)
	s.Trust.register(fs)
	s.MicroVM.register(fs)
	fs.StringVar(&s.GVisorBuilderImage, "gvisor-builder-image", defaultBuilderImage, "docker-gvisor: rootless BuildKit by digest, which builds a project's build sections under gVisor on the claim network (default: the cell's own builder, builder-image/, whose overlay differ works under gVisor; the stock image walks the whole tree for each layer it exports); empty: a project that builds is refused")
	fs.BoolVar(&s.GVisorBuilderTrust, "gvisor-builder-trust", false, "docker-gvisor: the builder image is a build of builder-image/ under another digest (a local build of a new patch), so its RUN steps trust the cell CA; the cell's own pinned builder always does, under any name")
	fs.StringVar(&s.GVisorMirrorNPM, "gvisor-mirror-npm", "", "docker-gvisor: npm_config_registry every build gets as a build argument, the cell's read-only npm mirror (http://mirror.cell.internal:8080/npm/)")
	fs.StringVar(&s.GVisorMirrorPyPI, "gvisor-mirror-pypi", "", "docker-gvisor: PIP_INDEX_URL every build gets as a build argument, the cell's read-only PyPI mirror (http://mirror.cell.internal:8080/pypi/simple/)")
	fs.StringVar(&s.GVisorMirrorArtifacts, "gvisor-mirror-artifacts", "", "docker-gvisor: the root of the cell mirror's read-only artifacts (http://mirror.cell.internal:8080/artifacts/): every build gets PRISMA_ENGINES_MIRROR, MONGOMS_DOWNLOAD_MIRROR and FIREBASE_EMULATORS_MIRROR under it")
	fs.StringVar(&s.GVisorMirrorGoProxy, "gvisor-mirror-goproxy", "", "docker-gvisor: GOPROXY every build gets as a build argument, the cell's registry mirror (http://mirror.cell.internal:8080/go,off)")
	fs.StringVar(&s.GVisorMirrorRegistry, "gvisor-mirror-registry", "", "docker-gvisor: the registry mirror (host:port, e.g. mirror.cell.internal:8080) every build pulls docker.io images through")
	fs.BoolVar(&s.GVisorBuildState, "gvisor-build-state", false, "docker-gvisor: keep BuildKit's state per environment, written by the default branch's setup and read by every other build through a throwaway copy of it (needs root): a reflink clone when the work directory's filesystem has reflinks (XFS, btrfs), the kernel's overlay elsewhere, where a build that replaces a file of an earlier layer runs again without the state")
	fs.IntVar(&s.GVisorBuilderUID, "gvisor-builder-uid", 0, "docker-gvisor: the builder's uid on the host, owner of the directories it writes; required when Docker remaps user namespaces (userns-remap, rootless), else 1000, the rootless BuildKit image's user")
	fs.IntVar(&s.GVisorBuilderGID, "gvisor-builder-gid", 0, "docker-gvisor: the builder's gid on the host (see -gvisor-builder-uid)")
	fs.IntVar(&s.GVisorMaxImageGB, "gvisor-max-image-gb", 32, "docker-gvisor: the most one build may leave for the cell to load, its image tarball included; a larger image fails the boot as resources/image_too_large")
	fs.StringVar(&s.GVisorImageTransfer, "gvisor-image-transfer", "registry", "docker-gvisor: how a build's image reaches this Docker: registry (BuildKit pushes to a registry container of the build's own and this Docker pulls by digest, moving only the layers that changed; a build that does not seed the environment's registry and finds it never seeded sends a tarball instead; needs -gvisor-registry-image) or tarball (BuildKit writes the whole image, docker load reads it all, every build)")
	fs.StringVar(&s.GVisorRegistryImage, "gvisor-registry-image", defaultRegistryImage, "docker-gvisor: the distribution registry image (by digest) a -gvisor-image-transfer registry build pushes to")
	fs.IntVar(&s.GVisorRegistryKeepGB, "gvisor-registry-keep-gb", 40, "docker-gvisor: the most an environment's registry storage keeps (registry transfer); past it, it is wiped before the next build that seeds it")
	fs.StringVar(&s.GVisorContainerDisk, "gvisor-container-disk", "", "docker-gvisor: cap each holder's, builder's and compose service's writable layer (docker --storage-opt size=, compose storage_opt, e.g. 50G); only storage drivers that support it (overlay2 on XFS with pquota, btrfs, zfs) take it, others refuse the container; empty: no cap")
	fs.StringVar(&s.GVisorServiceLogMaxSize, "gvisor-service-log-max-size", "10m", "docker-gvisor: the most one log file of a compose service may hold (the local log driver's max-size, forced on every service; a smaller one the compose file sets is kept)")
	fs.IntVar(&s.GVisorServiceLogMaxFile, "gvisor-service-log-max-file", 3, "docker-gvisor: how many log files a compose service keeps (the local log driver's max-file)")
	fs.StringVar(&s.DockerDataRoot, "docker-data-root", "/var/lib/docker", "docker-gvisor: Docker's data root (daemon.json data-root), whose free space the disk watchdog reads")
	fs.IntVar(&s.DiskMinFreeGB, "disk-min-free-gb", 5, "docker-gvisor: under this much free space in -docker-data-root the cell stops its claims (a booting one fails as resources/cell_disk_full) before the disk fills for every tenant; under twice it on that disk or the work directory's, no workload is created and a running build stops (resources/disk_capacity), and the one claim whose disk grew the most is stopped (resources/disk_top_writer); 0: no watchdog")
	fs.IntVar(&s.DiskPerRunFreeGB, "disk-per-run-free-gb", 0, "docker-gvisor: the room one more Run needs above -disk-min-free-gb: under floor plus this, no workload is created, the watchdog's relief ladder runs (fstrim, build cache, reclaim) and a victim may be picked; 0: one floor, so twice the floor in all")
	fs.StringVar(&s.DiskOuterPath, "disk-outer-path", "", "docker-gvisor: a path on the OUTER filesystem, the one that holds the sparse file of the build-state volume; the watchdog works with the smaller free space of it and -docker-data-root, because the sparse file can be full while the inner filesystem shows room; empty: only the inner disk")
	fs.DurationVar(&s.DiskReadyGrace, "disk-ready-grace", agent.DefaultReadyGrace, "docker-gvisor: a claim that turned ready this recently is never the watchdog's victim, unless nothing else is left (logged as an alarm with the reason)")
	fs.StringVar(&s.GVisorBuildStateKeep, "gvisor-build-state-keep", "20GB", "docker-gvisor: what BuildKit's GC keeps in one environment's state")
	fs.StringVar(&s.GVisorBuildStateViewsDir, "gvisor-build-state-views-dir", "", "docker-gvisor: where each build's throwaway view of an environment's state goes (its overlay's upper, work and merged directories), on a disk that takes an overlay's upper layer; the states stay under the work directory. For a host whose work directory is on a FUSE disk (a boat host restored from a snapshot). Empty: next to the states")
	fs.IntVar(&s.GVisorBuildStateMinFreeGB, "gvisor-build-state-min-free-gb", 20, "docker-gvisor: below this much free disk, the environment states cheapest to keep (rebuild time, last use) are removed, then exported build caches")
	fs.StringVar(&s.GVisorBuildCacheRemote, "gvisor-build-cache-remote", "", "docker-gvisor: a local override, not needed when the pool has an image store (a claim whose grant has cache scope reads and, on main, writes the registry cache by itself): an OCI registry off the cell where the default branch's setup pushes its build cache and a build whose state and cache are gone pulls it, http(s)://host[:port]/<prefix> (plain HTTP only on loopback); empty: the build cache lives on the cell only")
	fs.StringVar(&s.GVisorBakeShare, "gvisor-bake-share", "", "docker-gvisor: the org's OCI registry of baked images, http(s)://host[:port]/<prefix> (plain HTTP only on loopback): each bake's images are pushed there and a claim on any cell of the org pulls one by the digest the hub recorded instead of building it; empty: bakes stay on the cell")
	fs.StringVar(&s.GVisorBakeSharePull, "gvisor-bake-share-pull", "", "docker-gvisor: where pulls of shared baked images go instead of -gvisor-bake-share, the same URL form (a read-only mirror or pull-through cache near the cell; pushes still go to -gvisor-bake-share, and a miss builds locally); empty: -gvisor-bake-share")
	fs.StringVar(&s.GVisorBakeShareAuthFile, "gvisor-bake-share-auth-file", "", "docker-gvisor: a file holding user:password for -gvisor-bake-share and -gvisor-bake-share-pull; empty: no credential")
	fs.StringVar(&s.GVisorBuildCacheRemoteAuthFile, "gvisor-build-cache-remote-auth-file", "", "docker-gvisor: a file holding user:password for -gvisor-build-cache-remote; empty: no credential")
	fs.StringVar(&s.GVisorMemLimit, "gvisor-mem-limit", "", "docker-gvisor: the memory limit of every service and build whose claim asks no size, as docker takes it (4g when empty; a large Go or JS build needs more)")
	fs.StringVar(&s.GVisorMemMax, "gvisor-mem-max", "", "docker-gvisor: the most memory one claim may ask for its builds and services (an environment's machine size), as docker takes it (empty: the memory the host lets the cell commit, MemTotal less -memory-reserve-mb, never below -gvisor-mem-limit); a claim that asks more is refused with size_unavailable")
	fs.BoolVar(&s.GVisorGoldenData, "gvisor-golden-data", true, "docker-gvisor: a round reset gives postgres a copy of the machine's first-boot data instead of a new initdb and seed, where nothing of the app ran before it (false: recreate every round)")
	fs.BoolVar(&s.GVisorWarmForkReset, "gvisor-warm-fork-reset", false, "docker-gvisor: while a Run's round runs, boot a second copy of its compose project (a warm spare: the machine's images, the bake's and golden data) beside it, so the next reset swaps it in instead of starting every service again; a spare boots only when the memory admission has room for the claim's memory again and is dropped the moment a claim needs it; any failure resets as before and keeps that machine's resets that way; needs -memory-admission and -gvisor-claim-limits off")
	fs.BoolVar(&s.GVisorToolLayer, "gvisor-toollayer", false, "docker-gvisor: keep tool layers: a custom agent's CLI is built once per org in a clean builder sandbox (no PR code, no secret, one registry host) and mounted read-only at /opt/kcli/<id> into that org's review sandboxes, which then skip the install; any miss or error installs as before. Needs -gvisor-sandbox-image, and announces toolLayers only when the cell can read that image's content digest")
	fs.IntVar(&s.GVisorToolLayerMaxMB, "gvisor-toollayer-max-mb", 256, "docker-gvisor with -gvisor-toollayer: the most one layer may hold, in MB; also the size of a builder's /opt/kcli tmpfs, in the builder's memory")
	fs.IntVar(&s.GVisorToolLayerOrgGB, "gvisor-toollayer-org-gb", 2, "docker-gvisor with -gvisor-toollayer: the most one org's layers may hold on the cell, in GB (the least recently mounted goes first)")
	fs.IntVar(&s.GVisorToolLayerBudgetGB, "gvisor-toollayer-budget-gb", 20, "docker-gvisor with -gvisor-toollayer: the most every org's layers may hold on the cell, in GB")
	fs.DurationVar(&s.GVisorHealthStart, "gvisor-health-start-interval", 0, "docker-gvisor: how often a starting service's healthcheck runs until it first passes, on every boot and round reset (0: 200ms; negative: as the compose file says)")
	fs.StringVar(&s.GVisorMemReady, "gvisor-mem-ready", "", "docker-gvisor under -gvisor-claim-limits: the least ceiling a ready claim keeps once its ceiling settles, as docker takes it (2g when empty, never above the claim's own memory); without claim limits a claim is counted at its memory, which its services share")
	fs.BoolVar(&s.MemoryAdmission, "memory-admission", true, "docker-gvisor and firecracker: take a claim only when its memory fits what the cell may commit (docker-gvisor: a claim at its memory, which its services share, settled lower once ready under claim limits; firecracker: a booting claim at its VMMs' memory.max, a ready one at its guests' and VMMs' memory); a claim that does not fit waits in the worker (ADR-070)")
	fs.IntVar(&s.MemoryReserveMB, "memory-reserve-mb", 1024, "memory the admission leaves to the host (Docker, the cell, the egress and mirror containers), in MB, from the host's MemTotal")
	fs.IntVar(&s.MemoryAllocatableMB, "memory-allocatable-mb", 0, "memory the cell may commit to claims, in MB; 0: the host's MemTotal less -memory-reserve-mb")
	fs.IntVar(&s.GVisorMaxBuilds, "gvisor-max-builds", 0, "docker-gvisor: how many image builds the cell runs at once, whichever claims they are for (each builder takes its claim's CPUs, 2 by default); a build past it waits for a slot (0: half the host's CPUs, at least one)")
	fs.IntVar(&s.GVisorClaimBuilds, "gvisor-claim-builds", 0, "docker-gvisor: how many of one claim's image builds run at once, at most 4 (0: 4); they share the claim's memory, each at least 2 GB, so a smaller claim runs fewer, and a setup that seeds the build state builds one at a time; the cell's -gvisor-max-builds still bounds every claim together")
	fs.IntVar(&s.GVisorCPUsMax, "gvisor-cpus-max", 0, "docker-gvisor: the most CPUs one claim may ask for its builds and services (0: the host's CPU count, never below the default 2)")
	fs.StringVar(&s.GVisorHelperImage, "gvisor-helper-image", "", "docker-gvisor: image with sh and cp that copies a bake's data volumes under gVisor, pinned by digest (repo@sha256:..., refused otherwise; busybox:1.36 pinned by digest when empty)")
	fs.StringVar(&s.GVisorObserverImage, "gvisor-observer-image", "", "docker-gvisor: the observer image (cmd/observer at /observer), by digest; each claim's observer runs it under gVisor on the claim network (-observer http)")
	fs.BoolVar(&s.Preview, "preview", false, "serve preview URLs: name the preview feature, dial the preview edge with the cell's certificate when the hub asks, and pass a preview claim's streams to its observer (the edge's tunnel certificate must chain to -ca, the hub CA)")
	fs.BoolVar(&s.ExercisedLines, "exercised-lines", true, "count which of a PR's changed lines its Node services ran (claim.exercised): a Run's Node services get NODE_V8_COVERAGE and a SIGUSR2 flush preload on docker-gvisor, writing a tmpfs the cell mounts over the claim's coverage directory (65 MiB, 256 files; a claim it cannot cap is not instrumented); other drivers answer unsupported_driver")
	fs.BoolVar(&s.BrowserExplore, "browser-explore", false, "docker-gvisor: enable local agent-browser exploration with a compatible pinned browser image; upgrade the product planner API first")
	fs.StringVar(&s.GVisorBrowserImage, "gvisor-browser-image", "", "docker-gvisor: the browser runner image (apps/runtime-cell/browser-runner), by digest; each browser probe round runs it under gVisor on the claim network (ADR-071)")
	fs.StringVar(&s.GVisorObserverTLS, "gvisor-observer-tls-dir", "/etc/kodus/cell/observer-server", "docker-gvisor: cert.pem and key.pem of the observers (for -observer-server-name) and ca.pem, the CA of -observer-cert; mounted read-only into each observer")
	fs.StringVar(&s.GVisorEgressContainer, "gvisor-egress-container", "", "docker-gvisor: the egress container (proxy and resolver) that joins every claim network; without it a claim has no way out")
	fs.StringVar(&s.PolicyKey, "policy-key", "/etc/kodus/cell/policy.key.pem", "ed25519 key that signs egress policies")
	fs.StringVar(&s.EgressBase, "egress-allow", "", "comma-separated hosts every VM may reach (mirror)")
	fs.StringVar(&s.EgressBuildHosts, "egress-build-passthrough", "", "comma-separated hosts an image build may reach uninspected over TLS, on top of the recommended list's read-only CDNs and the owners' full-access approvals: the operator's own decision (a build's RUN steps cannot be inspected; every other host is refused to it)")
	fs.BoolVar(&s.EgressRecommended, "egress-recommended", true, "apply the Kodus recommended list (docs/runtime/egress-allowlist.md §7) to every claim of an org that keeps it on: its hosts join the allowlist on the inspected tier (GET and HEAD under their paths only; over plain HTTP from every machine, over TLS through the injector from the machines the cell gave its CA, which needs -cell-ca-cert). Needs an egress, resolver and injector of this release or later")
	fs.BoolVar(&s.AutoRenew, "auto-renew", true, "renew the client certificate over mTLS (POST /cells/renew) when a third of its validity is left")
	fs.BoolVar(&s.Dev, "dev", false, "local development: allow extraction without a network namespace, the fake driver, and a personal access token as the download token (kept, not revoked)")
	// 9466: the Runtime's metrics ports on one host are hub 9464, worker
	// 9465, cell 9466 (docker-compose.dev.yml publishes the first two).
	fs.StringVar(&s.MetricsAddr, "metrics-addr", "127.0.0.1:9466", "address of /metrics (Prometheus text format); off disables it")
	fs.BoolVar(&s.DevInsecureLocalDocker, "dev-insecure-local-docker", false, "allow the local-docker driver (NO isolation; also needs KODY_RUNTIME_DEV=1)")
}

// parseSettings parses the flags, then sets from the config file each flag
// the command line did not give, marking it explicitly set.
func parseSettings(fs *flag.FlagSet, args []string) (settings, error) {
	var s settings
	s.register(fs)
	if err := fs.Parse(args); err != nil {
		return s, err
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	s.explicit = set
	if s.Config != "" {
		if err := applyFile(fs, s.Config, set); err != nil {
			return s, err
		}
	}
	if value, present := os.LookupEnv("KODUS_CELL_MAX_CLAIM_STEPS"); present && !set["max-claim-steps"] {
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
		if s.GVisorClaimLimitBackend == "cgroupfs" && (s.GVisorClaimCgroupRoot == "" || s.GVisorClaimRootSlice != "") {
			return s, fmt.Errorf("cgroupfs needs only a delegated cgroup root")
		}
		if s.GVisorClaimLimitBackend == "systemd" && (s.GVisorClaimRootSlice == "" || s.GVisorClaimCgroupRoot != "") {
			return s, fmt.Errorf("systemd needs only an explicit owned root slice")
		}
	}
	if s.StateDir == "" {
		s.StateDir = filepath.Join(s.WorkDir, "state")
	}
	if s.Issuer == "" {
		s.Issuer = filepath.Join(filepath.Dir(s.Cert), "issuer.pem")
	}
	if s.Owner == "" {
		s.Owner = enrolledOwner(s.Cert)
	}
	if s.Owner != string(protocol.CellOwnerKodus) && s.Owner != string(protocol.CellOwnerCustomer) {
		return s, fmt.Errorf("owner %q: kodus or customer", s.Owner)
	}
	return s, nil
}

// ownerFile is what cell register writes next to the certificate: the hub
// registers every cell that redeems a token as a customer cell, and the hello
// must say so (the hub refuses a hello whose owner is not the registration's).
func ownerFile(cert string) string { return filepath.Join(filepath.Dir(cert), "owner") }

// boundKeyFile is what cell register -bootstrap writes next to the
// certificate for a fleet host: the key the hub bound the host's token to,
// as the hub answered it over the verified TLS connection.
func boundKeyFile(cert string) string { return filepath.Join(filepath.Dir(cert), "bound-key") }

// fleetBoundKey matches the keys a fleet host is bound to and captures the org:
// run:<org>/<run>, template:<org>/<env>, an environment's own setup's
// setup:<org>/<hash of the setup key>, and a suite shard's
// suite:<org>/<suiteRun>/<shard> (the listing, each shard, the fresh and main
// re-run hosts), which starts from the environment template like a Run host.
var fleetBoundKey = regexp.MustCompile(`^(?:(?:run|template|setup):([^/\s:]{1,128})/[^/\s]{1,128}|suite:([^/\s:]{1,128})/[^/\s]{1,128}/[0-9]{1,4})$`)

// bakeAdoptOrg is the org whose bake a host made from a template may adopt,
// or "" (nothing is adopted). Only a fleet host (its seal unit is installed,
// which nothing but cell-host.sh install --fleet-bootstrap does), enrolled by
// a fleet token (owner kodus), whose hub-given bound key names an org.
func bakeAdoptOrg(sealUnit, cert, owner string) string {
	if owner != string(protocol.CellOwnerKodus) {
		return ""
	}
	if _, err := os.Stat(sealUnit); err != nil {
		return ""
	}
	b, err := os.ReadFile(boundKeyFile(cert))
	if err != nil || len(b) > 512 {
		return ""
	}
	m := fleetBoundKey.FindStringSubmatch(strings.TrimSpace(string(b)))
	if m == nil {
		return ""
	}
	if m[1] != "" {
		return m[1]
	}
	return m[2]
}

// enrolledOwner is the owner cell register wrote, or kodus (a managed cell,
// whose certificate is issued out of band).
func enrolledOwner(cert string) string {
	b, err := os.ReadFile(ownerFile(cert))
	if err == nil && strings.TrimSpace(string(b)) == string(protocol.CellOwnerCustomer) {
		return string(protocol.CellOwnerCustomer)
	}
	return string(protocol.CellOwnerKodus)
}

// readAuthFile is a credential file's first line, or "" with no path.
func readAuthFile(path string) (string, error) {
	if path == "" {
		return "", nil
	}
	b, err := os.ReadFile(path) //nolint:gosec // G304: path is the operator's flag
	if err != nil {
		return "", err
	}
	line, _, _ := strings.Cut(string(b), "\n")
	return strings.TrimSpace(line), nil
}

// cellStateDir is the -state-dir the cell runs with under config (none: its
// default), resolved by the cell's own settings: where the agent keeps
// hub-protocol.state, which `cell update` reads (internal/cellupdate). A
// config the cell refuses is an error, not a default.
func cellStateDir(config string) (string, error) {
	fs := flag.NewFlagSet("cell", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var args []string
	if config != "" {
		args = []string{"-config", config}
	}
	st, err := parseSettings(fs, args)
	if err != nil {
		return "", err
	}
	return st.StateDir, nil
}

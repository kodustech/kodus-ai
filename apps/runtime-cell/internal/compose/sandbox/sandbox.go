// Package sandbox is the gVisor cell's compose allowlist (docs §4b, Inc. 4,
// S-10). Root on a shared host is the threat, so the PR's compose file is
// checked, and rewritten, before any container starts:
//
//   - Apply reads the file the PR wrote. Every key is on an allowlist (a new
//     compose feature is closed by default), and every path the host reads
//     is inside the checkout through real directories only. Then it forces
//     what the cell decides: runsc, no new privileges, resource limits, the
//     cell's labels, the claim's network, read-only binds, no published
//     ports.
//   - VerifyCanonical reads what docker compose will actually run (the
//     output of `compose config --format json`) and checks the same
//     invariants again, so YAML tricks, merges or defaults the first reader
//     did not model cannot slip past it.
//
// What it refuses outright: building (a Dockerfile's RUN steps would run in
// the host's BuildKit, under runc and outside the claim network: the cell
// runs images its own builder made), interpolation outside the few fields
// meant for the container's shell (compose reads ${VAR} from its own
// environment), named volumes that are not the project's own, and every
// host-sharing option.
package sandbox

import (
	"errors"
	"fmt"
	"maps"
	"net/netip"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/yamlbound"
)

// Violation is one refused part of the compose file.
type Violation struct {
	Path   string
	Reason string
}

func (v Violation) String() string { return v.Path + ": " + v.Reason }

// RefusedError lists every violation; the compose file is refused whole,
// and the Blocker offers the VM cell instead of only saying no.
type RefusedError struct{ Violations []Violation }

func (e *RefusedError) Error() string {
	parts := make([]string, len(e.Violations))
	for i, v := range e.Violations {
		parts[i] = v.String()
	}
	return "compose refused: " + strings.Join(parts, "; ")
}

// ClaimNetworkKey is the key the claim's network has in the rewritten file.
const ClaimNetworkKey = "kodus-claim"

type Options struct {
	// ProjectDir is the checkout: relative host paths are read from it, and
	// every host path must resolve inside it, or inside Root when set.
	ProjectDir string
	// Root is the workspace of a claim of several repositories (ws/, with
	// ProjectDir one of its directories): a host path may then name another
	// repository's directory (../<alias>), and nothing outside Root. Empty:
	// ProjectDir is the root.
	Root string
	// Project is the compose project name (named volumes become
	// <project>_<name>).
	Project string
	Labels  map[string]string
	Runtime string // runsc
	// PidsLimit, MemLimit ("4g") and CPUs ("2") replace whatever the file
	// says; empty values leave the file's own (PidsLimit defaults to 2048).
	PidsLimit int
	MemLimit  string
	CPUs      string
	// CgroupParent is the trusted aggregate parent selected by the cell.
	// A repository's cgroup_parent remains forbidden, even if it matches.
	CgroupParent string
	// Network is the claim's network, created by PrepareClaim.
	Network string
	// Subnet is the claim network's subnet. When set, each service gets a
	// fixed address in it (ServiceAddresses) and every service name in
	// extra_hosts.
	Subnet netip.Prefix
	// Resolv is the cell's resolv.conf for the claim, a file the cell owns
	// naming the cell resolver alone; mounted read-only on every service.
	Resolv string
	// Decoy is the claim's decoy credentials file (a Run's canary, ADR-043),
	// a file the cell owns; mounted read-only at DecoyTarget on every
	// service. Empty: none.
	Decoy string
	// Trust are the cell's trust files (machinetrust: the public roots and
	// the cell CA, and the cell CA alone), set for a claim with org secrets:
	// mounted read-only on every service at machinetrust.BundleTarget and
	// CellCATarget, with machinetrust.Env in every service's environment,
	// over what the file or the recipe set under those names. Zero: none,
	// and the services keep their own trust.
	Trust machinetrust.Files
	// Built are the images the cell built for services with a build
	// section (Builds), by service. Their build sections give way to these
	// images; any other build section is refused.
	Built map[string]string
	// HealthStartInterval probes each starting service this often until its
	// healthcheck first passes (fastStartHealth); zero leaves healthchecks
	// as written. The daemon must have API 1.44 (Docker 25).
	HealthStartInterval time.Duration
	// HostEnv names the variables of the environment docker compose runs
	// with: compose interpolates $NAME and ${NAME} from it, so none of them
	// may be named, not even where interpolation is otherwise allowed. PATH,
	// HOME and every DOCKER_, COMPOSE_ and XDG_ name are refused whatever it
	// holds.
	HostEnv []string
	// DataVolumes mounts a project volume of the cell's at a path of a
	// service, by service, then target, to the volume's key: where the
	// image keeps its data in an anonymous volume, a reset can then give
	// the service a volume the cell filled (the driver's golden data). The
	// key must be new to the file and the target unmounted.
	DataVolumes map[string]map[string]string
	// LogMaxSize and LogMaxFile bound every service's logs (DefaultLogMaxSize
	// and DefaultLogMaxFile when empty or zero): each service logs through
	// the local driver with at most this many files of at most this size,
	// whatever the file says, so no service fills the Docker disk with its
	// logs. A smaller bound the file asks for is kept.
	LogMaxSize string
	LogMaxFile int
	// DiskSize caps every service's writable layer (storage_opt size, "20G"),
	// as dockergvisor's ContainerDiskSize does the holder's and the
	// builder's. Only some storage drivers take it (overlay2 on XFS mounted
	// with pquota, btrfs, zfs); the daemon refuses the container on the
	// others. Empty: no cap.
	DiskSize string
}

// The log bound of a service when the cell sets none: 30 MiB of logs.
const (
	DefaultLogMaxSize = "10m"
	DefaultLogMaxFile = 3
)

// logBound is the cell's log bound: the size as written, in bytes, and the
// number of files.
func (o Options) logBound() (string, int64, int, error) {
	size, files := o.LogMaxSize, o.LogMaxFile
	if size == "" {
		size = DefaultLogMaxSize
	}
	if files == 0 {
		files = DefaultLogMaxFile
	}
	b, ok := parseLogSize(size)
	if !ok || files < 1 {
		return "", 0, 0, fmt.Errorf("sandbox: log bound %q x %d is not a size and a file count", size, files)
	}
	return size, b, files, nil
}

var logSizeRE = regexp.MustCompile(`^(?i)([0-9]{1,12})([kmg]?)b?$`)

// parseLogSize reads a log driver's max-size ("10m", "512k", "1g", bytes),
// in units of 1024: never less than the daemon reads (it counts 1000), so
// a size taken as within the bound is.
func parseLogSize(s string) (int64, bool) {
	m := logSizeRE.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || n <= 0 {
		return 0, false
	}
	switch strings.ToLower(m[2]) {
	case "k":
		n <<= 10
	case "m":
		n <<= 20
	case "g":
		n <<= 30
	}
	return n, true
}

// logFiles reads a log driver's max-file, a string or a number.
func logFiles(v any) (int, bool) {
	switch x := v.(type) {
	case int:
		return x, true
	case float64:
		return int(x), x == float64(int(x))
	case string:
		n, err := strconv.Atoi(x)
		return n, err == nil
	}
	return 0, false
}

// serviceLogging is the logging every service runs with: the local driver
// within the cell's bound, or the file's own bound when it is smaller.
func serviceLogging(v any, size string, sizeBytes int64, files int) map[string]any {
	if l, ok := v.(map[string]any); ok {
		opts, _ := l["options"].(map[string]any)
		if s, ok := opts["max-size"].(string); ok {
			if b, ok := parseLogSize(s); ok && b <= sizeBytes {
				size = s
			}
		}
		if f, ok := logFiles(opts["max-file"]); ok && f >= 1 && f <= files {
			files = f
		}
	}
	return map[string]any{"driver": "local", "options": map[string]any{"max-size": size, "max-file": strconv.Itoa(files)}}
}

// Keys a service may use. Anything else is refused: the list is an
// allowlist, not a denylist.
var serviceKeys = map[string]bool{
	"image": true, "command": true, "entrypoint": true, "environment": true,
	"env_file": true, "ports": true, "expose": true, "depends_on": true, "healthcheck": true,
	"volumes": true, "working_dir": true, "user": true, "restart": true, "labels": true,
	"tmpfs": true, "init": true, "stop_signal": true, "stop_grace_period": true, "deploy": true,
	"mem_limit": true, "cpus": true, "hostname": true, "platform": true, "profiles": true,
	"cap_drop": true, "read_only": true, "shm_size": true, "ulimits": true, "logging": true,
	"networks": true, "pull_policy": true,
}

// Why the dangerous keys are refused, for the Blocker message.
var refusedKeys = map[string]string{
	"build":               "the gVisor cell runs images its builder made: a build here would run the Dockerfile in the host's BuildKit, outside gVisor and the claim network",
	"privileged":          "privileged containers reach the host",
	"cap_add":             "added capabilities reach the host",
	"devices":             "host devices",
	"device_cgroup_rules": "host devices",
	"network_mode":        "host or another container's network",
	"pid":                 "host or another container's pid namespace",
	"ipc":                 "host or another container's ipc namespace",
	"uts":                 "host uts namespace",
	"userns_mode":         "host user namespace",
	"cgroup_parent":       "host cgroup",
	"cgroup":              "host cgroup",
	"runtime":             "the cell chooses the runtime (runsc)",
	"security_opt":        "the cell sets the security options",
	"sysctls":             "kernel parameters",
	"volumes_from":        "another container's mounts",
	"extra_hosts":         "name resolution goes through the cell resolver",
	"dns":                 "name resolution goes through the cell resolver",
	"dns_search":          "name resolution goes through the cell resolver",
	"dns_opt":             "name resolution goes through the cell resolver",
	"container_name":      "names are per claim project",
	"oom_kill_disable":    "host memory protection",
	"oom_score_adj":       "host memory protection",
	"group_add":           "host groups",
	"isolation":           "the cell chooses the isolation",
	"external_links":      "containers outside the project",
	"links":               "use depends_on and the project network",
	"configs":             "files outside the project",
	"secrets":             "secrets come from the cell injector, not the compose file",
	"mac_address":         "network identity",
	"storage_opt":         "host storage driver",
	"extends":             "files outside the one the cell checked",
	"include":             "files outside the one the cell checked",
}

// topKeys are the top-level keys the cell takes. Top-level secrets name the
// org secrets a build asks for (build_secrets.go) and leave the file once
// read: no service mounts them.
var topKeys = map[string]bool{"services": true, "volumes": true, "networks": true, "name": true, "version": true, "secrets": true}

// interpolated are the service keys meant for the container's shell ($$HOME
// in a command). Everywhere else a '$' is refused: the value the cell checks
// must be the value compose uses. Here compose still interpolates a single
// '$' from its own environment, so a name that environment holds is refused
// (noHostEnv); any other resolves to its default or to nothing, as compose
// says.
var interpolated = map[string]bool{"environment": true, "command": true, "entrypoint": true, "healthcheck": true}

var loggingOptions = map[string]bool{"max-size": true, "max-file": true, "compress": true, "mode": true, "max-buffer-size": true}

type checker struct {
	// addrs are the services' fixed addresses (Options.Subnet).
	addrs map[string]netip.Addr
	o     Options
	v     []Violation
}

func (c *checker) add(path, reason string) { c.v = append(c.v, Violation{path, reason}) }

// Apply parses the compose file, refuses what the allowlist does not cover,
// and returns the file the cell will run.
func Apply(raw []byte, o Options) ([]byte, error) {
	if err := claimlimits.ValidateDockerParent(o.CgroupParent); err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}
	if o.ProjectDir == "" || o.Runtime == "" || o.Project == "" {
		return nil, errors.New("sandbox: project dir, project and runtime required")
	}
	if o.Root != "" {
		if _, err := ResolveWithin(o.Root, o.ProjectDir, "."); err != nil {
			return nil, fmt.Errorf("sandbox: %w", err)
		}
	}
	if o.PidsLimit == 0 {
		o.PidsLimit = 2048
	}
	if _, _, _, err := o.logBound(); err != nil {
		return nil, err
	}
	c := &checker{o: o}
	doc, err := c.parse(raw)
	if err != nil {
		return nil, err
	}
	for _, k := range sortedKeys(doc) {
		if strings.HasPrefix(k, "x-") {
			delete(doc, k) // extensions are anchors; their content was merged
			continue
		}
		if !topKeys[k] {
			c.refuseKey(k, k)
		}
	}
	services, _ := doc["services"].(map[string]any)
	if len(services) == 0 {
		c.add("services", "no services")
	}
	c.topSecrets(doc["secrets"])
	declared := c.checkVolumes(doc["volumes"])
	c.checkNetworks(doc["networks"])
	for _, name := range sortedKeys(services) {
		c.checkService(name, services[name], declared)
	}
	if len(c.v) > 0 {
		return nil, &RefusedError{Violations: c.v}
	}
	if o.Subnet.IsValid() {
		addrs, err := ServiceAddresses(sortedKeys(services), o.Subnet)
		if err != nil {
			return nil, err
		}
		c.addrs = addrs
	}
	for _, name := range sortedKeys(services) {
		svc, ok := services[name].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("sandbox: service %s is not a mapping", name)
		}
		c.rewriteService(name, svc)
	}
	if err := addDataVolumes(doc, services, o.DataVolumes); err != nil {
		return nil, err
	}
	delete(doc, "name")    // the cell names the project (-p)
	delete(doc, "secrets") // read by Builds; the builds are gone from the file
	if o.Network != "" {
		doc["networks"] = map[string]any{ClaimNetworkKey: map[string]any{"name": o.Network, "external": true}}
	}
	return yaml.Marshal(doc)
}

// parse reads the compose file the one way both Apply and Builds read it:
// YAML tags compose gives a meaning this reader does not are recorded as
// violations (checkTags), anchors and merges are resolved.
func (c *checker) parse(raw []byte) (map[string]any, error) {
	// Bounded as the files it came from (yamlbound): the cell parses it in
	// its own process.
	node, err := yamlbound.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("compose: %w", err)
	}
	c.checkTags(node, "")
	var doc map[string]any
	if err := node.Decode(&doc); err != nil {
		return nil, fmt.Errorf("compose: %w", err)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	return doc, nil
}

// checkTags refuses YAML tags compose gives a meaning the cell's reader
// does not (!reset, !override) and every other custom tag.
func (c *checker) checkTags(n *yaml.Node, path string) {
	switch n.Tag {
	case "", "!!str", "!!int", "!!bool", "!!float", "!!null", "!!map", "!!seq", "!!merge", "!!timestamp":
	default:
		if n.Kind != yaml.DocumentNode {
			c.add(strings.TrimPrefix(path, "."), fmt.Sprintf("YAML tag %s", n.Tag))
		}
	}
	for i, ch := range n.Content {
		p := path
		if n.Kind == yaml.MappingNode && i%2 == 1 {
			p = path + "." + n.Content[i-1].Value
		}
		c.checkTags(ch, p)
	}
}

func (c *checker) refuseKey(path, key string) {
	if r, ok := refusedKeys[key]; ok {
		c.add(path, r)
	} else {
		c.add(path, "not in the allowlist")
	}
}

// noInterpolation refuses any '$' that is not an escaped "$$".
func (c *checker) noInterpolation(v any, path string) {
	switch x := v.(type) {
	case string:
		if strings.Contains(strings.ReplaceAll(x, "$$", ""), "$") {
			c.add(path, "variable interpolation (compose would read it from the cell's environment)")
		}
	case map[string]any:
		for _, k := range sortedKeys(x) {
			if strings.Contains(k, "$") {
				c.add(path+"."+k, "variable interpolation in a key")
			}
			c.noInterpolation(x[k], path+"."+k)
		}
	case []any:
		for i, e := range x {
			c.noInterpolation(e, fmt.Sprintf("%s[%d]", path, i))
		}
	}
}

// variable is a name compose interpolates: $NAME or ${NAME, with ${...}'s
// default or error text read again for the names it holds.
var variable = regexp.MustCompile(`\$(?:\{([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))`)

// hostEnvPrefixes are names compose's own environment may hold whatever
// HostEnv says: the daemon's and compose's settings, the user's runtime dir.
var hostEnvPrefixes = []string{"DOCKER_", "COMPOSE_", "XDG_"}

func (c *checker) hostEnv(name string) bool {
	if name == "PATH" || name == "HOME" || slices.Contains(c.o.HostEnv, name) {
		return true
	}
	for _, p := range hostEnvPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// noHostEnv refuses, where a single '$' is interpolated, a variable that
// compose's own environment holds (an escaped "$$" is the container's).
func (c *checker) noHostEnv(v any, path string) {
	switch x := v.(type) {
	case string:
		for _, m := range variable.FindAllStringSubmatch(strings.ReplaceAll(x, "$$", ""), -1) {
			if name := m[1] + m[2]; c.hostEnv(name) {
				c.add(path, fmt.Sprintf("interpolates $%s, which compose would read from the cell's environment (write $$%s for the container's)", name, name))
			}
		}
	case map[string]any:
		for _, k := range sortedKeys(x) {
			c.noHostEnv(k, path+"."+k)
			c.noHostEnv(x[k], path+"."+k)
		}
	case []any:
		for i, e := range x {
			c.noHostEnv(e, fmt.Sprintf("%s[%d]", path, i))
		}
	}
}

// checkVolumes allows project volumes on the local driver with labels and
// nothing else: a name (any existing volume on the host, another claim's
// included), external in any spelling, driver options (which bind host
// paths). It returns the declared names.
func (c *checker) checkVolumes(v any) map[string]bool {
	declared := map[string]bool{}
	vols, _ := v.(map[string]any)
	if v != nil && vols == nil {
		c.add("volumes", "not a mapping")
	}
	for _, name := range sortedKeys(vols) {
		declared[name] = true
		path := "volumes." + name
		c.noInterpolation(vols[name], path)
		m, _ := vols[name].(map[string]any)
		if m == nil {
			if vols[name] != nil {
				c.add(path, "not a mapping")
			}
			continue
		}
		for _, k := range sortedKeys(m) {
			switch k {
			case "driver":
				if d, _ := m[k].(string); d != "local" {
					c.add(path+".driver", "only the local driver")
				}
			case "labels":
				c.checkLabels(m[k], path+".labels")
			case "name":
				c.add(path+".name", "a named volume can be any volume on the host; project volumes only")
			case "external":
				c.add(path+".external", "external volumes live outside the project")
			case "driver_opts":
				c.add(path+".driver_opts", "driver options can bind host paths")
			default:
				c.add(path+"."+k, "not in the volume allowlist")
			}
		}
	}
	return declared
}

// checkNetworks: the file's networks are replaced by the claim's; one that
// asks for more than a plain bridge is refused rather than dropped.
func (c *checker) checkNetworks(v any) {
	nets, _ := v.(map[string]any)
	for _, name := range sortedKeys(nets) {
		path := "networks." + name
		c.noInterpolation(nets[name], path)
		m, _ := nets[name].(map[string]any)
		if m == nil {
			continue
		}
		if _, ok := m["external"]; ok {
			c.add(path, "external networks reach other projects")
		}
		if d, ok := m["driver"]; ok && d != "bridge" {
			c.add(path+".driver", "only bridge networks")
		}
		if _, ok := m["driver_opts"]; ok {
			c.add(path+".driver_opts", "driver options")
		}
		if _, ok := m["name"]; ok {
			c.add(path+".name", "networks are per claim")
		}
	}
}

func (c *checker) checkLabels(v any, path string) {
	var keys []string
	switch l := v.(type) {
	case map[string]any:
		keys = sortedKeys(l)
	case []any:
		for _, item := range l {
			s, _ := item.(string)
			k, _, _ := strings.Cut(s, "=")
			keys = append(keys, k)
		}
	case nil:
	default:
		c.add(path, "neither a mapping nor a list")
	}
	for _, k := range keys {
		if strings.HasPrefix(k, "kodus.") || strings.HasPrefix(k, "kodus:") {
			c.add(path+"."+k, "the cell's labels are the cell's (a forged one could move what the sweep reads)")
		}
	}
}

func (c *checker) checkService(name string, v any, declared map[string]bool) {
	path := "services." + name
	svc, _ := v.(map[string]any)
	if svc == nil {
		c.add(path, "not a mapping")
		return
	}
	built := c.o.Built[name] != ""
	for _, k := range sortedKeys(svc) {
		if k == "build" && built {
			continue // Builds checked it; the cell's image replaces it
		}
		if !serviceKeys[k] {
			c.refuseKey(path+"."+k, k)
			continue
		}
		if interpolated[k] {
			c.noHostEnv(svc[k], path+"."+k)
		} else {
			c.noInterpolation(svc[k], path+"."+k)
		}
	}
	c.checkCapDrop(svc["cap_drop"], path+".cap_drop")
	if c.o.Trust.Set() {
		if _, err := environmentMap(svc["environment"]); err != nil {
			c.add(path+".environment", err.Error())
		}
	}
	if pp, _ := svc["pull_policy"].(string); pp == "build" && !built {
		c.add(path+".pull_policy", "builds are refused")
	}
	if vols, ok := svc["volumes"].([]any); ok {
		for i, vol := range vols {
			c.checkMount(vol, fmt.Sprintf("%s.volumes[%d]", path, i), declared)
		}
	} else if svc["volumes"] != nil {
		c.add(path+".volumes", "not a list")
	}
	switch ef := svc["env_file"].(type) {
	case nil:
	case string:
		c.hostPath(ef, path+".env_file", false)
	case []any:
		for i, f := range ef {
			p := fmt.Sprintf("%s.env_file[%d]", path, i)
			switch x := f.(type) {
			case string:
				c.hostPath(x, p, false)
			case map[string]any:
				s, _ := x["path"].(string)
				c.hostPath(s, p, false)
			default:
				c.add(p, "unknown env_file syntax")
			}
		}
	default:
		c.add(path+".env_file", "unknown env_file syntax")
	}
	if d, ok := svc["deploy"].(map[string]any); ok {
		c.checkDeploy(d, path+".deploy")
	} else if svc["deploy"] != nil {
		c.add(path+".deploy", "not a mapping")
	}
	if l, ok := svc["logging"].(map[string]any); ok {
		if drv, _ := l["driver"].(string); drv != "" && drv != "json-file" && drv != "local" {
			c.add(path+".logging.driver", "logs stay on the host")
		}
		opts, _ := l["options"].(map[string]any)
		for _, k := range sortedKeys(opts) {
			if !loggingOptions[k] {
				c.add(path+".logging.options."+k, "not in the logging allowlist")
			}
		}
	}
	c.checkLabels(svc["labels"], path+".labels")
}

// checkDeploy allows only resources limits and reservations of cpus,
// memory and pids: a reservation of devices is a GPU passed through.
func (c *checker) checkDeploy(d map[string]any, path string) {
	for _, k := range sortedKeys(d) {
		if k != "resources" {
			c.add(path+"."+k, "only deploy.resources")
			continue
		}
		res, _ := d[k].(map[string]any)
		for _, rk := range sortedKeys(res) {
			if rk != "limits" && rk != "reservations" {
				c.add(path+".resources."+rk, "only limits and reservations")
				continue
			}
			m, _ := res[rk].(map[string]any)
			for _, mk := range sortedKeys(m) {
				if mk != "cpus" && mk != "memory" && mk != "pids" {
					c.add(path+".resources."+rk+"."+mk, "host devices and generic resources are refused")
				}
			}
		}
	}
}

// checkMount allows anonymous and project volumes, tmpfs, and binds of real
// directories or files inside the checkout. Binds become read-only, so no
// container can plant a symlink in the checkout for a later bind to follow.
func (c *checker) checkMount(vol any, path string, declared map[string]bool) {
	if t := mountTarget(vol); t == ResolvTarget || t == "/etc/hosts" {
		c.add(path, "name resolution is the cell's: "+t+" cannot be mounted")
		return
	} else if t == DecoyTarget || t == machinetrust.Dir || strings.HasPrefix(t, machinetrust.Dir+"/") {
		c.add(path, t+" is the cell's")
		return
	}
	switch x := vol.(type) {
	case string:
		parts := strings.Split(x, ":")
		switch {
		case len(parts) == 1:
			return // anonymous volume
		case len(parts) > 3:
			c.add(path, "unknown volume syntax")
			return
		}
		src := parts[0]
		if len(parts) == 3 {
			c.checkMountMode(parts[2], path)
		}
		if isPath(src) {
			c.hostPath(src, path, true)
		} else if !declared[src] {
			c.add(path, fmt.Sprintf("volume %q is not one of the project's", src))
		}
	case map[string]any:
		typ, _ := x["type"].(string)
		src, _ := x["source"].(string)
		for _, k := range sortedKeys(x) {
			switch k {
			case "type", "source", "target", "read_only", "consistency":
			case "bind":
				b, _ := x[k].(map[string]any)
				for _, bk := range sortedKeys(b) {
					if bk != "create_host_path" || b[bk] == true {
						c.add(path+".bind."+bk, "bind options are the cell's")
					}
				}
			case "volume":
				vo, _ := x[k].(map[string]any)
				for _, vk := range sortedKeys(vo) {
					if vk != "nocopy" && vk != "subpath" {
						c.add(path+".volume."+vk, "not in the volume allowlist")
					}
				}
			case "tmpfs":
			default:
				c.add(path+"."+k, "not in the mount allowlist")
			}
		}
		switch typ {
		case "volume":
			if src != "" && !declared[src] {
				c.add(path, fmt.Sprintf("volume %q is not one of the project's", src))
			}
		case "tmpfs":
		case "bind":
			c.hostPath(src, path, true)
		default:
			c.add(path+".type", fmt.Sprintf("volume type %q", typ))
		}
	default:
		c.add(path, "unknown volume syntax")
	}
}

func (c *checker) checkMountMode(mode, path string) {
	for _, m := range strings.Split(mode, ",") {
		switch m {
		case "ro", "rw", "nocopy", "":
		default:
			// z/Z relabel host files; propagation modes share mounts back.
			c.add(path, fmt.Sprintf("mount option %q", m))
		}
	}
}

func isPath(s string) bool {
	return strings.HasPrefix(s, "/") || strings.HasPrefix(s, ".") || strings.HasPrefix(s, "~") || strings.Contains(s, "/") || strings.Contains(s, "$")
}

// hostPath refuses a host path that is not inside the checkout through real
// directories: it must exist now (a path created later could be a symlink a
// container planted), and no step of it may be a symlink. dir is true for a
// bind mount (a file or a directory); env files must be regular files.
func (c *checker) hostPath(p, path string, bind bool) {
	if _, err := c.o.resolve(p); err != nil {
		c.add(path, err.Error())
		return
	}
	if !bind {
		abs, _ := c.o.resolve(p)
		if fi, err := os.Lstat(abs); err != nil || !fi.Mode().IsRegular() {
			c.add(path, "env file is not a regular file")
		}
	}
}

// resolve is the absolute path of the host path p, read from the project
// directory, after checking it stays inside the root (ResolveWithin).
func (o Options) resolve(p string) (string, error) {
	if o.Root == "" {
		return ResolveInside(o.ProjectDir, p)
	}
	return ResolveWithin(o.Root, o.ProjectDir, p)
}

// ResolveInside returns the absolute path of p (relative to root) after
// checking that it exists inside root and that no component, from root
// down, is a symlink.
func ResolveInside(root, p string) (string, error) {
	return ResolveWithin(root, root, p)
}

// ResolveWithin returns the absolute path of p, relative to base, after
// checking that base is inside root, that p exists inside root, and that no
// component, from root down, is a symlink: a workspace of several
// repositories reads a path from one of them (base, ws/<alias>) and lets it
// name another (../<other>), never what is outside the workspace.
func ResolveWithin(root, base, p string) (string, error) {
	if p == "" {
		return "", errors.New("empty path")
	}
	if strings.ContainsAny(p, "$~") {
		return "", errors.New("variable or home expansion in a path")
	}
	if strings.Contains(p, "docker.sock") {
		return "", errors.New("the Docker socket is the host")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	// base is named from root as written, then read from root's real path:
	// the walk below checks every component of it too, so a base that is a
	// symlink is refused like any other path through one.
	baseRel := "."
	if base != root {
		baseAbs, err := filepath.Abs(base)
		if err != nil {
			return "", err
		}
		if baseRel, err = filepath.Rel(rootAbs, baseAbs); err != nil || !filepath.IsLocal(baseRel) && baseRel != "." {
			return "", errors.New("project directory outside the workspace")
		}
	}
	if resolved, err := filepath.EvalSymlinks(rootAbs); err == nil {
		rootAbs = resolved // the checkout itself may live under a symlinked tmp
	}
	baseAbs := filepath.Join(rootAbs, baseRel)
	abs := p
	if !filepath.IsAbs(p) {
		abs = filepath.Join(baseAbs, p)
	}
	abs = filepath.Clean(abs)
	rel, err := filepath.Rel(rootAbs, abs)
	if err != nil || !filepath.IsLocal(rel) && rel != "." {
		return "", errors.New("bind outside the project")
	}
	cur := rootAbs
	if rel != "." {
		for _, part := range strings.Split(rel, string(filepath.Separator)) {
			cur = filepath.Join(cur, part)
			fi, err := os.Lstat(cur)
			if err != nil {
				return "", errors.New("path does not exist in the checkout (a path made later could be a planted symlink)")
			}
			if fi.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("path goes through a symlink")
			}
		}
	}
	return abs, nil
}

// rewriteService forces the cell's settings on a checked service.
func (c *checker) rewriteService(name string, svc map[string]any) {
	o := c.o
	if img := o.Built[name]; img != "" {
		delete(svc, "build")
		svc["image"] = img
		svc["pull_policy"] = "never" // the cell's own image, on this Docker only
	}
	svc["runtime"] = o.Runtime
	if o.CgroupParent != "" {
		svc["cgroup_parent"] = o.CgroupParent
	}
	fastStartHealth(svc, o.HealthStartInterval)
	svc["security_opt"] = []any{"no-new-privileges:true"}
	svc["cap_drop"], svc["cap_add"] = []any{"ALL"}, serviceCapsWithout(svc["cap_drop"])
	svc["pids_limit"] = o.PidsLimit
	// The shared Docker disk (review #7): logs within the cell's bound, and
	// the writable layer capped when the cell has a disk size.
	size, sizeBytes, files, _ := o.logBound() // Apply checked it
	svc["logging"] = serviceLogging(svc["logging"], size, sizeBytes, files)
	if o.DiskSize != "" {
		svc["storage_opt"] = map[string]any{"size": o.DiskSize}
	}
	delete(svc, "ports") // the observer reaches services on the claim network
	delete(svc, "deploy")
	if o.MemLimit != "" {
		svc["mem_limit"] = o.MemLimit
	}
	if o.CPUs != "" {
		svc["cpus"] = o.CPUs
	}
	if vols, ok := svc["volumes"].([]any); ok {
		for i, vol := range vols {
			vols[i] = c.readOnlyBind(vol)
		}
	}
	labels := map[string]any{}
	switch l := svc["labels"].(type) {
	case map[string]any:
		for k, val := range l {
			labels[k] = val
		}
	case []any:
		for _, item := range l {
			if s, ok := item.(string); ok {
				k, val, _ := strings.Cut(s, "=")
				labels[k] = val
			}
		}
	}
	for k, val := range o.Labels {
		labels[k] = val
	}
	svc["labels"] = labels
	if o.Network != "" {
		svc["networks"] = []any{ClaimNetworkKey}
	}
	if c.addrs != nil {
		svc["networks"] = map[string]any{ClaimNetworkKey: map[string]any{"ipv4_address": c.addrs[name].String(), "mac_address": ServiceMAC(c.addrs[name])}}
		svc["extra_hosts"] = extraHosts(c.addrs)
	}
	if o.Resolv != "" {
		vols, _ := svc["volumes"].([]any)
		svc["volumes"] = append(vols, map[string]any{"type": "bind", "source": o.Resolv, "target": ResolvTarget, "read_only": true})
	}
	if o.Decoy != "" {
		vols, _ := svc["volumes"].([]any)
		svc["volumes"] = append(vols, map[string]any{"type": "bind", "source": o.Decoy, "target": DecoyTarget, "read_only": true})
	}
	if o.Trust.Set() {
		vols, _ := svc["volumes"].([]any)
		svc["volumes"] = append(vols,
			map[string]any{"type": "bind", "source": o.Trust.Bundle, "target": machinetrust.BundleTarget, "read_only": true},
			map[string]any{"type": "bind", "source": o.Trust.CellCA, "target": machinetrust.CellCATarget, "read_only": true})
		// checkService refused an environment of another shape.
		env, _ := environmentMap(svc["environment"])
		for k, v := range machinetrust.Env(machinetrust.BundleTarget, machinetrust.CellCATarget) {
			env[k] = v
		}
		svc["environment"] = env
	}
}

// environmentMap reads a service's environment, a mapping or a list of
// k=v (a bare name keeps no value), as a mapping.
func environmentMap(environment any) (map[string]any, error) {
	out := map[string]any{}
	switch e := environment.(type) {
	case nil:
	case map[string]any:
		maps.Copy(out, e)
	case []any:
		for _, kv := range e {
			s, ok := kv.(string)
			if !ok {
				return nil, errors.New("environment list entry is not a string")
			}
			if k, v, found := strings.Cut(s, "="); found {
				out[k] = v
			} else {
				out[k] = nil
			}
		}
	default:
		return nil, errors.New("environment is neither a mapping nor a list")
	}
	return out, nil
}

// ServiceCaps are the only capabilities a service has: Docker's default set
// without NET_RAW and AUDIT_WRITE, which do nothing under runsc (raw sockets
// are off unless runsc runs with --net-raw, and gVisor has no audit
// subsystem). What is left is what images commonly use when they start: an
// entrypoint that chowns its data and drops to its user (postgres, redis), a
// server on a port below 1024 (nginx). The cell drops ALL and adds these
// back, so a capability Docker adds to its default set later is not given.
var ServiceCaps = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "MKNOD", "NET_BIND_SERVICE", "SETFCAP", "SETGID", "SETPCAP", "SETUID", "SYS_CHROOT"}

// capName is a capability as Docker reads it: "cap_chown" and "CHOWN" are one.
func capName(s string) string {
	return strings.TrimPrefix(strings.ToUpper(strings.TrimSpace(s)), "CAP_")
}

// checkCapDrop allows a list of capability names: the file may drop more
// than the cell does, never less.
func (c *checker) checkCapDrop(v any, path string) {
	switch x := v.(type) {
	case nil:
	case []any:
		for i, e := range x {
			if s, ok := e.(string); !ok || capName(s) == "" {
				c.add(fmt.Sprintf("%s[%d]", path, i), "not a capability name")
			}
		}
	default:
		c.add(path, "not a list")
	}
}

// serviceCapsWithout is ServiceCaps less what the file's cap_drop names (all
// of them for ALL), so a file that dropped a capability keeps it dropped.
func serviceCapsWithout(fileDrop any) []any {
	dropped := map[string]bool{}
	list, _ := fileDrop.([]any)
	for _, e := range list {
		if s, ok := e.(string); ok {
			dropped[capName(s)] = true
		}
	}
	out := []any{}
	if dropped["ALL"] {
		return out
	}
	for _, c := range ServiceCaps {
		if !dropped[c] {
			out = append(out, c)
		}
	}
	return out
}

// addDataVolumes mounts the cell's data volumes (Options.DataVolumes) and
// declares them as the project's.
func addDataVolumes(doc, services map[string]any, add map[string]map[string]string) error {
	if len(add) == 0 {
		return nil
	}
	top, _ := doc["volumes"].(map[string]any)
	if top == nil {
		top = map[string]any{}
	}
	for _, name := range sortedKeys(add) {
		svc, ok := services[name].(map[string]any)
		if !ok {
			return fmt.Errorf("sandbox: data volume for %q, which is not a service", name)
		}
		vols, _ := svc["volumes"].([]any)
		for _, target := range sortedKeys(add[name]) {
			key := add[name][target]
			if _, dup := top[key]; dup {
				return fmt.Errorf("sandbox: data volume %q is already in the file", key)
			}
			for _, v := range vols {
				if mountTarget(v) == path.Clean(target) {
					return fmt.Errorf("sandbox: %s already mounts %s", name, target)
				}
			}
			top[key] = map[string]any{}
			vols = append(vols, map[string]any{"type": "volume", "source": key, "target": target})
		}
		svc["volumes"] = vols
	}
	doc["volumes"] = top
	return nil
}

// readOnlyBind spells a bind out with its resolved absolute source and
// read_only: true; other mounts are left as they are.
func (c *checker) readOnlyBind(vol any) any {
	switch x := vol.(type) {
	case string:
		parts := strings.Split(x, ":")
		if len(parts) < 2 || !isPath(parts[0]) {
			return vol
		}
		abs, _ := c.o.resolve(parts[0])
		return map[string]any{"type": "bind", "source": abs, "target": parts[1], "read_only": true}
	case map[string]any:
		if t, _ := x["type"].(string); t == "bind" {
			src, _ := x["source"].(string)
			abs, _ := c.o.resolve(src)
			x["source"], x["read_only"] = abs, true
			delete(x, "bind")
		}
	}
	return vol
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// mountTarget is where a service volume lands ("" when it cannot tell).
func mountTarget(vol any) string {
	switch x := vol.(type) {
	case string:
		parts := strings.Split(x, ":")
		if len(parts) == 1 {
			return path.Clean(parts[0])
		}
		return path.Clean(parts[1])
	case map[string]any:
		if t, _ := x["target"].(string); t != "" {
			return path.Clean(t)
		}
	}
	return ""
}

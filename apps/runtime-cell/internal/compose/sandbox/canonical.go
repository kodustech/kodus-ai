package sandbox

import (
	"encoding/json"
	"fmt"
	"math"
	pathpkg "path"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// VerifyCanonical checks the project as docker compose will run it (the
// JSON of `compose config --format json` on the file Apply wrote): every
// service on the cell's runtime and network with no host-sharing option, no
// build, no published port, binds read-only inside the checkout, volumes
// named after the project, the claim's network the only one. It is the
// second reader: whatever the first one misread, this is what runs.
func VerifyCanonical(configJSON []byte, o Options) error {
	if err := claimlimits.ValidateDockerParent(o.CgroupParent); err != nil {
		return fmt.Errorf("sandbox: %w", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(configJSON, &doc); err != nil {
		return fmt.Errorf("sandbox: compose config: %w", err)
	}
	c := &checker{o: o}
	services, _ := doc["services"].(map[string]any)
	if len(services) == 0 {
		c.add("services", "no services")
	}
	if o.Subnet.IsValid() {
		addrs, err := ServiceAddresses(sortedKeys(services), o.Subnet)
		if err != nil {
			return err
		}
		c.addrs = addrs
	}
	for _, name := range sortedKeys(services) {
		svc, _ := services[name].(map[string]any)
		c.verifyService(name, svc)
	}
	vols, _ := doc["volumes"].(map[string]any)
	for _, name := range sortedKeys(vols) {
		v, _ := vols[name].(map[string]any)
		if ext, _ := v["external"].(bool); ext {
			c.add("volumes."+name, "external")
		}
		if n, _ := v["name"].(string); n != o.Project+"_"+name {
			c.add("volumes."+name+".name", fmt.Sprintf("named %q, not the project's", n))
		}
		if d, _ := v["driver"].(string); d != "" && d != "local" {
			c.add("volumes."+name+".driver", d)
		}
		if _, ok := v["driver_opts"]; ok {
			c.add("volumes."+name+".driver_opts", "driver options")
		}
	}
	if nonEmpty(doc["secrets"]) {
		c.add("secrets", "set") // Apply drops them: no service mounts a secret
	}
	nets, _ := doc["networks"].(map[string]any)
	for _, name := range sortedKeys(nets) {
		n, _ := nets[name].(map[string]any)
		if name != ClaimNetworkKey || n["name"] != o.Network {
			c.add("networks."+name, "only the claim's network")
		}
	}
	if len(c.v) > 0 {
		return &RefusedError{Violations: c.v}
	}
	return nil
}

func (c *checker) verifyService(name string, svc map[string]any) {
	path := "services." + name
	if svc == nil {
		c.add(path, "not a mapping")
		return
	}
	if svc["runtime"] != c.o.Runtime {
		c.add(path+".runtime", fmt.Sprintf("%v, not %s", svc["runtime"], c.o.Runtime))
	}
	if svc["build"] != nil {
		c.add(path+".build", "builds are refused")
	}
	if img := c.o.Built[name]; img != "" && svc["image"] != img {
		c.add(path+".image", fmt.Sprintf("%v, not the image the cell built", svc["image"]))
	}
	for _, k := range []string{"privileged", "oom_kill_disable"} {
		if b, _ := svc[k].(bool); b {
			c.add(path+"."+k, "set")
		}
	}
	if parent, exists := svc["cgroup_parent"]; c.o.CgroupParent != "" {
		if parent != c.o.CgroupParent {
			c.add(path+".cgroup_parent", "not the cell's aggregate parent")
		}
	} else if exists && parent != "" {
		c.add(path+".cgroup_parent", "unexpected aggregate parent")
	}
	for _, k := range []string{"network_mode", "pid", "ipc", "uts", "userns_mode", "cgroup", "isolation"} {
		if s, _ := svc[k].(string); s != "" {
			c.add(path+"."+k, s)
		}
	}
	if c.addrs != nil {
		if !sameHosts(svc["extra_hosts"], c.addrs) {
			c.add(path+".extra_hosts", "not the claim's service names")
		}
	} else if nonEmpty(svc["extra_hosts"]) {
		c.add(path+".extra_hosts", "set")
	}
	c.verifyCaps(path, svc)
	c.verifyLimits(path, svc)
	c.verifyDisk(path, svc)
	for _, k := range []string{"devices", "device_cgroup_rules", "ports", "volumes_from", "dns", "links", "external_links", "secrets", "configs", "sysctls", "group_add"} {
		if nonEmpty(svc[k]) {
			c.add(path+"."+k, "set")
		}
	}
	so, _ := svc["security_opt"].([]any)
	if len(so) != 1 || so[0] != "no-new-privileges:true" {
		c.add(path+".security_opt", fmt.Sprintf("%v", so))
	}
	if nets, _ := svc["networks"].(map[string]any); len(nets) != 1 || !hasKey(nets, ClaimNetworkKey) {
		c.add(path+".networks", "only the claim's network")
	} else if c.addrs != nil {
		at, _ := nets[ClaimNetworkKey].(map[string]any)
		if got, _ := at["ipv4_address"].(string); got != c.addrs[name].String() {
			c.add(path+".networks", fmt.Sprintf("address %q, not the service's %s", got, c.addrs[name]))
		}
		if got, _ := at["mac_address"].(string); !strings.EqualFold(got, ServiceMAC(c.addrs[name])) {
			c.add(path+".networks", fmt.Sprintf("MAC %q, not the service's %s", got, ServiceMAC(c.addrs[name])))
		}
	}
	if c.o.Resolv != "" && !mountsTheCellResolv(svc["volumes"], c.o.Resolv) {
		c.add(path+".volumes", "the cell's resolv.conf is not mounted")
	}
	if c.o.Decoy != "" && !mountsReadOnly(svc["volumes"], c.o.Decoy, DecoyTarget) {
		c.add(path+".volumes", "the cell's decoy file is not mounted")
	}
	covered := c.o.Coverage.covers(name)
	if covered && (!mountsWritable(svc["volumes"], c.o.Coverage.Dir, CoverageTarget) || !mountsReadOnly(svc["volumes"], c.o.Coverage.Preload, CoveragePreloadTarget)) {
		c.add(path+".volumes", "the cell's coverage mounts are not mounted")
	}
	if c.o.Trust.Set() {
		if !mountsReadOnly(svc["volumes"], c.o.Trust.Bundle, machinetrust.BundleTarget) || !mountsReadOnly(svc["volumes"], c.o.Trust.CellCA, machinetrust.CellCATarget) {
			c.add(path+".volumes", "the cell's trust files are not mounted")
		}
		env, _ := svc["environment"].(map[string]any)
		for k, v := range machinetrust.Env(machinetrust.BundleTarget, machinetrust.CellCATarget) {
			if env[k] != v {
				c.add(path+".environment."+k, fmt.Sprintf("%v, not the cell's %s", env[k], v))
			}
		}
	}
	labels, _ := svc["labels"].(map[string]any)
	for k, v := range c.o.Labels {
		if labels[k] != v {
			c.add(path+".labels."+k, "the cell's label is missing")
		}
	}
	vols, _ := svc["volumes"].([]any)
	for i, v := range vols {
		m, _ := v.(map[string]any)
		vp := fmt.Sprintf("%s.volumes[%d]", path, i)
		if t, _ := m["target"].(string); (t == machinetrust.Dir || strings.HasPrefix(t, machinetrust.Dir+"/")) && !c.cellTrustMount(m) {
			c.add(vp, t+" is the cell's")
		}
		cellCoverage := covered && c.cellCoverageMount(m)
		if t, _ := m["target"].(string); coverageTarget(pathpkg.Clean(t)) && !cellCoverage {
			c.add(vp, t+" is the cell's")
		}
		switch m["type"] {
		case "bind":
			src, _ := m["source"].(string)
			if ro, _ := m["read_only"].(bool); !ro && (!cellCoverage || m["target"] != CoverageTarget) {
				c.add(vp, "bind is not read-only")
			}
			if cellCoverage {
				break // the cell's coverage directory and preload
			}
			if c.o.Resolv != "" && src == c.o.Resolv && m["target"] == ResolvTarget {
				break // a bind from outside the checkout: the cell's own file
			}
			if c.o.Decoy != "" && src == c.o.Decoy && m["target"] == DecoyTarget {
				break // the other one: the cell's decoy file
			}
			if c.cellTrustMount(m) {
				break // the cell's trust files
			}
			if _, err := c.o.resolve(src); err != nil {
				c.add(vp, err.Error())
			}
			if b, ok := m["bind"].(map[string]any); ok {
				if p, _ := b["propagation"].(string); p != "" && p != "rprivate" && p != "private" {
					c.add(vp, "bind propagation "+p)
				}
				if s, _ := b["selinux"].(string); s != "" {
					c.add(vp, "selinux relabel")
				}
			}
		case "volume":
			// compose resolves the source to the project's key; the volume's
			// own name was checked at the top level.
		case "tmpfs":
		default:
			c.add(vp, fmt.Sprintf("mount type %v", m["type"]))
		}
	}
	if d, ok := svc["deploy"].(map[string]any); ok {
		if res, ok := d["resources"].(map[string]any); ok {
			if r, ok := res["reservations"].(map[string]any); ok && nonEmpty(r["devices"]) {
				c.add(path+".deploy", "device reservation")
			}
		}
	}
}

// verifyDisk: the service logs through the local driver within the cell's
// bound, and its writable layer has the cell's disk size, or none when the
// cell sets none.
func (c *checker) verifyDisk(path string, svc map[string]any) {
	_, sizeBytes, files, err := c.o.logBound()
	if err != nil {
		c.add(path+".logging", err.Error())
		return
	}
	l, _ := svc["logging"].(map[string]any)
	opts, _ := l["options"].(map[string]any)
	if l == nil || l["driver"] != "local" || opts["max-size"] == nil || opts["max-file"] == nil {
		c.add(path+".logging", "not the cell's (the local driver within its bound)")
	}
	for _, k := range sortedKeys(opts) {
		switch k {
		case "max-size":
			s, _ := opts[k].(string)
			if b, ok := parseLogSize(s); !ok || b > sizeBytes {
				c.add(path+".logging.options.max-size", fmt.Sprintf("%v, past the cell's bound", opts[k]))
			}
		case "max-file":
			if f, ok := logFiles(opts[k]); !ok || f < 1 || f > files {
				c.add(path+".logging.options.max-file", fmt.Sprintf("%v, past the cell's bound", opts[k]))
			}
		default:
			c.add(path+".logging.options."+k, "not the cell's")
		}
	}
	so, _ := svc["storage_opt"].(map[string]any)
	switch {
	case c.o.DiskSize == "" && nonEmpty(svc["storage_opt"]):
		c.add(path+".storage_opt", "set")
	case c.o.DiskSize != "" && (len(so) != 1 || so["size"] != c.o.DiskSize):
		c.add(path+".storage_opt", fmt.Sprintf("%v, not the cell's size %s", svc["storage_opt"], c.o.DiskSize))
	}
}

// verifyCaps: the service drops ALL and adds back only ServiceCaps.
func (c *checker) verifyCaps(path string, svc map[string]any) {
	drops, _ := svc["cap_drop"].([]any)
	if !slices.ContainsFunc(drops, func(v any) bool { s, _ := v.(string); return capName(s) == "ALL" }) {
		c.add(path+".cap_drop", "does not drop ALL")
	}
	switch adds := svc["cap_add"].(type) {
	case nil:
	case []any:
		for _, v := range adds {
			if s, _ := v.(string); !slices.Contains(ServiceCaps, capName(s)) {
				c.add(path+".cap_add", fmt.Sprintf("%v is not one of the service capabilities", v))
			}
		}
	default:
		c.add(path+".cap_add", "not a list")
	}
}

// verifyLimits: the limits Apply forced are the ones compose will run with
// (pids_limit, mem_limit and cpus), and nothing in deploy sets others.
func (c *checker) verifyLimits(path string, svc map[string]any) {
	pids := c.o.PidsLimit
	if pids == 0 {
		pids = 2048
	}
	if got, ok := number(svc["pids_limit"]); !ok || got != float64(pids) {
		c.add(path+".pids_limit", fmt.Sprintf("%v, not %d", svc["pids_limit"], pids))
	}
	if c.o.MemLimit != "" {
		want, err := memBytes(c.o.MemLimit)
		if err != nil {
			c.add(path+".mem_limit", "the cell's memory limit does not parse: "+err.Error())
		} else if got, err := memBytes(svc["mem_limit"]); err != nil || got != want {
			c.add(path+".mem_limit", fmt.Sprintf("%v, not %s", svc["mem_limit"], c.o.MemLimit))
		}
	}
	if c.o.CPUs != "" {
		want, okW := number(c.o.CPUs)
		if got, ok := number(svc["cpus"]); !okW || !ok || math.Abs(got-want) > 1e-6 {
			c.add(path+".cpus", fmt.Sprintf("%v, not %s", svc["cpus"], c.o.CPUs))
		}
	}
	if d, ok := svc["deploy"].(map[string]any); ok {
		if res, ok := d["resources"].(map[string]any); ok && nonEmpty(res["limits"]) {
			c.add(path+".deploy.resources.limits", "the cell sets the limits")
		}
	}
}

// number reads a JSON number or a numeric string.
func number(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(x), 64)
		return f, err == nil
	}
	return 0, false
}

// memBytes reads a memory size as compose and docker take it: a byte count
// (a JSON number or "4294967296") or a number with a unit ("4g", "12288m",
// "512MiB"), in powers of 1024.
func memBytes(v any) (int64, error) {
	if f, ok := v.(float64); ok {
		return int64(f), nil
	}
	s, ok := v.(string)
	if !ok {
		return 0, fmt.Errorf("%v is not a size", v)
	}
	m := memSize.FindStringSubmatch(strings.ToLower(strings.TrimSpace(s)))
	if m == nil {
		return 0, fmt.Errorf("%q is not a size", s)
	}
	n, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, err
	}
	unit := strings.TrimSuffix(strings.TrimSuffix(m[2], "ib"), "b")
	shift := map[string]uint{"": 0, "k": 10, "m": 20, "g": 30, "t": 40}[unit]
	return int64(n * float64(uint64(1)<<shift)), nil
}

var memSize = regexp.MustCompile(`^([0-9]+(?:\.[0-9]+)?)\s*(b|[kmgt](?:i?b)?)?$`)

func hasKey(m map[string]any, k string) bool {
	_, ok := m[k]
	return ok
}

func nonEmpty(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case []any:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	case string:
		return x != ""
	case bool:
		return x
	}
	return true
}

// mountsTheCellResolv: the service mounts the cell's resolv.conf, read-only,
// where the resolver reads it.
func mountsTheCellResolv(v any, resolv string) bool {
	return mountsReadOnly(v, resolv, ResolvTarget)
}

// mountsReadOnly: the service binds the cell's file source, read-only, at
// target.
func mountsReadOnly(v any, source, target string) bool {
	vols, _ := v.([]any)
	for _, x := range vols {
		m, _ := x.(map[string]any)
		if ro, _ := m["read_only"].(bool); ro && m["type"] == "bind" && m["source"] == source && m["target"] == target {
			return true
		}
	}
	return false
}

// mountsWritable: v binds source at target, writable (what compose prints
// with no read_only).
func mountsWritable(v any, source, target string) bool {
	vols, _ := v.([]any)
	for _, x := range vols {
		m, _ := x.(map[string]any)
		if ro, _ := m["read_only"].(bool); !ro && m["type"] == "bind" && m["source"] == source && m["target"] == target {
			return true
		}
	}
	return false
}

// cellCoverageMount: m is the cell's coverage directory or preload, bound
// where Apply put it (the preload read-only).
func (c *checker) cellCoverageMount(m map[string]any) bool {
	if m["type"] != "bind" {
		return false
	}
	src, _ := m["source"].(string)
	ro, _ := m["read_only"].(bool)
	return src == c.o.Coverage.Dir && m["target"] == CoverageTarget || src == c.o.Coverage.Preload && m["target"] == CoveragePreloadTarget && ro
}

// cellTrustMount: m is one of the cell's trust files, bound where Apply
// put it.
func (c *checker) cellTrustMount(m map[string]any) bool {
	if !c.o.Trust.Set() || m["type"] != "bind" {
		return false
	}
	src, _ := m["source"].(string)
	return src == c.o.Trust.Bundle && m["target"] == machinetrust.BundleTarget || src == c.o.Trust.CellCA && m["target"] == machinetrust.CellCATarget
}

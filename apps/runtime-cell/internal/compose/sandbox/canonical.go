package sandbox

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
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
	for _, k := range []string{"cap_add", "devices", "device_cgroup_rules", "ports", "volumes_from", "dns", "links", "external_links", "secrets", "configs", "sysctls", "group_add"} {
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
		switch m["type"] {
		case "bind":
			src, _ := m["source"].(string)
			if ro, _ := m["read_only"].(bool); !ro {
				c.add(vp, "bind is not read-only")
			}
			if c.o.Resolv != "" && src == c.o.Resolv && m["target"] == ResolvTarget {
				break // a bind from outside the checkout: the cell's own file
			}
			if c.o.Decoy != "" && src == c.o.Decoy && m["target"] == DecoyTarget {
				break // the other one: the cell's decoy file
			}
			if _, err := ResolveInside(c.o.ProjectDir, src); err != nil {
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

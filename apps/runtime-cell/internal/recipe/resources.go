package recipe

import (
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

// ResourceSize is a neutral requirement, not authority to allocate hardware.
// DiskGB is parsed but must be refused until a backend can enforce it.
type ResourceSize struct {
	CPUs     int `json:"cpus,omitempty"`
	MemoryMB int `json:"memoryMb,omitempty"`
	DiskGB   int `json:"diskGb,omitempty"`
}

func (r *Recipe) SizeRequirement() *ResourceSize {
	if r.resourceSize == nil {
		return nil
	}
	v := *r.resourceSize
	return &v
}
func (r *Recipe) EgressRequirements() []string { return slices.Clone(r.egressHosts) }

func fields(n *yaml.Node, allowed ...string) (map[string]*yaml.Node, error) {
	if n.Kind != yaml.MappingNode {
		return nil, errors.New("resource declaration must be a mapping")
	}
	out := map[string]*yaml.Node{}
	for i := 0; i < len(n.Content); i += 2 {
		k := n.Content[i].Value
		if !slices.Contains(allowed, k) {
			return nil, fmt.Errorf("unknown field %q", k)
		}
		if _, dup := out[k]; dup {
			return nil, fmt.Errorf("duplicate field %q", k)
		}
		out[k] = n.Content[i+1]
	}
	return out, nil
}

var resourceUnit = regexp.MustCompile(`(?i)^([1-9][0-9]{0,8})(mb|mib|gb|gib)$`)

func resourceAmount(n *yaml.Node, disk bool) (int, error) {
	if n == nil {
		return 0, nil
	}
	if n.Tag != "!!str" {
		return 0, errors.New("size: memory and disk require units")
	}
	m := resourceUnit.FindStringSubmatch(n.Value)
	if m == nil {
		return 0, errors.New("size: invalid memory or disk units")
	}
	amount, _ := strconv.ParseInt(m[1], 10, 64)
	if strings.HasPrefix(strings.ToLower(m[2]), "g") {
		amount *= 1024
	}
	if disk {
		if amount < 1024 || amount > 16384*1024 || amount%1024 != 0 {
			return 0, errors.New("size.disk: use whole GB from 1gb to 16384gb")
		}
		return int(amount / 1024), nil
	}
	if amount < 512 || amount > 262144 {
		return 0, errors.New("size.memory: use 512mb to 256gb")
	}
	return int(amount), nil
}
func neutralSize(f map[string]*yaml.Node) (*ResourceSize, error) {
	r := &ResourceSize{}
	cpu, mem := f["cpu"], f["memory"]
	if (cpu == nil) != (mem == nil) {
		return nil, errors.New("size: cpu and memory must be declared together")
	}
	if cpu != nil {
		var v float64
		if (cpu.Tag != "!!int" && cpu.Tag != "!!float") || cpu.Decode(&v) != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 1 || v > 64 || math.Trunc(v) != v {
			return nil, errors.New("size.cpu: use whole CPUs from 1 to 64")
		}
		r.CPUs = int(v)
	}
	var err error
	if r.MemoryMB, err = resourceAmount(mem, false); err != nil {
		return nil, err
	}
	if r.DiskGB, err = resourceAmount(f["disk"], true); err != nil {
		return nil, err
	}
	if r.CPUs == 0 && r.DiskGB == 0 {
		return nil, errors.New("size: declare cpu and memory, or disk")
	}
	return r, nil
}

var hostLabel = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)

func exactRecipeHost(raw string) (string, bool) {
	h := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(raw)), ".")
	labels := strings.Split(h, ".")
	if len(h) > 253 || len(labels) < 2 {
		return "", false
	}
	for _, l := range labels {
		if !hostLabel.MatchString(l) {
			return "", false
		}
	}
	alpha := false
	for _, c := range labels[len(labels)-1] {
		if c >= 'a' && c <= 'z' {
			alpha = true
		}
	}
	return h, alpha
}
func (r *Recipe) normalizeResources() error {
	var legacy map[string]*yaml.Node
	var err error
	if !r.Limits.IsZero() {
		legacy, err = fields(&r.Limits, "cpu", "memory", "disk", "instance", "idle_suspend", "idle_activity")
		if err != nil {
			return err
		}
		if v := legacy["instance"]; v != nil {
			if v.Tag != "!!str" || len(v.Value) > 128 {
				return errors.New("limits.instance: invalid value")
			}
			r.legacyUnapplied = append(r.legacyUnapplied, "limits.instance")
		}
		if v := legacy["idle_suspend"]; v != nil {
			var d Duration
			if v.Decode(&d) != nil {
				return errors.New("limits.idle_suspend: invalid duration")
			}
			r.legacyUnapplied = append(r.legacyUnapplied, "limits.idle_suspend")
		}
		if v := legacy["idle_activity"]; v != nil {
			if v.Kind != yaml.SequenceNode || len(v.Content) > 16 {
				return errors.New("limits.idle_activity: invalid list")
			}
			for _, a := range v.Content {
				if a.Tag != "!!str" || len(a.Value) > 64 {
					return errors.New("limits.idle_activity: invalid activity")
				}
			}
			r.legacyUnapplied = append(r.legacyUnapplied, "limits.idle_activity")
		}
	}
	legacySize := legacy["cpu"] != nil || legacy["memory"] != nil || legacy["disk"] != nil
	if !r.Size.IsZero() && legacySize {
		return errors.New("size and limits resource fields together; use one")
	}
	if !r.Size.IsZero() {
		if r.Size.Kind == yaml.ScalarNode && r.Size.Tag == "!!str" {
			switch r.Size.Value {
			case "small":
				r.resourceSize = &ResourceSize{CPUs: 2, MemoryMB: 4096}
			case "medium":
				r.resourceSize = &ResourceSize{CPUs: 4, MemoryMB: 8192}
			case "large":
				r.resourceSize = &ResourceSize{CPUs: 8, MemoryMB: 16384}
			default:
				return errors.New("size: unknown preset")
			}
		}
		if r.resourceSize == nil {
			var f map[string]*yaml.Node
			f, err = fields(&r.Size, "cpu", "memory", "disk")
			if err != nil {
				return err
			}
			r.resourceSize, err = neutralSize(f)
			if err != nil {
				return err
			}
		}
	} else if legacySize {
		r.resourceSize, err = neutralSize(legacy)
		if err != nil {
			return err
		}
	}
	if !r.Egress.IsZero() {
		f, e := fields(&r.Egress, "allow")
		if e != nil {
			return e
		}
		a := f["allow"]
		if a == nil || a.Kind != yaml.SequenceNode || len(a.Content) > 256 {
			return errors.New("egress.allow: use at most 256 exact hosts")
		}
		for _, n := range a.Content {
			h, ok := exactRecipeHost(n.Value)
			if n.Tag != "!!str" || len(n.Value) > 253 || !ok {
				return errors.New("egress.allow: use exact fully qualified DNS hosts without wildcard, IP, URL or port")
			}
			r.egressHosts = append(r.egressHosts, h)
		}
		slices.Sort(r.egressHosts)
		r.egressHosts = slices.Compact(r.egressHosts)
	}
	return nil
}

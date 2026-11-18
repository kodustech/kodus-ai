package compose

import (
	"fmt"

	"go.yaml.in/yaml/v3"
)

// The compose spec's merge tags: in a later file, !reset drops the value
// the earlier files gave a key, and !override replaces it whole instead of
// merging (a service's volumes list without the earlier binds). They are
// read into marker mappings before decoding, so anchors and merges still
// resolve, and the overlay acts on them.
const (
	resetKey    = "\x00kodus-reset"
	overrideKey = "\x00kodus-override"
)

// markMergeTags rewrites every !reset and !override node into its marker.
func markMergeTags(n *yaml.Node) error {
	for _, c := range n.Content {
		if err := markMergeTags(c); err != nil {
			return err
		}
	}
	var key string
	switch n.Tag {
	case "!reset":
		key = resetKey
	case "!override":
		key = overrideKey
	default:
		if len(n.Tag) > 0 && n.Tag[0] == '!' && (len(n.Tag) < 2 || n.Tag[1] != '!') {
			return fmt.Errorf("compose: YAML tag %s is not supported", n.Tag)
		}
		return nil
	}
	inner := *n
	inner.Tag = ""
	*n = yaml.Node{Kind: yaml.MappingNode, Content: []*yaml.Node{{Kind: yaml.ScalarNode, Value: key}, &inner}}
	return nil
}

// marker returns the marker a value carries ("" for none) and its inner
// value.
func marker(v any) (string, any) {
	m, ok := v.(map[string]any)
	if !ok || len(m) != 1 {
		return "", v
	}
	for k, inner := range m {
		if k == resetKey || k == overrideKey {
			return k, inner
		}
	}
	return "", v
}

// unmark drops the markers left in a value: an override is its value, a
// reset is no key at all.
func unmark(v any) (any, bool) {
	switch k, inner := marker(v); k {
	case resetKey:
		return nil, false
	case overrideKey:
		v = inner
	}
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for key, val := range x {
			if u, keep := unmark(val); keep {
				out[key] = u
			}
		}
		return out, true
	case []any:
		out := make([]any, 0, len(x))
		for _, val := range x {
			if u, keep := unmark(val); keep {
				out = append(out, u)
			}
		}
		return out, true
	}
	return v, true
}

// appendedLists are the keys whose lists add up across compose files, as
// docker compose merges them; every other list or scalar is replaced by the
// later file.
var appendedLists = map[string]bool{
	"ports": true, "expose": true, "volumes": true, "environment": true, "env_file": true,
	"labels": true, "depends_on": true, "dns": true, "extra_hosts": true, "secrets": true,
	"configs": true, "networks": true, "cap_add": true, "cap_drop": true, "devices": true,
	"security_opt": true, "tmpfs": true, "external_links": true, "links": true,
}

// overlay lays over on top of base, the way `docker compose -f base -f
// over` does: maps merge key by key, the appendedLists add up without
// repeats, anything else from over wins.
func overlay(base, over map[string]any) map[string]any {
	if base == nil {
		return over
	}
	out := make(map[string]any, len(base)+len(over))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		switch m, inner := marker(v); m {
		case resetKey:
			delete(out, k)
			continue
		case overrideKey:
			out[k], _ = unmark(inner)
			continue
		}
		out[k] = overlayValue(k, out[k], v)
	}
	return out
}

func overlayValue(key string, base, over any) any {
	switch o := over.(type) {
	case map[string]any:
		if b, ok := base.(map[string]any); ok {
			return overlay(b, o)
		}
	case []any:
		if b, ok := base.([]any); ok && appendedLists[key] {
			return appendUnique(b, o)
		}
	}
	return over
}

func appendUnique(a, b []any) []any {
	seen := make(map[string]bool, len(a)+len(b))
	out := make([]any, 0, len(a)+len(b))
	for _, x := range append(append([]any{}, a...), b...) {
		k := fmt.Sprint(x)
		if !seen[k] {
			seen[k] = true
			out = append(out, x)
		}
	}
	return out
}

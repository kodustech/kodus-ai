package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"go.yaml.in/yaml/v3"
)

// Build is one service's image the cell builds from the checkout, in a
// sandbox on the claim's network: a Dockerfile's RUN steps are PR code.
type Build struct {
	Service string
	// Context is absolute and inside the checkout; Dockerfile is relative
	// to it and inside it too.
	Context    string
	Dockerfile string
	Target     string
	Args       map[string]string
}

// buildKeys are what a build section may say. Anything else (a remote
// context, additional contexts, ssh, secrets, cache import and export, a
// network mode) reaches outside the checkout or the claim network.
var buildKeys = map[string]bool{"context": true, "dockerfile": true, "target": true, "args": true}

var (
	plainToken = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	argName    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

// Builds reads every service's build section and refuses, all at once,
// any the cell cannot build inside the checkout.
func Builds(raw []byte, o Options) ([]Build, error) {
	var doc map[string]any
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}
	services, _ := doc["services"].(map[string]any)
	c := &checker{o: o}
	var out []Build
	for _, name := range sortedKeys(services) {
		svc, _ := services[name].(map[string]any)
		if svc == nil || svc["build"] == nil {
			continue
		}
		if b, ok := c.build(name, svc["build"]); ok {
			out = append(out, b)
		}
	}
	if len(c.v) > 0 {
		return nil, &RefusedError{Violations: c.v}
	}
	return out, nil
}

func (c *checker) build(service string, v any) (Build, bool) {
	path := "services." + service + ".build"
	b := Build{Service: service, Dockerfile: "Dockerfile", Args: map[string]string{}}
	ctx := "."
	switch x := v.(type) {
	case string:
		ctx = x
	case map[string]any:
		for _, k := range sortedKeys(x) {
			if !buildKeys[k] {
				c.add(path+"."+k, "the cell builds from the checkout alone")
			}
		}
		if s, ok := x["context"].(string); ok {
			ctx = s
		}
		if s, ok := x["dockerfile"].(string); ok {
			b.Dockerfile = s
		}
		if s, ok := x["target"].(string); ok {
			if !plainToken.MatchString(s) {
				c.add(path+".target", "not a plain stage name")
			}
			b.Target = s
		}
		c.buildArgs(path+".args", x["args"], b.Args)
	default:
		c.add(path, "neither a path nor a mapping")
		return b, false
	}
	if strings.Contains(ctx, "://") || strings.HasPrefix(ctx, "git@") || strings.Contains(ctx, "$") {
		c.add(path+".context", "a remote or interpolated context")
		return b, false
	}
	abs, err := ResolveInside(c.o.ProjectDir, ctx)
	if err != nil {
		c.add(path+".context", err.Error())
		return b, false
	}
	b.Context = abs
	df, err := ResolveInside(abs, b.Dockerfile)
	if err != nil {
		c.add(path+".dockerfile", err.Error())
		return b, false
	}
	if fi, err := os.Stat(df); err != nil || !fi.Mode().IsRegular() {
		c.add(path+".dockerfile", "not a file in the context")
		return b, false
	}
	b.Dockerfile, _ = filepath.Rel(abs, df)
	return b, len(c.v) == 0
}

func (c *checker) buildArgs(path string, v any, into map[string]string) {
	set := func(k, val string) {
		if !argName.MatchString(k) {
			c.add(path+"."+k, "not an argument name")
			return
		}
		if strings.Contains(val, "$") {
			c.add(path+"."+k, "interpolated")
			return
		}
		into[k] = val
	}
	switch x := v.(type) {
	case nil:
	case map[string]any:
		for _, k := range sortedKeys(x) {
			set(k, fmt.Sprint(x[k]))
		}
	case []any:
		for _, item := range x {
			s, _ := item.(string)
			k, val, ok := strings.Cut(s, "=")
			if !ok {
				c.add(path, fmt.Sprintf("%q has no value", s))
				continue
			}
			set(k, val)
		}
	default:
		c.add(path, "neither a mapping nor a list")
	}
}

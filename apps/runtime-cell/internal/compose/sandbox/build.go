package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
	// Secrets are the org secrets the build asked for (build_secrets.go):
	// BuildKit secret id to the org secret that holds its placeholder.
	// Empty: the build gets none.
	Secrets map[string]string
}

// buildKeys are what a build section may say. Anything else (a remote
// context, additional contexts, ssh, cache import and export, a network
// mode) reaches outside the checkout or the claim network. Its secrets name
// org secrets only (build_secrets.go).
var buildKeys = map[string]bool{"context": true, "dockerfile": true, "target": true, "args": true, "secrets": true}

var (
	plainToken = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	argName    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

// Builds reads every service's build section and refuses, all at once,
// any the cell cannot build inside the checkout.
// It reads the file as Apply does (checker.parse): a YAML tag Apply would
// refuse is refused here too, before anything is built.
func Builds(raw []byte, o Options) ([]Build, error) {
	c := &checker{o: o}
	doc, err := c.parse(raw)
	if err != nil {
		return nil, err
	}
	services, _ := doc["services"].(map[string]any)
	top := c.topSecrets(doc["secrets"])
	var out []Build
	for _, name := range sortedKeys(services) {
		svc, _ := services[name].(map[string]any)
		if svc == nil || svc["build"] == nil {
			continue
		}
		if b, ok := c.build(name, svc["build"], top); ok {
			out = append(out, b)
		}
	}
	if len(c.v) > 0 {
		return nil, &RefusedError{Violations: c.v}
	}
	return out, nil
}

func (c *checker) build(service string, v any, top map[string]string) (Build, bool) {
	path := "services." + service + ".build"
	b := Build{Service: service, Dockerfile: "Dockerfile", Args: map[string]string{}, Secrets: map[string]string{}}
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
		c.buildSecrets(path+".secrets", x["secrets"], top, b.Secrets)
	default:
		c.add(path, "neither a path nor a mapping")
		return b, false
	}
	if strings.Contains(ctx, "://") || strings.HasPrefix(ctx, "git@") || strings.Contains(ctx, "$") {
		c.add(path+".context", "a remote or interpolated context")
		return b, false
	}
	abs, err := c.o.resolve(ctx)
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
	if err := dockerfileSecrets(df, b.Secrets); err != nil {
		c.add(path+".dockerfile", err.Error())
		return b, false
	}
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
			if x[k] == nil {
				continue // unset, as compose leaves it: the Dockerfile's default applies
			}
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

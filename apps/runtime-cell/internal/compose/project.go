// Package compose reads a checkout's docker compose project and adapts it
// to run in a cell, as data: no docker binary here. Each adaptation is one
// method named for what it does, so a driver composes the ones it needs and
// each is tested on its own.
package compose

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/yamlbound"
)

// DefaultFiles are the files docker compose looks for, in its order.
var DefaultFiles = []string{"compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"}

// ErrNoComposeFile means the checkout has none of DefaultFiles.
var ErrNoComposeFile = errors.New("compose: the checkout has no compose file")

// Project is a compose project as docker compose reads it. It is a plain
// YAML tree because compose has far more keys than the cell cares about,
// and every key it does not touch must survive untouched.
type Project struct {
	doc map[string]any
}

// Load reads the project from dir. With files (a recipe's), each must
// exist and they lay over each other in order, like docker compose -f a -f
// b; without, the first of DefaultFiles that exists. Every path resolves
// inside dir (os.Root): a file the PR links outside it is refused, never read.
func Load(dir string, files []string) (*Project, error) {
	if len(files) == 0 {
		for _, name := range DefaultFiles {
			if _, err := inside(dir, func(r *os.Root) (os.FileInfo, error) { return r.Stat(name) }); err == nil {
				files = []string{name}
				break
			}
		}
		if len(files) == 0 {
			return nil, ErrNoComposeFile
		}
	}
	projectDir := composeProjectDir(files)
	var doc map[string]any
	for _, f := range files {
		// The PR's file is read bounded and refused past the node bound
		// before it is decoded (yamlbound): the cell parses it in its own
		// process, outside any claim's cgroup.
		b, err := inside(dir, func(r *os.Root) ([]byte, error) { return yamlbound.ReadFile(r, f) })
		if err != nil {
			return nil, fmt.Errorf("compose: %w", err)
		}
		node, err := yamlbound.Parse(b)
		if err != nil {
			return nil, fmt.Errorf("compose: %s: %w", f, err)
		}
		if err := markMergeTags(node); err != nil {
			return nil, fmt.Errorf("compose: %s: %w", f, err)
		}
		var layer map[string]any
		if err := node.Decode(&layer); err != nil {
			return nil, fmt.Errorf("compose: %s: %w", f, err)
		}
		rebaseHostPaths(layer, pathBase(f, projectDir))
		doc = overlay(doc, layer)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	clean, _ := unmark(doc)
	doc, _ = clean.(map[string]any)
	return &Project{doc: doc}, nil
}

// kodusDir holds the files Kody writes for a repository (a Dockerfile, a
// compose file). Their paths are written from the checkout's root, whatever
// the repository's own compose files do.
const kodusDir = ".kodus"

// composeProjectDir is the directory the repository's compose files read
// their relative paths from, as docker compose does: the directory of the
// first of them. Kody's own files do not count.
func composeProjectDir(files []string) string {
	for _, f := range files {
		if dir := path.Dir(filepath.ToSlash(f)); dir != kodusDir {
			return dir
		}
	}
	return "."
}

// pathBase is where the relative host paths of one compose file start: the
// checkout for a file of Kody's, the project directory for the repository's.
func pathBase(file, projectDir string) string {
	if path.Dir(filepath.ToSlash(file)) == kodusDir {
		return "."
	}
	return projectDir
}

// rebaseHostPaths makes one compose file's relative host paths relative to
// the checkout. Docker compose resolves them from the project directory,
// and the cell reads the project as one file at the checkout's root: a file
// in docker/ whose build context is ".." (the repository) would name the
// checkout's parent and be refused as outside the project. Only what
// compose reads as a host path is touched: a build context, an env file and
// a bind mount's source. A path that still leaves the checkout stays so,
// for the sandbox to refuse. It runs on a file as it was read, before the
// files are laid over each other, so a !override value is rebased too.
func rebaseHostPaths(doc map[string]any, base string) {
	if base == "." || base == "" {
		return
	}
	_, sv := marker(doc["services"])
	services, _ := sv.(map[string]any)
	for _, v := range services {
		_, in := marker(v)
		svc, _ := in.(map[string]any)
		if svc == nil {
			continue
		}
		for _, key := range []string{"build", "env_file", "volumes"} {
			tag, val := marker(svc[key])
			if tag == resetKey || val == nil {
				continue
			}
			val = rebaseField(key, val, base)
			if tag == overrideKey {
				val = map[string]any{overrideKey: val}
			}
			svc[key] = val
		}
	}
}

// rebaseField returns one service field with its host paths rebased; maps
// and lists are changed in place.
func rebaseField(key string, v any, base string) any {
	switch key {
	case "build":
		switch b := v.(type) {
		case string:
			return rebased(base, b)
		case map[string]any:
			if ctx, ok := b["context"].(string); ok {
				b["context"] = rebased(base, ctx)
			} else if b["context"] == nil {
				// No context is the project directory.
				b["context"] = rebased(base, ".")
			}
		}
	case "env_file":
		switch ef := v.(type) {
		case string:
			return rebased(base, ef)
		case []any:
			for i, f := range ef {
				switch x := f.(type) {
				case string:
					ef[i] = rebased(base, x)
				case map[string]any:
					if s, ok := x["path"].(string); ok {
						x["path"] = rebased(base, s)
					}
				}
			}
		}
	case "volumes":
		vols, _ := v.([]any)
		for i, vol := range vols {
			switch x := vol.(type) {
			case string:
				// "source:target[:mode]": a source compose reads as a path starts with "." (or "/", "~": left as they are).
				if src, rest, ok := strings.Cut(x, ":"); ok && strings.HasPrefix(src, ".") {
					vols[i] = rebased(base, src) + ":" + rest
				}
			case map[string]any:
				if t, _ := x["type"].(string); t == "bind" {
					if src, ok := x["source"].(string); ok {
						x["source"] = rebased(base, src)
					}
				}
			}
		}
	}
	return v
}

// rebased is the relative host path p, read from base, as a path from the
// checkout: "./..." so it stays a path and never becomes a volume's name.
// Absolute, remote, interpolated and home paths are returned as they are.
func rebased(base, p string) string {
	if p == "" || strings.HasPrefix(p, "/") || strings.HasPrefix(p, "~") || strings.Contains(p, "$") || strings.Contains(p, "://") || strings.HasPrefix(p, "git@") {
		return p
	}
	joined := path.Join(base, filepath.ToSlash(p))
	if joined == "." || joined == ".." || strings.HasPrefix(joined, "../") {
		return joined
	}
	return "./" + joined
}

// SingleService is a one-service project that builds the checkout's
// Dockerfile: how a repo without a compose file runs.
func SingleService(name string) *Project {
	return &Project{doc: map[string]any{"services": map[string]any{name: map[string]any{"build": map[string]any{"context": "."}}}}}
}

// FromYAML is a project from a compose file's contents.
func FromYAML(b []byte) (*Project, error) {
	node, err := yamlbound.Parse(b)
	if err != nil {
		return nil, fmt.Errorf("compose: %w", err)
	}
	var doc map[string]any
	if err := node.Decode(&doc); err != nil {
		return nil, fmt.Errorf("compose: %w", err)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	return &Project{doc: doc}, nil
}

// ServiceNames are the project's services, sorted.
func (p *Project) ServiceNames() []string {
	names := make([]string, 0, len(p.services()))
	for n := range p.services() {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// HasService reports whether the project defines the service.
func (p *Project) HasService(name string) bool {
	_, ok := p.services()[name]
	return ok
}

// Service is one service's definition, nil when the project has none by
// that name. Changes to it change the project.
func (p *Project) Service(name string) map[string]any {
	s, _ := p.services()[name].(map[string]any)
	return s
}

// Marshal is the project as a compose file.
func (p *Project) Marshal() ([]byte, error) { return yaml.Marshal(p.doc) }

func (p *Project) services() map[string]any {
	s, _ := p.doc["services"].(map[string]any)
	return s
}

// eachService calls f with every service, in name order, as a mutable map.
// A service written as null becomes an empty mapping; anything else that is
// not a mapping is an error.
func (p *Project) eachService(f func(name string, svc map[string]any) error) error {
	services := p.services()
	if len(services) == 0 {
		return errors.New("compose: the project has no services")
	}
	for _, name := range p.ServiceNames() {
		svc, ok := services[name].(map[string]any)
		if !ok {
			if services[name] != nil {
				return fmt.Errorf("compose: service %q is not a mapping", name)
			}
			svc = map[string]any{}
			services[name] = svc
		}
		if err := f(name, svc); err != nil {
			return err
		}
	}
	return nil
}

// NamedVolumes are the project's named volumes that a service compose
// starts mounts (a service behind a profile does not start), by service:
// what has to be stopped and copied to snapshot the project's data.
func (p *Project) NamedVolumes() map[string][]string {
	declared, _ := p.doc["volumes"].(map[string]any)
	out := map[string][]string{}
	for _, name := range p.ServiceNames() {
		svc := p.Service(name)
		if svc == nil || svc["profiles"] != nil {
			continue
		}
		vols, _ := svc["volumes"].([]any)
		seen := map[string]bool{}
		for _, v := range vols {
			var src string
			switch x := v.(type) {
			case string:
				if parts := strings.SplitN(x, ":", 2); len(parts) == 2 {
					src = parts[0]
				}
			case map[string]any:
				if t, _ := x["type"].(string); t == "volume" {
					src, _ = x["source"].(string)
				}
			}
			if _, ok := declared[src]; ok && src != "" && !seen[src] {
				seen[src] = true
				out[name] = append(out[name], src)
			}
		}
		sort.Strings(out[name])
	}
	return out
}

// inside runs fn on dir opened as an os.Root, so no path step leaves dir.
func inside[T any](dir string, fn func(*os.Root) (T, error)) (T, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		var zero T
		return zero, err
	}
	defer func() { _ = root.Close() }()
	return fn(root)
}

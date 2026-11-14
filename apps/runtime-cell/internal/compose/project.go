// Package compose reads a checkout's docker compose project and adapts it
// to run in a cell, as data: no docker binary here. Each adaptation is one
// method named for what it does, so a driver composes the ones it needs and
// each is tested on its own.
package compose

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

// DefaultFiles are the files docker compose looks for, in its order.
var DefaultFiles = []string{"compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"}

// ErrNoComposeFile: the checkout has none of DefaultFiles.
var ErrNoComposeFile = errors.New("compose: the checkout has no compose file")

// Project is a compose project as docker compose reads it. It is a plain
// YAML tree because compose has far more keys than the cell cares about,
// and every key it does not touch must survive untouched.
type Project struct {
	doc map[string]any
}

// Load reads the project from dir. With files (a recipe's), each must
// exist and they lay over each other in order, like docker compose -f a -f
// b; without, the first of DefaultFiles that exists.
func Load(dir string, files []string) (*Project, error) {
	if len(files) == 0 {
		for _, name := range DefaultFiles {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				files = []string{name}
				break
			}
		}
		if len(files) == 0 {
			return nil, ErrNoComposeFile
		}
	}
	var doc map[string]any
	for _, f := range files {
		b, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			return nil, fmt.Errorf("compose: %w", err)
		}
		var node yaml.Node
		if err := yaml.Unmarshal(b, &node); err != nil {
			return nil, fmt.Errorf("compose: %s: %w", f, err)
		}
		if err := markMergeTags(&node); err != nil {
			return nil, fmt.Errorf("compose: %s: %w", f, err)
		}
		var layer map[string]any
		if err := node.Decode(&layer); err != nil {
			return nil, fmt.Errorf("compose: %s: %w", f, err)
		}
		doc = overlay(doc, layer)
	}
	if doc == nil {
		doc = map[string]any{}
	}
	clean, _ := unmark(doc)
	doc, _ = clean.(map[string]any)
	return &Project{doc: doc}, nil
}

// SingleService is a one-service project that builds the checkout's
// Dockerfile: how a repo without a compose file runs.
func SingleService(name string) *Project {
	return &Project{doc: map[string]any{"services": map[string]any{name: map[string]any{"build": map[string]any{"context": "."}}}}}
}

// FromYAML is a project from a compose file's contents.
func FromYAML(b []byte) (*Project, error) {
	var doc map[string]any
	if err := yaml.Unmarshal(b, &doc); err != nil {
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

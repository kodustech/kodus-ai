package compose

import (
	"fmt"
	"sort"
	"strings"
)

// NodeCoverage is where a Run's Node services write V8 coverage (feature
// exercisedLines): Dir, the container path NODE_V8_COVERAGE names, and
// Preload, a CommonJS file NODE_OPTIONS requires so SIGUSR2 flushes the
// coverage (v8.takeCoverage) without stopping the service. Both are
// container paths: the driver mounts the claim's files there
// (sandbox.Options.Coverage, which also keeps any checkout off them).
type NodeCoverage struct {
	Dir, Preload string
}

// PreloadSource is the preload: SIGUSR2 writes the coverage so far
// (https://nodejs.org/api/v8.html#v8takecoverage; each call resets the
// counters, so the reader unions every file it finds).
const PreloadSource = "process.on('SIGUSR2', () => require('v8').takeCoverage());\n"

// IsNodeImage says whether an image is a Node one by its repository's last
// segment (node, library/node, cimg/node). A built service says nothing
// here and is left out.
func IsNodeImage(image string) bool {
	repo := image
	if i := strings.LastIndex(repo, "/"); i >= 0 {
		repo = repo[i+1:]
	}
	if i := strings.IndexAny(repo, ":@"); i >= 0 {
		repo = repo[:i]
	}
	return repo == "node"
}

// AddNodeCoverage gives each Node service (IsNodeImage) NODE_V8_COVERAGE
// and the preload, appended to the service's own NODE_OPTIONS, never in
// place of it; it mounts nothing. It returns the services it instrumented, in
// order. The caller applies it to a Run's PR and base claims only, never to
// a setup or a bake.
func (p *Project) AddNodeCoverage(c NodeCoverage) ([]string, error) {
	if c.Dir == "" || c.Preload == "" {
		return nil, fmt.Errorf("compose: node coverage needs a dir and a preload")
	}
	var names []string
	err := p.eachService(func(name string, svc map[string]any) error {
		if !IsNodeImage(imageOf(svc)) {
			return nil
		}
		env, err := environmentMap(svc["environment"])
		if err != nil {
			return fmt.Errorf("compose: service %q: %w", name, err)
		}
		require := "--require=" + c.Preload
		if own, ok := env["NODE_OPTIONS"].(string); ok && strings.TrimSpace(own) != "" {
			env["NODE_OPTIONS"] = own + " " + require
		} else {
			env["NODE_OPTIONS"] = require
		}
		env["NODE_V8_COVERAGE"] = c.Dir
		svc["environment"] = env
		names = append(names, name)
		return nil
	})
	sort.Strings(names)
	return names, err
}

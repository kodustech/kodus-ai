package compose

import (
	"fmt"
	"path"
	"slices"
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

// PreloadSource is the preload. It leaves the process's start marker in the
// coverage directory (started-<pid>-<ms>, exercised.StartMarkerPrefix: a
// coverage file counts only from a process it started), never failing the
// process, and SIGUSR2 writes the coverage so far
// (https://nodejs.org/api/v8.html#v8takecoverage; each call resets the
// counters, so the reader unions every file it finds).
const PreloadSource = "try { require('fs').writeFileSync(require('path').join(process.env.NODE_V8_COVERAGE, 'started-' + process.pid + '-' + Date.now()), ''); } catch (e) {}\n" +
	"process.on('SIGUSR2', () => require('v8').takeCoverage());\n"

// IsNodeImage says whether an image is a Node one by its repository's last
// segment (node, library/node, cimg/node). A built service is decided by
// its image's config instead (IsNodeImageConfig).
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
// place of it; it mounts nothing. A service with a build section is left
// to its built image (AddBuiltNodeCoverage): the name it tags the image
// with says nothing of what the Dockerfile made. It returns the services it
// instrumented, in order. The caller applies it to a Run's PR and base
// claims only, never to a setup or a bake.
func (p *Project) AddNodeCoverage(c NodeCoverage) ([]string, error) {
	if c.Dir == "" || c.Preload == "" {
		return nil, fmt.Errorf("compose: node coverage needs a dir and a preload")
	}
	var names []string
	err := p.eachService(func(name string, svc map[string]any) error {
		if _, built := svc["build"]; built || !IsNodeImage(imageOf(svc)) {
			return nil
		}
		ok, err := instrumentNode(name, svc, c, "")
		if ok {
			names = append(names, name)
		}
		return err
	})
	sort.Strings(names)
	return names, err
}

// ImageConfig is what a built image's config says of how it runs (docker
// image inspect: Config.Env, Config.Entrypoint, Config.Cmd).
type ImageConfig struct {
	Env, Entrypoint, Cmd []string
}

// nodeCommands are the programs a Node service starts with.
var nodeCommands = map[string]bool{"node": true, "npm": true, "npx": true, "pnpm": true, "yarn": true, "tsx": true}

// IsNodeImageConfig says whether a built image runs Node, from its config
// alone: the official images' NODE_VERSION (every image FROM node keeps
// it), or a command whose program is one of nodeCommands, as the first
// argument or as the first word of a shell's -c. An entrypoint script or
// a wrapper says nothing, so the image is not Node.
func IsNodeImageConfig(c ImageConfig) bool {
	for _, kv := range c.Env {
		if v, ok := strings.CutPrefix(kv, "NODE_VERSION="); ok && v != "" {
			return true
		}
	}
	return runsNode(append(slices.Clone(c.Entrypoint), c.Cmd...))
}

// runsNode: argv starts a Node program.
func runsNode(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	prog := path.Base(argv[0])
	if (prog == "sh" || prog == "bash" || prog == "ash") && len(argv) >= 3 && argv[1] == "-c" {
		words := strings.Fields(argv[2])
		if len(words) > 1 && words[0] == "exec" {
			words = words[1:]
		}
		return len(words) > 0 && nodeCommands[path.Base(words[0])]
	}
	return nodeCommands[prog]
}

// AddBuiltNodeCoverage instruments the services built from a Dockerfile
// whose image runs Node (images: the built image's config by service),
// after the build: NODE_V8_COVERAGE, and NODE_OPTIONS as the service sets
// it, else as the image sets it, with the preload appended. What runs is
// the service's own command and entrypoint over the image's (an
// entrypoint of the service's clears the image's command, as in Docker).
// An image NODE_OPTIONS with a $ is left out: compose would interpolate
// it. It returns the services it instrumented, in order.
func (p *Project) AddBuiltNodeCoverage(c NodeCoverage, images map[string]ImageConfig) ([]string, error) {
	if c.Dir == "" || c.Preload == "" {
		return nil, fmt.Errorf("compose: node coverage needs a dir and a preload")
	}
	var names []string
	err := p.eachService(func(name string, svc map[string]any) error {
		img, ok := images[name]
		if _, built := svc["build"]; !built || !ok {
			return nil
		}
		run := img
		if ep, ok := argvOf(svc["entrypoint"]); ok {
			run.Entrypoint, run.Cmd = ep, nil
		}
		if cmd, ok := argvOf(svc["command"]); ok {
			run.Cmd = cmd
		}
		if !IsNodeImageConfig(ImageConfig{Env: img.Env, Entrypoint: run.Entrypoint, Cmd: run.Cmd}) {
			return nil
		}
		base := ""
		for _, kv := range img.Env {
			if v, ok := strings.CutPrefix(kv, "NODE_OPTIONS="); ok {
				base = v
			}
		}
		if strings.Contains(base, "$") {
			return nil
		}
		ok, err := instrumentNode(name, svc, c, base)
		if ok {
			names = append(names, name)
		}
		return err
	})
	sort.Strings(names)
	return names, err
}

// argvOf reads a compose command or entrypoint: a list, or a string split
// as compose splits it (on spaces; a quoted string is not taken apart and
// reads as not set).
func argvOf(v any) ([]string, bool) {
	switch x := v.(type) {
	case []any:
		out := make([]string, 0, len(x))
		for _, a := range x {
			s, ok := a.(string)
			if !ok {
				return nil, false
			}
			out = append(out, s)
		}
		return out, true
	case string:
		if strings.ContainsAny(x, `"'\`) {
			return nil, false
		}
		return strings.Fields(x), true
	}
	return nil, false
}

// instrumentNode sets NODE_V8_COVERAGE and appends the preload to the
// service's NODE_OPTIONS, or to base when it sets none.
func instrumentNode(name string, svc map[string]any, c NodeCoverage, base string) (bool, error) {
	env, err := environmentMap(svc["environment"])
	if err != nil {
		return false, fmt.Errorf("compose: service %q: %w", name, err)
	}
	require := "--require=" + c.Preload
	if own, ok := env["NODE_OPTIONS"].(string); ok && strings.TrimSpace(own) != "" {
		base = own
	}
	if strings.TrimSpace(base) != "" {
		env["NODE_OPTIONS"] = base + " " + require
	} else {
		env["NODE_OPTIONS"] = require
	}
	env["NODE_V8_COVERAGE"] = c.Dir
	svc["environment"] = env
	return true, nil
}

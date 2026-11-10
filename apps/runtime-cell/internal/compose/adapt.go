package compose

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// The adaptations a cell makes to a checkout's project so that two claims,
// or the base and the PR of one Run, run side by side on one Docker without
// meeting: no fixed host ports or container names, no shared images or
// networks, and labels the sweep finds them by. None of it is a security
// boundary; the gVisor driver has its own allowlist for that.

// Port is a container port of a service, as a recipe or a claim names it.
// An empty Service means the project's only service.
type Port struct {
	Service string
	Port    int
}

// PublishedPort is a requested Port and the service that publishes it.
type PublishedPort struct {
	Port
	ComposeService string
}

// PublishOnLoopback replaces the checkout's port bindings with one binding
// per requested port, on 127.0.0.1 at a port Docker picks. The checkout's
// own bindings would collide between claims and listen on every interface.
func (p *Project) PublishOnLoopback(ports []Port) ([]PublishedPort, error) {
	services := p.services()
	if len(services) == 0 {
		return nil, errors.New("compose: the project has no services")
	}
	bindings := map[string][]any{}
	published := make([]PublishedPort, 0, len(ports))
	for _, port := range ports {
		svc := port.Service
		if svc == "" && len(services) == 1 {
			svc = p.ServiceNames()[0]
		}
		if !p.HasService(svc) {
			return nil, fmt.Errorf("compose: exposed service %q is not in the project", port.Service)
		}
		if port.Port < 1 || port.Port > 65535 {
			return nil, fmt.Errorf("compose: bad exposed port %d", port.Port)
		}
		bindings[svc] = append(bindings[svc], "127.0.0.1::"+strconv.Itoa(port.Port))
		published = append(published, PublishedPort{Port: port, ComposeService: svc})
	}
	err := p.eachService(func(name string, svc map[string]any) error {
		delete(svc, "ports")
		if b := bindings[name]; len(b) > 0 {
			svc["ports"] = b
		}
		return nil
	})
	return published, err
}

// DropContainerNames lets compose name the containers after the project:
// a fixed container_name collides between claims.
func (p *Project) DropContainerNames() error {
	return p.eachService(func(_ string, svc map[string]any) error {
		delete(svc, "container_name")
		return nil
	})
}

// AddLabels puts labels on every service. A checkout label with
// reservedPrefix is refused: it could forge what the sweep reads (an expiry
// far in the future).
func (p *Project) AddLabels(labels map[string]string, reservedPrefix string) error {
	return p.eachService(func(name string, svc map[string]any) error {
		merged, err := labelMap(svc["labels"])
		if err != nil {
			return fmt.Errorf("compose: service %q: %w", name, err)
		}
		for k := range merged {
			if reservedPrefix != "" && strings.HasPrefix(k, reservedPrefix) {
				return fmt.Errorf("compose: service %q: label %s is reserved", name, k)
			}
		}
		for k, v := range labels {
			merged[k] = v
		}
		svc["labels"] = merged
		return nil
	})
}

// AddEnvironment gives every service the recipe's services.compose.env
// (what a blocker fix such as set_env writes). The recipe's value wins over
// the service's own: it is the one written for this machine, and a
// "${NAME}" in the compose file reads the cell's environment, which the
// docker-gvisor driver never passes. A '$' in a value is escaped so compose
// hands it to the container as written.
func (p *Project) AddEnvironment(env map[string]string) error {
	if len(env) == 0 {
		return nil
	}
	return p.eachService(func(name string, svc map[string]any) error {
		merged, err := environmentMap(svc["environment"])
		if err != nil {
			return fmt.Errorf("compose: service %q: %w", name, err)
		}
		for k, v := range env {
			merged[k] = strings.ReplaceAll(v, "$", "$$")
		}
		svc["environment"] = merged
		return nil
	})
}

// environmentMap reads environment written as a mapping or as a list of
// k=v; a bare name in the list (its value comes from compose's own
// environment) stays a name with no value.
func environmentMap(environment any) (map[string]any, error) {
	out := map[string]any{}
	switch e := environment.(type) {
	case nil:
	case map[string]any:
		for k, v := range e {
			out[k] = v
		}
	case []any:
		for _, kv := range e {
			s, ok := kv.(string)
			if !ok {
				return nil, errors.New("environment list entry is not a string")
			}
			if k, v, found := strings.Cut(s, "="); found {
				out[k] = v
			} else {
				out[k] = nil
			}
		}
	default:
		return nil, errors.New("environment is neither a mapping nor a list")
	}
	return out, nil
}

// labelMap reads labels written as a mapping or as a list of k=v.
func labelMap(labels any) (map[string]any, error) {
	out := map[string]any{}
	switch l := labels.(type) {
	case nil:
	case map[string]any:
		for k, v := range l {
			out[k] = v
		}
	case []any:
		for _, kv := range l {
			s, ok := kv.(string)
			if !ok {
				return nil, errors.New("labels list entry is not a string")
			}
			k, v, _ := strings.Cut(s, "=")
			out[k] = v
		}
	default:
		return nil, errors.New("labels is neither a mapping nor a list")
	}
	return out, nil
}

// BuiltImageName is the name docker compose gives the image it builds for
// a service with no image key. Compose labels that image with the project,
// which is how a destroy finds it.
func BuiltImageName(project, service string) string { return project + "-" + service }

// NameBuiltImagesAfterProject gives each image the project builds a name
// of its own. A checkout tags its build with a fixed name (kodus-ai:
// kodus-ai-dev:latest for api, worker and webhooks), so the base and the PR
// of one Run would build over each other's image, and compose builds a
// shared tag once per service, in parallel, racing on the export.
//
// Each tag is built once, by the first service (in name order) that builds
// it, under BuiltImageName; every other service that names the tag runs
// that image instead, including one that only runs it and would otherwise
// pull a stale copy. It returns the services whose image comes from a
// registry: `docker compose pull` looks for the project's own images in a
// registry too, whatever the pull policy, so those are pulled by name.
func (p *Project) NameBuiltImagesAfterProject(project string) (pullFromRegistry []string, err error) {
	builtBy := map[string]string{}
	for _, name := range p.ServiceNames() {
		svc := p.Service(name)
		if tag := imageOf(svc); svc != nil && svc["build"] != nil && tag != "" && builtBy[tag] == "" {
			if project == "" {
				return nil, errors.New("compose: naming a built image needs the project name")
			}
			builtBy[tag] = name
		}
	}
	err = p.eachService(func(name string, svc map[string]any) error {
		tag := imageOf(svc)
		switch builder := builtBy[tag]; {
		case builder == name:
			delete(svc, "image")
		case builder != "":
			delete(svc, "build")
			svc["image"] = BuiltImageName(project, builder)
		case svc["build"] == nil && tag != "":
			pullFromRegistry = append(pullFromRegistry, name)
		}
		return nil
	})
	return pullFromRegistry, err
}

func imageOf(svc map[string]any) string {
	tag, _ := svc["image"].(string)
	return tag
}

// MakeExternalVolumesPrivate does for volumes what
// MakeExternalNetworksPrivate does for networks: a volume declared external
// or with a fixed name is shared by every stack that names it (base and PR
// would write the same database), so it becomes the project's own.
func (p *Project) MakeExternalVolumesPrivate() {
	volumes, _ := p.doc["volumes"].(map[string]any)
	for name, v := range volumes {
		n, ok := v.(map[string]any)
		if !ok {
			continue
		}
		delete(n, "external")
		delete(n, "name")
		volumes[name] = n
	}
}

// MakeExternalNetworksPrivate turns the networks a checkout declares
// external (made once on the host, shared by every stack that names them)
// into the project's own: two claims never share a network, nor answer for
// each other's service names on it.
func (p *Project) MakeExternalNetworksPrivate() {
	networks, _ := p.doc["networks"].(map[string]any)
	for name, v := range networks {
		n, ok := v.(map[string]any)
		if !ok {
			continue
		}
		if external, _ := n["external"].(bool); external {
			delete(n, "external")
			delete(n, "name")
			networks[name] = n
		}
	}
}

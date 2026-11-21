package compose

import (
	"fmt"
	"sort"
)

// ActivateProfiles leaves the project with exactly the services docker
// compose starts with --profile for each of profiles: a service with no
// profiles, or with one of them, stays, without its profiles key; every
// other service goes. The cell runs the adapted file with no --profile and
// no COMPOSE_PROFILES (the recipe may not set it), so the file itself must
// say what starts. With no profiles it changes nothing: a service behind a
// profile stays in the file and compose does not start it.
//
// A service that stays and depends on one that goes is an error: compose
// would refuse the file, and the recipe has to list that profile too.
func (p *Project) ActivateProfiles(profiles []string) error {
	if len(profiles) == 0 {
		return nil
	}
	asked := map[string]bool{}
	for _, pr := range profiles {
		asked[pr] = true
	}
	services := p.services()
	if len(services) == 0 {
		return nil
	}
	dropped := map[string]bool{}
	for _, name := range p.ServiceNames() {
		svc, _ := services[name].(map[string]any)
		if svc == nil || svc["profiles"] == nil {
			continue
		}
		list, ok := svc["profiles"].([]any)
		if !ok {
			return fmt.Errorf("compose: service %q: profiles must be a list", name)
		}
		keep := false
		for _, v := range list {
			if s, _ := v.(string); asked[s] {
				keep = true
			}
		}
		if keep {
			delete(svc, "profiles")
		} else {
			delete(services, name)
			dropped[name] = true
		}
	}
	for _, name := range p.ServiceNames() {
		svc, _ := services[name].(map[string]any)
		for _, dep := range dependsOn(svc) {
			if dropped[dep] {
				return fmt.Errorf("compose: service %q depends on %q, which none of the recipe's profiles starts", name, dep)
			}
		}
	}
	return nil
}

// dependsOn is a service's depends_on in either compose form, sorted.
func dependsOn(svc map[string]any) []string {
	var out []string
	switch d := svc["depends_on"].(type) {
	case []any:
		for _, v := range d {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	case map[string]any:
		for k := range d {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

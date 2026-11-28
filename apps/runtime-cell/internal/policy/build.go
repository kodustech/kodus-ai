package policy

import (
	"fmt"
	"slices"
)

// Build denial reasons, as egress.blocked names them.
const (
	// BuildNeedsInspection: an image build asked for a host it may not reach
	// uninspected, and the cell cannot inspect it there (a builder whose RUN
	// steps keep their base image's trust store, or a host with no inspected
	// rule). The blocker offers the mirror or full access.
	BuildNeedsInspection = "build_needs_inspection"
)

// FromBuild reports whether the source is the claim's image builder.
func (p ClaimPolicy) FromBuild(source string) bool {
	return slices.Contains(p.BuildSources, source)
}

// BuildRefuses decides a connection of the image builder: "" lets it go,
// else the reason it is refused. tlsMode is a ClientHello; plain HTTP to a
// host with an inspected rule goes on to the rule's own check. A builder that
// trusts the cell CA (an inspect source) also reaches over TLS what the
// injector reads for it: an inspected host (GET and HEAD under its paths) and
// a secret's host (the placeholder swapped for the value).
func (p ClaimPolicy) BuildRefuses(source, host string, tlsMode bool) string {
	if !p.FromBuild(source) || slices.Contains(p.BuildPassthrough, host) {
		return ""
	}
	if !tlsMode {
		if _, ok := p.Inspects(host); ok {
			return ""
		}
		return BuildNeedsInspection
	}
	if p.InspectsFrom(host, source) || (slices.Contains(p.InspectSources, source) && p.Injects(host)) {
		return ""
	}
	return BuildNeedsInspection
}

// withBuild keeps the build sources that are the claim's and the build
// passthrough hosts that are on its allowlist, sorted. A trusted builder's
// sources join the inspect sources, with or without an inspected host: a
// secret's host goes through the injector too.
func withBuild(p *ClaimPolicy, sources, passthrough []string, trusted bool) {
	for _, s := range sources {
		if slices.Contains(p.Sources, s) && !slices.Contains(p.BuildSources, s) {
			p.BuildSources = append(p.BuildSources, s)
		}
	}
	if len(p.BuildSources) == 0 {
		return
	}
	slices.Sort(p.BuildSources)
	if trusted {
		for _, s := range p.BuildSources {
			if !slices.Contains(p.InspectSources, s) {
				p.InspectSources = append(p.InspectSources, s)
			}
		}
		slices.Sort(p.InspectSources)
	}
	for _, h := range passthrough {
		if p.Allows(h) && !slices.Contains(p.BuildPassthrough, h) {
			p.BuildPassthrough = append(p.BuildPassthrough, h)
		}
	}
	slices.Sort(p.BuildPassthrough)
}

func (p ClaimPolicy) validateBuild() error {
	for _, s := range p.BuildSources {
		if !slices.Contains(p.Sources, s) {
			return fmt.Errorf("policy: build source %q is not a source of the claim", s)
		}
	}
	for _, h := range p.BuildPassthrough {
		if !p.Allows(h) {
			return fmt.Errorf("policy: build passthrough host %q is not on the allowlist", h)
		}
	}
	return nil
}

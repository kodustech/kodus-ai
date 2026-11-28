package netguard

import (
	"fmt"
	"slices"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// The Kodus deny list applies over any allowlist, recipe or admin approval:
// generic storage and paste sites (exfiltration), tunnels (a way back in),
// LLM APIs (a cell never pays for the PR's model calls), DNS over HTTPS (DNS
// goes through the cell resolver only) and local names. It is the API's list
// too: lists.go reads it from egress-lists.json, the byte copy of
// libs/runtime/protocol/egress-lists.json (G2).

// OwnedHosts are exact hosts the cell itself owns (its evidence bucket): the
// only names the deny list lets through.
type OwnedHosts []string

// ParseOwnedHosts reads a comma-separated flag value, normalized.
func ParseOwnedHosts(s string) OwnedHosts { return OwnedHosts(parseHosts(s)) }

func parseHosts(s string) []string {
	var out []string
	for _, h := range strings.Split(s, ",") {
		h = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(h)), ".")
		if h != "" {
			out = append(out, h)
		}
	}
	return out
}

// OnKodusDenyList reports whether the (normalized) host is on the Kodus deny
// list and is not one of owned.
func OnKodusDenyList(host string, owned OwnedHosts) bool {
	if slices.Contains(owned, host) {
		return false
	}
	return onKodusList(host)
}

// onKodusList: the cell's own names (the claim's app, the mirror) are under
// .internal, which the list denies to every approval; they never come from
// one, the resolver answers them itself.
func onKodusList(host string) bool {
	if host == policy.AppHost || host == policy.MirrorHost {
		return false
	}
	return kodusDeny.MatchString(host)
}

// DenyList is every host no allowlist, recipe or admin approval reaches: the
// Kodus list, the operator's own additions, minus the hosts the cell owns.
// The proxy and the resolver both ask it. Its zero value is the Kodus list
// alone, so a component nobody configured still refuses it.
type DenyList struct {
	exact  map[string]bool
	suffix []string
	owned  OwnedHosts
}

// NewDenyList adds the operator's hosts to the Kodus list. An entry is an
// exact host ("files.corp.example") or, with a leading dot, every name under
// a domain (".corp.example"). Wildcards are refused: the list says exactly
// what it denies. owned are let through, and only the Kodus list's entries:
// an operator who denies a host the cell owns has said so on purpose.
func NewDenyList(extra []string, owned OwnedHosts) (DenyList, error) {
	l := DenyList{exact: map[string]bool{}, owned: owned}
	for _, e := range extra {
		e = strings.TrimSpace(e)
		if e == "" {
			continue
		}
		if strings.Contains(e, "*") {
			return DenyList{}, fmt.Errorf("netguard: deny entry %q: write .domain for a whole domain, no wildcards", e)
		}
		raw, isSuffix := strings.CutPrefix(e, ".")
		host, err := policy.NormalizeHost(raw)
		if err != nil {
			return DenyList{}, fmt.Errorf("netguard: deny entry %q: %w", e, err)
		}
		if isSuffix {
			l.suffix = append(l.suffix, "."+host)
			l.exact[host] = true // the domain itself too
		} else {
			l.exact[host] = true
		}
	}
	return l, nil
}

// ParseDenyList reads the operator's comma-separated -deny-hosts value.
func ParseDenyList(s string, owned OwnedHosts) (DenyList, error) {
	return NewDenyList(parseHosts(s), owned)
}

// Denies reports whether the (normalized) host is denied.
func (l DenyList) Denies(host string) bool {
	if l.exact[host] {
		return true
	}
	for _, s := range l.suffix {
		if strings.HasSuffix(host, s) {
			return true
		}
	}
	return OnKodusDenyList(host, l.owned)
}

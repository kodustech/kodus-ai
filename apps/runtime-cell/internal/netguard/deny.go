package netguard

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// The Kodus deny list applies over any allowlist, recipe or admin approval:
// generic storage and paste sites (exfiltration), tunnels (a way back in),
// LLM APIs (a cell never pays for the PR's model calls) and DNS over HTTPS
// (DNS goes through the cell resolver only).
var denyExact = map[string]bool{
	"s3.amazonaws.com": true, "storage.googleapis.com": true, "storage.cloud.google.com": true,
	"pastebin.com": true, "transfer.sh": true, "file.io": true, "ngrok.io": true, "0x0.st": true,
	"webhook.site": true, "requestbin.com": true, "hookbin.com": true, "pipedream.net": true,
	"paste.ee": true, "hastebin.com": true, "termbin.com": true, "temp.sh": true, "gofile.io": true,
	"api.openai.com": true, "api.anthropic.com": true, "generativelanguage.googleapis.com": true,
	"dns.google": true, "dns.google.com": true, "cloudflare-dns.com": true, "mozilla.cloudflare-dns.com": true,
	"one.one.one.one": true, "dns.quad9.net": true, "doh.opendns.com": true, "dns.nextdns.io": true,
	"doh.cleanbrowsing.org": true, "dns.adguard-dns.com": true,
}

var denySuffix = []string{
	".blob.core.windows.net", ".file.core.windows.net", ".dfs.core.windows.net",
	".ngrok.io", ".ngrok-free.app", ".ngrok.app", ".ngrok.dev", ".trycloudflare.com", ".loca.lt", ".serveo.net",
	".pastebin.com", ".transfer.sh", ".file.io", ".webhook.site", ".requestbin.net", ".pipedream.net",
	".storage.googleapis.com", ".googleusercontent.com", ".r2.cloudflarestorage.com", ".r2.dev",
	".digitaloceanspaces.com", ".backblazeb2.com", ".wasabisys.com", ".linodeobjects.com",
	".openai.azure.com",
}

// s3Host is every S3 endpoint spelling: s3.amazonaws.com, s3.<region>,
// s3-<region> (legacy), s3-accelerate, s3.dualstack.<region>, and each of
// them with a bucket in front (virtual-hosted style).
var s3Host = regexp.MustCompile(`(^|\.)s3([.-][a-z0-9-]+)*\.amazonaws\.com(\.cn)?$`)

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

func onKodusList(host string) bool {
	if denyExact[host] || s3Host.MatchString(host) {
		return true
	}
	for _, s := range denySuffix {
		if strings.HasSuffix(host, s) {
			return true
		}
	}
	return false
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

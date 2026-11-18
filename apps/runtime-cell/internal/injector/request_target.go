package injector

import (
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Refusal codes of a request target the injector does not send on, as its
// logs name them.
const (
	targetForm = "request_target_form"
	targetHost = "request_target_host"
)

// upstreamURL is where a request from the VM goes: https, to host (the TLS
// name the proxy validated), with the request's own path and query, and
// nothing else of what the VM wrote. It refuses ("" is accepted):
//
//   - an opaque target ("https:@evil.example/steal"): its URL has no host,
//     so the Host header passed the check, and gluing the host in front of
//     it made the host userinfo and evil.example the destination;
//   - userinfo, the asterisk form, and any target that is neither
//     origin-form ("/path") nor absolute-form to host itself (scheme https,
//     port empty or 443, RFC 9112 §3.2.2), which it treats like origin-form;
//   - a path that does not start with "/".
//
// The outbound URL is built field by field, never by string concatenation,
// so no byte of the target can move the destination.
func upstreamURL(r *http.Request, host string) (*url.URL, string) {
	u := r.URL
	if u == nil || u.Opaque != "" || u.User != nil || u.Fragment != "" {
		return nil, targetForm
	}
	if !strings.HasPrefix(r.RequestURI, "/") {
		// Absolute-form: only to the TLS name itself.
		if !strings.EqualFold(u.Scheme, "https") || u.Host == "" {
			return nil, targetForm
		}
		if port := u.Port(); port != "" && port != defaultUpstreamPort || !strings.EqualFold(u.Hostname(), host) {
			return nil, targetHost
		}
	}
	if !strings.HasPrefix(u.Path, "/") {
		return nil, targetForm
	}
	return &url.URL{Scheme: "https", Host: host, Path: u.Path, RawPath: u.RawPath, RawQuery: u.RawQuery}, ""
}

// refuseTarget answers a request whose target upstreamURL refused: it never
// left the cell. The body is fixed text, never the request.
func (in *Injector) refuseTarget(w http.ResponseWriter, info connInfo, why string) {
	in.Log.Warn("injector.target_refused", "claim", info.pol.ClaimID, "host", info.host, "code", why)
	if why == targetHost {
		http.Error(w, "host does not match the TLS name", http.StatusMisdirectedRequest)
		return
	}
	http.Error(w, "request target not accepted", http.StatusBadRequest)
}

// newUpstreamRequest is the outbound request for target (from upstreamURL),
// with Host set to the TLS name.
func newUpstreamRequest(r *http.Request, target *url.URL, host string, body io.Reader) (*http.Request, error) {
	out, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), body) //nolint:gosec // G704: target is https://<host><path>, built field by field by upstreamURL, and upstream dials only the address the proxy validated
	if err != nil {
		return nil, err
	}
	out.URL = target
	out.Host = host
	return out, nil
}

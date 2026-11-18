package injector

import (
	"bytes"
	"io"
	"net/http"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/redact"
)

// refuseInspected answers a request the inspected rule refused (S-53, S-56):
// it never left the cell. The machine reads why in the body; the reason is
// a fixed code, never the request.
func (in *Injector) refuseInspected(w http.ResponseWriter, info connInfo, why string) {
	in.Metrics.inspect(why)
	in.Log.Warn("injector.inspect.refused", "claim", info.pol.ClaimID, "host", info.host, "reason", why)
	http.Error(w, "refused by the cell's egress inspection ("+why+"): only reads under the host's approved paths leave the cell", http.StatusForbidden)
}

// proxyInspected relays a request the inspected rule allowed, to the address
// the proxy validated, with no credential: the answer goes back as it came
// (nothing to mask), cut past MaxInspectedResponse. A request that carries one of the
// claim's placeholders is refused: this host has no secret of the claim.
func (in *Injector) proxyInspected(w http.ResponseWriter, r *http.Request, info connInfo) {
	// Its own slots: an install's downloads never wait behind (or hold up)
	// a request that carries a secret.
	release, err := in.acquire(r.Context(), info.pol.ClaimID+"|inspected")
	if err != nil {
		return
	}
	defer release()
	var head bytes.Buffer
	_ = r.Header.Write(&head)
	head.WriteString(r.URL.RequestURI())
	if redact.Contains(head.Bytes(), info.pol.Placeholders()) {
		in.Metrics.inspect("placeholder")
		in.alert(info, AlertCredentialExfiltration)
		http.Error(w, "refused", http.StatusForbidden)
		return
	}
	target, why := upstreamURL(r, info.host)
	if why != "" {
		in.refuseTarget(w, info, why)
		return
	}
	out, err := newUpstreamRequest(r, target, info.host, http.NoBody)
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	for k, vs := range r.Header {
		if hopByHop[http.CanonicalHeaderKey(k)] {
			continue
		}
		out.Header[k] = vs
	}
	// The machine's own Accept-Encoding goes up as is, so the transport
	// hands the body back untouched (a tarball stays the bytes its lockfile
	// hashes).
	if out.Header.Get("Accept-Encoding") == "" {
		out.Header.Set("Accept-Encoding", "identity")
	}
	resp, err := info.upstream.Do(out) //nolint:gosec // G704: same validated host as the request above
	if err != nil {
		in.Log.Warn("injector.upstream", "claim", info.pol.ClaimID, "host", info.host, "code", "upstream_unavailable")
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	in.Metrics.inspect("allowed")
	for k, vs := range resp.Header {
		if hopByHop[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	n, err := io.Copy(w, io.LimitReader(resp.Body, in.MaxInspectedResponse+1))
	if err != nil || n > in.MaxInspectedResponse {
		in.Log.Warn("injector.response_cut", "claim", info.pol.ClaimID, "host", info.host, "bytes", n, "code", "response_incomplete")
		panic(http.ErrAbortHandler)
	}
}

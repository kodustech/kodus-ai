package observer

import (
	"net/http"
	"net/http/httputil"
	"strconv"
	"strings"
)

// A preview (docs/runtime/preview-urls.md §4.2) reaches its claim's app
// through the observer, the one component on the claim network the agent is
// authenticated to. The observer proxies a preview request to one http
// target of its own configuration and nothing else, and keeps no record of
// it: a person clicking through the app never becomes a probe's evidence.
const (
	// PreviewPath prefixes every preview request the agent sends; the app
	// gets the path after it.
	PreviewPath = "/v1/preview"
	// PreviewTargetHeader names the target as service:port. It never
	// reaches the app.
	PreviewTargetHeader = "X-Kodus-Preview-Target"
	// PreviewRefusedHeader marks an answer of the cell or the observer, not
	// of the app: no_route, no_target, busy, too_large, upstream.
	PreviewRefusedHeader = "Kodus-Preview-Refused"
)

// PreviewRefuse answers a preview request the cell or the observer will not
// pass on, marked so the edge never mistakes it for the app's own answer.
func PreviewRefuse(w http.ResponseWriter, status int, code string) {
	w.Header().Set(PreviewRefusedHeader, code)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
}

// PreviewHandler proxies /v1/preview/... to the http target the request's
// X-Kodus-Preview-Target names, dialing only the targets' addresses. A
// target that is not one of them, or not http, is 404: never another port,
// the observer's own API or another address.
func PreviewHandler(targets []Target) http.Handler {
	byKey := map[string]Target{}
	for _, t := range targets {
		if t.Kind == "http" {
			byKey[targetKey(t.Service, t.Port)] = t
		}
	}
	// The browser's Accept-Encoding goes to the app as is: the transport adds none of its own.
	transport := TargetsOnlyTransport(targets)
	transport.DisableCompression = true
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			t := byKey[previewKey(r.In.Header.Get(PreviewTargetHeader))]
			r.Out.URL.Scheme, r.Out.URL.Host = "http", t.Address
			r.Out.URL.Path = strings.TrimPrefix(r.In.URL.Path, PreviewPath)
			r.Out.URL.RawPath = strings.TrimPrefix(r.In.URL.RawPath, PreviewPath)
			r.Out.Host = r.In.Host
			r.Out.Header.Del(PreviewTargetHeader)
			// Rewrite drops every X-Forwarded-* the agent sent; the two the
			// edge set from the browser's request go back, the client's
			// address never does.
			for _, h := range []string{"X-Forwarded-Proto", "X-Forwarded-Host"} {
				if v := r.In.Header.Get(h); v != "" {
					r.Out.Header.Set(h, v)
				}
			}
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			PreviewRefuse(w, http.StatusBadGateway, "upstream")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := byKey[previewKey(r.Header.Get(PreviewTargetHeader))]; !ok || !strings.HasPrefix(r.URL.Path, PreviewPath+"/") {
			PreviewRefuse(w, http.StatusNotFound, "no_target")
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

// previewKey is the target key of a service:port header, or "" when it is
// not one.
func previewKey(v string) string {
	i := strings.LastIndexByte(v, ':')
	if i <= 0 {
		return ""
	}
	port, err := strconv.Atoi(v[i+1:])
	if err != nil || port < 1 || port > 65535 || strconv.Itoa(port) != v[i+1:] {
		return ""
	}
	return targetKey(v[:i], port)
}

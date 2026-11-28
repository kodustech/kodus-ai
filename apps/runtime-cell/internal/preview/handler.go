package preview

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/metrics"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// HeaderPreviewID and HeaderSession are set by the edge only
// (PREVIEW_STREAM_HEADERS): the preview a stream is for, and the
// viewer's session id for the logs. Neither reaches the app.
var (
	HeaderPreviewID = http.CanonicalHeaderKey(protocol.PreviewStreamHeaderPreviewID)
	HeaderSession   = http.CanonicalHeaderKey(protocol.PreviewStreamHeaderSession)
)

// Per-preview limits (PREVIEW_LIMITS), from constants_gen.go.
const (
	DefaultMaxStreams     = protocol.PreviewMaxStreams
	DefaultMaxRequestBody = protocol.PreviewMaxRequestBodyBytes
	DefaultRequestTimeout = protocol.PreviewRequestTimeoutMs * time.Millisecond
)

// handler serves the tunnel's streams.
type handler struct {
	routes  *Table
	log     *slog.Logger
	maxBody int64
	timeout time.Duration
	streams *metrics.Vec
	bytes   *metrics.Vec
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	id := r.Header.Get(HeaderPreviewID)
	s, why := h.routes.admit(id)
	switch why {
	case refusedNoRoute:
		// The edge asked for a route the hub never declared (or that ended):
		// an edge or hub bug, or an attack. Never anything about the request.
		h.streams.Inc("no_route")
		attrs := []any{"alarm", true}
		if ValidID(id) {
			attrs = append(attrs, "previewId", id)
		}
		h.log.Warn("preview.route.refused", attrs...)
		observer.PreviewRefuse(w, http.StatusNotFound, string(refusedNoRoute))
		return
	case refusedBusy:
		h.streams.Inc("busy")
		observer.PreviewRefuse(w, http.StatusServiceUnavailable, string(refusedBusy))
		return
	}
	defer s.done()
	if !cleanPath(r.URL.Path) {
		// A dot segment would walk out of /v1/preview on the observer: the
		// edge's browsers never send one.
		h.streams.Inc("bad_path")
		observer.PreviewRefuse(w, http.StatusBadRequest, "bad_path")
		return
	}
	if r.ContentLength > h.maxBody {
		h.streams.Inc("too_large")
		observer.PreviewRefuse(w, http.StatusRequestEntityTooLarge, "too_large")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), h.timeout)
	defer cancel()
	// An unroute or the claim's release ends the stream at once.
	stop := context.AfterFunc(s.ctx, cancel) //nolint:contextcheck // the route's own lifetime, not the request's: its end cancels the request's context
	defer stop()

	out := r.Clone(ctx)
	out.Header.Del(HeaderPreviewID)
	out.Header.Del(HeaderSession)
	out.Header.Set(observer.PreviewTargetHeader, s.target.Service+":"+strconv.Itoa(s.target.Port))
	out.URL.Path = observer.PreviewPath + r.URL.Path
	if r.URL.RawPath != "" {
		out.URL.RawPath = observer.PreviewPath + r.URL.RawPath
	}
	out.Body = &countingReader{r: http.MaxBytesReader(w, r.Body, h.maxBody), count: func(n int) { h.bytes.Add(float64(n), "up") }}
	cw := &countingWriter{ResponseWriter: w, count: func(n int) { h.bytes.Add(float64(n), "down") }}
	s.upstream.ServeHTTP(cw, out)
	switch {
	case ctx.Err() != nil && s.ctx.Err() != nil:
		h.streams.Inc("unrouted")
	case cw.Header().Get(observer.PreviewRefusedHeader) == "upstream":
		h.streams.Inc("upstream_error")
	default:
		h.streams.Inc("served")
	}
}

// ObserverUpstream is a claim's preview upstream on an observer machine:
// its /v1/preview proxy at base (https://observer:7443) over rt, the
// agent's mTLS transport to it. An observer that does not answer is 502
// upstream.
func ObserverUpstream(base string, rt http.RoundTripper) (http.Handler, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Path != "" || u.User != nil || u.RawQuery != "" {
		return nil, errors.New("preview: invalid observer base")
	}
	return &httputil.ReverseProxy{
		Transport:     rt,
		FlushInterval: -1,
		Rewrite: func(r *httputil.ProxyRequest) {
			r.Out.URL.Scheme, r.Out.URL.Host = u.Scheme, u.Host
			r.Out.Host = r.In.Host
			for _, h := range []string{"X-Forwarded-Proto", "X-Forwarded-Host"} {
				if v := r.In.Header.Get(h); v != "" {
					r.Out.Header.Set(h, v)
				}
			}
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			observer.PreviewRefuse(w, http.StatusBadGateway, "upstream")
		},
	}, nil
}

// cleanPath is an absolute path with no dot segment and no backslash.
func cleanPath(p string) bool {
	if !strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\\x00") {
		return false
	}
	for _, seg := range strings.Split(p[1:], "/") {
		if seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

type countingReader struct {
	r     io.ReadCloser
	count func(int)
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.count(n)
	}
	return n, err
}

func (c *countingReader) Close() error { return c.r.Close() }

type countingWriter struct {
	http.ResponseWriter
	count func(int)
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.ResponseWriter.Write(p)
	if n > 0 {
		c.count(n)
	}
	return n, err
}

// Unwrap lets http.ResponseController flush through (ReverseProxy flushes).
func (c *countingWriter) Unwrap() http.ResponseWriter { return c.ResponseWriter }

package management

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

// Call connects only to a checked local Unix socket. It authenticates the peer
// in the kernel and returns canonical metadata, never arbitrary server output.
func Call(ctx context.Context, path, operation string, body []byte) ([]byte, error) {
	return call(ctx, path, operation, body, func(c *net.UnixConn) error { return samePeer(c, uint32(os.Geteuid())) })
}
func call(ctx context.Context, path, operation string, input []byte, checkPeer func(*net.UnixConn) error) ([]byte, error) {
	if len(input) > MaxBodyBytes {
		return nil, failure("too_large", 413)
	}
	body := append([]byte(nil), input...)
	defer clear(body)
	if ctx.Err() != nil {
		return nil, failure("cancelled", 408)
	}
	req, e := parseRequest(operation, body)
	if e != nil {
		return nil, e
	}
	if !validID(req.org) || !validID(req.env) {
		return nil, failure("invalid_request", 400)
	}
	parent, e := privateParent(path)
	if e != nil {
		return nil, e
	}
	socket, e := privateSocket(path, parent)
	if e != nil {
		return nil, e
	}
	tr := &http.Transport{Proxy: nil, DisableCompression: true, DisableKeepAlives: true, MaxConnsPerHost: 1, MaxResponseHeaderBytes: 4096, ResponseHeaderTimeout: 5 * time.Second, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		c, e := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", path)
		if e != nil {
			return nil, failure("unavailable", 503)
		}
		u, ok := c.(*net.UnixConn)
		if !ok {
			_ = c.Close()
			return nil, failure("denied", 403)
		}
		after, e := privateSocket(path, parent)
		if e != nil || !os.SameFile(socket, after) {
			_ = c.Close()
			return nil, failure("unsafe_socket", 503)
		}
		if e = checkPeer(u); e != nil {
			_ = c.Close()
			return nil, e
		}
		return c, nil
	}}
	defer tr.CloseIdleConnections()
	client := &http.Client{Transport: tr, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r, e := http.NewRequestWithContext(ctx, http.MethodPost, "http://unix/v1/vault/"+operation, bytes.NewReader(body))
	if e != nil {
		return nil, failure("invalid_request", 400)
	}
	r.Header.Set("Content-Type", "application/json")
	response, e := client.Do(r)
	if e != nil {
		if ctx.Err() != nil || errors.Is(e, context.DeadlineExceeded) {
			return nil, failure("cancelled", 408)
		}
		var typed *Error
		if errors.As(e, &typed) {
			return nil, safeError(typed)
		}
		return nil, failure("unavailable", 503)
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNoContent && operation != "list" {
		return nil, nil
	}
	if response.StatusCode != http.StatusOK || operation != "list" {
		return nil, statusFailure(response.StatusCode)
	}
	if response.Header.Get("Content-Type") != "application/json" || response.Header.Get("Content-Encoding") != "" || response.Header.Get("Cache-Control") != "no-store" {
		return nil, failure("unavailable", 503)
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if e != nil {
		return nil, failure("unavailable", 503)
	}
	return sanitizeList(raw, req.scope())
}
func statusFailure(status int) error {
	switch status {
	case 400:
		return failure("invalid_request", 400)
	case 403:
		return failure("denied", 403)
	case 404:
		return failure("invalid_operation", 404)
	case 405:
		return failure("method_not_allowed", 405)
	case 408:
		return failure("cancelled", 408)
	case 409:
		return failure("conflict", 409)
	case 413:
		return failure("too_large", 413)
	default:
		return failure("unavailable", 503)
	}
}

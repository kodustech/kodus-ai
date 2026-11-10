// Package observerclient binds the cell to the exact private observer config.
package observerclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/observer"
)

// Configure never accepts a generic conflict as proof of the observer's owner.
// Credentials appear only in this authenticated control request, never errors.
func Configure(ctx context.Context, hc *http.Client, base string, cc observer.ClaimConfig) (observer.Client, error) {
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || net.ParseIP(u.Hostname()) == nil {
		return nil, errors.New("observer: invalid control endpoint")
	}
	fingerprint, err := observer.ConfigFingerprint(cc)
	if err != nil {
		return nil, errors.New("observer: invalid control configuration")
	}
	body, err := json.Marshal(cc)
	if err != nil || len(body) > 64<<10 {
		return nil, errors.New("observer: invalid control configuration")
	}
	if hc == nil {
		return nil, errors.New("observer: missing authenticated control client")
	}
	// A redirect cannot carry private SQL authentication to a different origin.
	owned := *hc
	owned.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	hc = &owned
	deadline := time.Now().Add(3 * time.Minute)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, base+"/v1/config", bytes.NewReader(body))
		if err != nil {
			return nil, errors.New("observer: invalid control request")
		}
		resp, callErr := hc.Do(req)
		if callErr == nil {
			_ = resp.Body.Close()
			verified := singleHeader(resp.Header, observer.ConfigFingerprintHeader, fingerprint) && singleHeader(resp.Header, observer.ConfigGenerationHeader, strconv.FormatUint(cc.Generation, 10))
			if resp.StatusCode >= 300 && resp.StatusCode < 400 {
				return nil, errors.New("observer: control redirects are refused")
			}
			switch resp.StatusCode {
			case http.StatusNoContent:
				if cc.Generation > 0 && !verified {
					return nil, errors.New("observer: configuration binding was not verified")
				}
				return observer.HTTPClient{BaseURL: base, HTTP: hc}, nil
			case http.StatusConflict:
				if verified {
					return observer.HTTPClient{BaseURL: base, HTTP: hc}, nil
				}
				return nil, errors.New("observer: configuration belongs to another claim or generation")
			case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound:
				return nil, errors.New("observer: control configuration was refused; update or check the observer")
			}
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if time.Now().After(deadline) {
			return nil, errors.New("observer: control configuration unavailable")
		}
		timer := time.NewTimer(2 * time.Second)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		}
	}
}
func singleHeader(h http.Header, key, want string) bool {
	values := h.Values(key)
	return len(values) == 1 && values[0] == want
}

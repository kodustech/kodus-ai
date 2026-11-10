package localdocker

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// waitUntilHealthy is the recipe's health check: GET the health path on
// the public service's published http port until the app answers (see
// appAnswered).
func (d *Driver) waitUntilHealthy(ctx context.Context, machine string, rec *recipe.Recipe) error {
	if rec == nil || rec.Services.Compose.Health == "" {
		return nil
	}
	public, _ := rec.PublicHTTP() // recipe.Parse made sure there is one
	d.mu.Lock()
	var addr string
	if m := d.st.Machines[machine]; m != nil {
		addr = m.Ports[exposeKey(public.Service, public.Port)]
	}
	d.mu.Unlock()
	if addr == "" {
		return fmt.Errorf("localdocker: %s publishes no %s/%d", machine, public.Service, public.Port)
	}
	url := "http://" + addr + rec.Services.Compose.Health
	return d.retryUntil(ctx, rec.HealthTimeout(), func() error {
		code, err := d.getStatus(ctx, url)
		if err == nil && !appAnswered(code) {
			err = fmt.Errorf("GET %s: %d", url, code)
		}
		return err
	})
}

// appAnswered says whether a health status means the app is serving. Below
// 400 is up. 401 and 403 count too: an app whose every page sits behind a
// sign-in answers its health path with them, so a recipe does not need a
// public route only for the cell. 429 is the app limiting the poll.
// Anything else (404 for a wrong path, 5xx) is not up yet. A proxy that
// asks for credentials before the app behind it is up would pass too: the
// recipe of such a project points health at a path the proxy lets through.
func appAnswered(code int) bool {
	switch {
	case code < 400:
		return true
	case code == http.StatusUnauthorized, code == http.StatusForbidden, code == http.StatusTooManyRequests:
		return true
	}
	return false
}

// retryUntil calls f every pollEvery until it succeeds, the timeout passes
// (the last error says why) or ctx ends.
func (d *Driver) retryUntil(ctx context.Context, timeout time.Duration, f func() error) error {
	deadline := time.Now().Add(timeout)
	for {
		err := f()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("not ready after %s: %w", timeout, err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(d.pollEvery):
		}
	}
}

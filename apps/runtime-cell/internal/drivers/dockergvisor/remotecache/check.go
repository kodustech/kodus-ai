package remotecache

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

// ErrUnauthorized is a registry that refused the store's credential (or
// asked for one and was given none).
var ErrUnauthorized = errors.New("remotecache: the registry refused the credential")

// Check asks the registry the distribution API's version check (GET /v2/)
// with the store's credential, as every push and pull sends it: nil when
// it answers 200. It reads nothing and writes nothing (cell preflight
// -network). A 401 is ErrUnauthorized, naming the scheme the registry asks
// for (the store sends basic auth only).
func (r *Registry) Check(ctx context.Context) error {
	resp, err := r.request(ctx, http.MethodGet, "/v2/", nil, 0, nil)
	if err != nil {
		return fmt.Errorf("remotecache: %s: %w", r.Where(), err)
	}
	defer drain(resp)
	switch resp.StatusCode {
	case http.StatusOK:
		return nil
	case http.StatusUnauthorized:
		scheme, _, _ := strings.Cut(resp.Header.Get("WWW-Authenticate"), " ")
		given := "the credential given"
		if r.user == "" {
			given = "no credential"
		}
		return fmt.Errorf("%w: answered 401 to %s (it asks for %s auth)", ErrUnauthorized, given, orUnnamed(scheme))
	}
	return statusErr("GET /v2/", resp)
}

func orUnnamed(scheme string) string {
	if scheme == "" {
		return "an unnamed"
	}
	return scheme
}

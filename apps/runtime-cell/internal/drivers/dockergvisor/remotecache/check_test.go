package remotecache

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// versionCheck is a registry's GET /v2/: 200 for the cell's credential, 401
// asking for scheme otherwise. It counts every other request.
func versionCheck(t *testing.T, user, password, scheme string) (*httptest.Server, *int) {
	t.Helper()
	others := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v2/" || r.Method != http.MethodGet {
			others++
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if u, p, ok := r.BasicAuth(); ok && u == user && p == password {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.Header().Set("WWW-Authenticate", scheme+` realm="https://auth.example.com/token"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(srv.Close)
	return srv, &others
}

// A registry that takes the store's credential passes its check, with one
// GET /v2/ and nothing written.
func TestCheckPassesARegistryThatTakesTheCredential(t *testing.T) {
	srv, others := versionCheck(t, "cell", "secret", "Basic")
	st, err := New(Config{URL: srv.URL + "/kodus-bake", Auth: "cell:secret"})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	if *others != 0 {
		t.Fatalf("%d requests besides GET /v2/", *others)
	}
}

// A registry that refuses the credential is told apart from one that does
// not answer, says which scheme it asks for, and the error never carries
// the password.
func TestCheckTellsARefusedCredentialApartAndKeepsItOutOfTheError(t *testing.T) {
	srv, _ := versionCheck(t, "cell", "secret", "Bearer")
	st, err := New(Config{URL: srv.URL + "/kodus-bake", Auth: "cell:wrong-password"})
	if err != nil {
		t.Fatal(err)
	}
	err = st.Check(context.Background())
	if !errors.Is(err, ErrUnauthorized) || !strings.Contains(err.Error(), "Bearer") || strings.Contains(err.Error(), "wrong-password") {
		t.Fatalf("got %v", err)
	}
	srv.Close()
	if err := st.Check(context.Background()); err == nil || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("a registry that is down: %v", err)
	}
}

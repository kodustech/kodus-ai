package mirror

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
)

func digestOf(b []byte) string {
	s := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(s[:])
}

// fakeHub is a registry whose blobs redirect to object storage, like Docker Hub.
func fakeHub(t *testing.T, blob []byte, storageBody []byte) (*OCIProxy, *[]string) {
	t.Helper()
	var seen []string
	storage := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("the registry token followed the redirect to storage")
		}
		_, _ = w.Write(storageBody)
	}))
	t.Cleanup(storage.Close)
	reg := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case strings.Contains(r.URL.Path, "/manifests/"):
			w.Header().Set("Content-Type", "application/vnd.oci.image.index.v1+json")
			_, _ = w.Write([]byte(`{"manifests":[]}`))
		case strings.HasSuffix(r.URL.Path, "/blobs/"+digestOf(blob)):
			http.Redirect(w, r, storage.URL+"/docker-images-prod/blob?X-Amz-Signature=x", http.StatusTemporaryRedirect)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(reg.Close)
	auth := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, "token "+r.URL.Query().Get("scope"))
		_, _ = w.Write([]byte(`{"token":"tok","expires_in":300}`))
	}))
	t.Cleanup(auth.Close)
	ru, _ := url.Parse(reg.URL)
	au, _ := url.Parse(auth.URL + "/token")
	client := &http.Client{CheckRedirect: ociRedirect, Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	pins := []string{"library/golang:1.24.5-alpine"}
	return &OCIProxy{Registry: ru, Auth: au, Client: client, Pins: func(_ *http.Request, repo, ref string) bool {
		if IsDigest(ref) {
			return slices.ContainsFunc(pins, func(p string) bool { return PinRepo(p) == repo })
		}
		return slices.Contains(pins, repo+":"+ref)
	}}, &seen
}

func get(t *testing.T, h http.Handler, method, path string) (*http.Response, string, bool) {
	t.Helper()
	rec := httptest.NewRecorder()
	aborted := false
	func() {
		defer func() {
			if r := recover(); r != nil {
				if r != http.ErrAbortHandler {
					panic(r)
				}
				aborted = true
			}
		}()
		h.ServeHTTP(rec, httptest.NewRequest(method, path, nil))
	}()
	res := rec.Result()
	b, _ := io.ReadAll(res.Body)
	return res, string(b), aborted
}

func TestOCIProxyServesWhatTheDockerfilesName(t *testing.T) {
	blob := []byte("layer bytes")
	p, seen := fakeHub(t, blob, blob)

	res, _, _ := get(t, p, http.MethodGet, "/v2/")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("ping: %d", res.StatusCode)
	}
	res, body, _ := get(t, p, http.MethodGet, "/v2/library/golang/manifests/1.24.5-alpine")
	if res.StatusCode != http.StatusOK || body != `{"manifests":[]}` || res.Header.Get("Content-Type") != "application/vnd.oci.image.index.v1+json" {
		t.Fatalf("pinned manifest: %d %q", res.StatusCode, body)
	}
	// The layer redirects to object storage; the mirror follows it and checks the digest.
	res, body, aborted := get(t, p, http.MethodGet, "/v2/library/golang/blobs/"+digestOf(blob)+"?ns=docker.io")
	if res.StatusCode != http.StatusOK || body != string(blob) || aborted {
		t.Fatalf("blob: %d %q aborted=%v", res.StatusCode, body, aborted)
	}
	if !slices.Contains(*seen, "token repository:library/golang:pull") {
		t.Fatalf("no anonymous pull token asked: %v", *seen)
	}
}

func TestOCIProxyRefusesWhatTheClaimDidNotName(t *testing.T) {
	p, seen := fakeHub(t, []byte("x"), []byte("x"))
	for _, path := range []string{
		"/v2/library/golang/manifests/latest",             // a tag no Dockerfile names
		"/v2/attacker/c2vjcmv0/manifests/1",               // data in a repository name
		"/v2/library/node/blobs/" + digestOf([]byte("x")), // a repository no Dockerfile names
	} {
		if res, _, _ := get(t, p, http.MethodGet, path); res.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", path, res.StatusCode)
		}
	}
	for _, path := range []string{"/v2/library/golang/tags/list", "/v2/_catalog", "/v2/library/golang/blobs/latest", "/v2/../etc/manifests/x", "/v2/library/golang/manifests/1?x=1"} {
		if res, _, _ := get(t, p, http.MethodGet, path); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", path, res.StatusCode)
		}
	}
	if res, _, _ := get(t, p, http.MethodPut, "/v2/library/golang/manifests/1.24.5-alpine"); res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("PUT: %d", res.StatusCode)
	}
	if len(*seen) != 0 {
		t.Fatalf("a refused request reached the registry: %v", *seen)
	}
}

func TestOCIProxyCutsABlobThatIsNotItsDigest(t *testing.T) {
	blob := []byte("the real layer")
	p, _ := fakeHub(t, blob, []byte("something else entirely"))
	if _, _, aborted := get(t, p, http.MethodGet, "/v2/library/golang/blobs/"+digestOf(blob)); !aborted {
		t.Fatal("a blob that does not match its digest was served whole")
	}
}

func TestOCIRedirectStaysOnHTTPS(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://storage.example/blob", nil)
	if err := ociRedirect(req, nil); err == nil {
		t.Fatal("a plain HTTP redirect was followed")
	}
}

func TestDockerfilePins(t *testing.T) {
	df := []byte(`ARG GO_VERSION=1.24.5
ARG BASE
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build
FROM build AS test
FROM scratch
FROM ghcr.io/acme/tool:1 AS tool
FROM docker.io/library/node:22@sha256:` + strings.Repeat("a", 64) + `
FROM grafana/grafana
FROM $BASE
`)
	got := DockerfilePins(df)
	want := []string{"library/golang:1.24.5-alpine", "library/node@sha256:" + strings.Repeat("a", 64), "grafana/grafana:latest"}
	if !slices.Equal(got, want) {
		t.Fatalf("pins %v, want %v", got, want)
	}
	if pin, ok := DockerHubPin("postgres:16"); !ok || pin != "library/postgres:16" {
		t.Fatalf("postgres:16 -> %q %v", pin, ok)
	}
	if _, ok := DockerHubPin("localhost:5000/x"); ok {
		t.Fatal("another registry was pinned")
	}
}

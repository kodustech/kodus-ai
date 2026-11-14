package gitsource

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const sha = "0123456789abcdef0123456789abcdef01234567"

func repo(fullName string) protocol.RepoRef {
	return protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: fullName, APIBase: "https://api.github.com"}
}

func TestTarballURLFromValidatedParts(t *testing.T) {
	g := GitHub{APIBase: "https://api.github.com/"}
	got, err := g.TarballURL(repo("kodus/kodus-ai"), sha)
	if err != nil || got != "https://api.github.com/repos/kodus/kodus-ai/tarball/"+sha {
		t.Fatalf("%q %v", got, err)
	}
}

// M5: the schema lets ".." segments through; the URL must not walk the API.
func TestTarballURLRefusesPathsOutsideTheRepo(t *testing.T) {
	g := GitHub{APIBase: "https://api.github.com"}
	for _, name := range []string{"o/../../orgs/x", "../r", "o/..", "o/r/extra", "o", "o/r?x=1", "o/r#f", "o/%2e%2e", "./r"} {
		if u, err := g.TarballURL(repo(name), sha); err == nil {
			t.Fatalf("%q became %s", name, u)
		}
	}
	if _, err := g.TarballURL(repo("o/r"), "HEAD"); err == nil {
		t.Fatal("a ref that is not a sha")
	}
	other := repo("o/r")
	other.APIBase = "https://evil.example"
	if _, err := g.TarballURL(other, sha); err == nil {
		t.Fatal("another API base")
	}
	gl := repo("o/r")
	gl.Provider = protocol.GitProviderGitlab
	if _, err := g.TarballURL(gl, sha); err == nil {
		t.Fatal("unsupported provider")
	}
}

func TestRevokeDeletesTheInstallationToken(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Method + " " + r.URL.Path + " " + r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()
	if err := (GitHub{APIBase: srv.URL}).Revoke(context.Background(), "ghs_x"); err != nil {
		t.Fatal(err)
	}
	if got != "DELETE /installation/token Bearer ghs_x" {
		t.Fatal(got)
	}
}

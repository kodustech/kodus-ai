// Package gitsource is where the cell gets a claim's code from: the forge's
// API that serves the tarball at a SHA, and the call that revokes the
// claim's download token once the code is in. claim.acquire names the repo;
// the cell only builds a URL from parts it validated, on the one API base it
// was configured with.
package gitsource

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

var (
	// A GitHub owner or repository name: no separator, never "." or "..".
	nameSegment = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)
	commitSHA   = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// GitHub is the GitHub REST API of one base (https://api.github.com, or a
// GitHub Enterprise /api/v3).
type GitHub struct {
	APIBase string
	Client  *http.Client
	// KeepPersonalTokens is for a dev cell (-dev) whose product stack is
	// connected with a personal access token (RUNTIME_DEV_ALLOW_PAT_DOWNLOAD):
	// Revoke leaves such a token alone instead of refusing it. Never set in
	// production, where a personal token reaching the cell is refused.
	KeepPersonalTokens bool
}

// personalToken is a GitHub personal access token (classic or fine-grained):
// DELETE /installation/token cannot revoke it, and revoking it any other way
// would revoke the user's own credential.
func personalToken(token string) bool {
	return strings.HasPrefix(token, "ghp_") || strings.HasPrefix(token, "github_pat_")
}

func (g GitHub) base() (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(g.APIBase, "/"))
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("gitsource: bad API base %q", g.APIBase)
	}
	return u, nil
}

// TarballURL is GET /repos/{owner}/{repo}/tarball/{sha} for the claim's
// repo, refused unless the claim names this API base, an owner/repo pair of
// plain segments and a full commit SHA.
func (g GitHub) TarballURL(repo protocol.RepoRef, sha string) (string, error) {
	if repo.Provider != protocol.GitProviderGithub {
		return "", fmt.Errorf("gitsource: provider %s is not supported by this cell yet", repo.Provider)
	}
	base, err := g.base()
	if err != nil {
		return "", err
	}
	if strings.TrimRight(repo.APIBase, "/") != base.String() {
		return "", fmt.Errorf("gitsource: apiBase %s is not the configured Git API", repo.APIBase)
	}
	owner, name, ok := strings.Cut(repo.FullName, "/")
	if !ok || !plainSegment(owner) || !plainSegment(name) {
		return "", fmt.Errorf("gitsource: repository %q is not owner/repo", repo.FullName)
	}
	if !commitSHA.MatchString(sha) {
		return "", errors.New("gitsource: sha is not a full commit id")
	}
	return base.JoinPath("repos", owner, name, "tarball", sha).String(), nil
}

func plainSegment(s string) bool {
	return nameSegment.MatchString(s) && s != "." && s != ".."
}

// ErrPersonalToken is Revoke's answer for a personal access token on a cell
// that does not keep them: the token stays valid, so the claim fails (S-05).
var ErrPersonalToken = errors.New("gitsource: the download token is a personal access token: it cannot be revoked, and only a dev cell accepts one")

// Revoke calls DELETE /installation/token with the token itself (the token
// revokes itself; a 401 means it is already gone). A personal access token
// is never sent there: a dev cell keeps it, any other cell refuses it.
func (g GitHub) Revoke(ctx context.Context, token string) error {
	if personalToken(token) {
		if g.KeepPersonalTokens {
			return nil
		}
		return ErrPersonalToken
	}
	base, err := g.base()
	if err != nil {
		return err
	}
	c := g.Client
	if c == nil {
		c = &http.Client{Timeout: 10 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, base.JoinPath("installation", "token").String(), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusUnauthorized {
		return fmt.Errorf("gitsource: revoke: status %d", resp.StatusCode)
	}
	return nil
}

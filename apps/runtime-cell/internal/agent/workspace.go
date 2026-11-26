package agent

import (
	"fmt"
	"os"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/checkout"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/tarball"
)

// A claim of several repositories (claim.acquire repos, feature workspace)
// is laid out as claim/ws/<alias>/, the claim's own repository under its
// alias too. ws is the sandbox root: the compose project, in ws/<primary>,
// may build and bind ../<alias> and nothing outside ws. Each repository is
// fetched at its commit with its own token, extracted with no network, and
// its token revoked; a token the claim never used is revoked as well.

// laysOutWorkspaces is whether this cell boots a claim of several
// repositories (and so names the workspace feature): only through a driver
// that boots the compose project itself, whose sandbox keeps every host
// path of the project inside the workspace (sandbox.Options.Root). On any
// other cell a claim boots its own repository only, as it always did.
func (a *Agent) laysOutWorkspaces() bool { return a.cfg.Parts.Composer != nil }

// claimWorkspace is c's layout of several repositories: nil for a claim of
// one, or on a cell that does not lay workspaces out.
func (a *Agent) claimWorkspace(c *claims.Claim) (*checkout.Workspace, error) {
	if !a.laysOutWorkspaces() || len(c.Acquire.Repos) == 0 {
		return nil, nil //nolint:nilnil // documented: nil is the layout of a one-repository claim, not a failure
	}
	dir, err := claims.WorkDir(a.cfg.WorkDir, c.ID)
	if err != nil {
		return nil, err
	}
	return checkout.PlanWorkspace(dir, c.Acquire)
}

// workspaceRoot is the sandbox root of c's compose project: claim/ws for a
// claim of several repositories, "" for one (the project directory is then
// the root).
func (a *Agent) workspaceRoot(c *claims.Claim) string {
	ws, err := a.claimWorkspace(c)
	if err != nil || ws == nil {
		return ""
	}
	return ws.Root
}

// claimTokens are every download token c was given: its own repository's
// and each of claim.acquire repos'.
func claimTokens(acq protocol.ClaimAcquireBody) []string {
	out := []string{acq.RepoToken}
	for _, r := range acq.Repos {
		out = append(out, r.RepoToken)
	}
	return out
}

// fetchWorkspace brings every repository of the workspace in, the claim's
// own first (at url), each into its directory. The first that fails ends
// it, with its alias in the blocker; the tokens of the ones after it are
// revoked when the preparation ends (revokeUnfetched).
func (p *preparation) fetchWorkspace(workDir, url string) error {
	a := p.a
	if err := os.MkdirAll(p.ws.Root, 0o700); err != nil {
		return blockerErr(protocol.BlockerKindPlatform, "workdir", err)
	}
	p.c.Log.Info("claim.workspace", "primary", p.ws.Primary, "repositories", len(p.ws.Members))
	for _, m := range p.ws.Members {
		src := url
		if !m.Primary {
			var err error
			if src, err = a.cfg.Repo(memberAcquire(p.acq, m)); err != nil {
				return blockerErr(protocol.BlockerKindPlatform, "repo_source", inRepository(m.Alias, err))
			}
		}
		p.markFetched(m.Token)
		st, err := tarball.FetchExtractRevoke(p.ctx, tarball.FetchOptions{URL: src, Token: m.Token, Dest: m.Dir, WorkDir: workDir, Extractor: a.cfg.Extractor, Revoker: a.cfg.Revoker})
		if err != nil {
			if refusedArchive(err) {
				return blockerErr(protocol.BlockerKindToolchain, "repo_refused", inRepository(m.Alias, err))
			}
			return blockerErr(protocol.BlockerKindPlatform, "repo_fetch", inRepository(m.Alias, err))
		}
		p.logSkippedLinks(st, m.Alias)
	}
	return nil
}

// logSkippedLinks names the links to an absolute path the extractor left out
// of a repository (alias empty for a claim of one repository): never created,
// so a build that needed one fails on the missing path, and this says why.
func (p *preparation) logSkippedLinks(st tarball.Stats, alias string) {
	if len(st.SkippedLinks) == 0 {
		return
	}
	p.c.Log.Warn("repo.links_skipped", "reason", "absolute_target", "repository", alias, "links", st.SkippedLinks)
}

func (p *preparation) markFetched(token string) {
	if p.fetched == nil {
		p.fetched = map[string]bool{}
	}
	p.fetched[token] = true
}

// revokeUnfetched revokes the download tokens of a claim of several
// repositories that no fetch took (each fetch revokes its own): the claim
// stopped before it reached them, its layout was refused, or this cell does
// not lay workspaces out and fetches its own repository alone. A claim of one
// repository is left as it always was.
func (p *preparation) revokeUnfetched() {
	if len(p.acq.Repos) == 0 {
		return
	}
	for _, token := range claimTokens(p.acq) {
		if token == "" || p.fetched[token] {
			continue
		}
		p.markFetched(token)
		if err := tarball.Revoke(p.ctx, p.a.cfg.Revoker, token); err != nil {
			p.c.Log.Error("claim.token.revoke_failed", "alarm", true, "err", err)
		}
	}
}

// memberAcquire is the acquire RepoSource reads for one member: its
// repository at its commit, everything else the claim's.
func memberAcquire(acq protocol.ClaimAcquireBody, m checkout.Member) protocol.ClaimAcquireBody {
	acq.Repo, acq.Sha, acq.RepoToken, acq.Repos = m.Repo, m.SHA, "", nil
	return acq
}

// inRepository names the repository of the workspace an error is about, so
// the blocker says which one broke.
func inRepository(alias string, err error) error {
	return fmt.Errorf("repository %s: %w", alias, err)
}

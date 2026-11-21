package checkout

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// WorkspaceDir is the directory of a claim of several repositories that
// holds one directory per repository (ws/<alias>). A claim of one repository
// has none: its checkout is the claim's repo directory, as it always was.
const WorkspaceDir = "ws"

// MaxWorkspaceRepositories is the claim's own repository plus at most
// recipe.MaxNeeds others (MAX_WORKSPACE_REPOSITORIES).
const MaxWorkspaceRepositories = recipe.MaxNeeds + 1

// Member is one repository of a workspace: what the cell fetches into
// Dir, at SHA, with Token, a download token for that repository alone.
type Member struct {
	Alias   string
	Repo    protocol.RepoRef
	SHA     string
	Token   string
	Primary bool
	// Dir is ws/<alias> under the claim's directory.
	Dir string
}

// Workspace is the layout of a claim of several repositories: Root is
// claim/ws, the sandbox root nothing of the project leaves; every member
// lives in Root/<alias>, the claim's own repository (Primary) first, then
// claim.acquire repos in the order the hub sent them. The compose project
// and the default exec directory are the primary's.
type Workspace struct {
	Root    string
	Primary string
	Members []Member
}

// PrimaryDir is the claim's own repository: the compose project directory,
// where the recipe is read and Kody's files are written.
func (w *Workspace) PrimaryDir() string { return filepath.Join(w.Root, w.Primary) }

// Has reports whether the workspace holds repo (owner/name, any case) in
// the directory alias.
func (w *Workspace) Has(alias, repo string) bool {
	for _, m := range w.Members {
		if m.Alias == alias && strings.EqualFold(m.Repo.FullName, repo) {
			return true
		}
	}
	return false
}

// PlanWorkspace lays a claim of several repositories out in claimDir: nil
// for a claim whose acquire carries no repos (its layout stays the claim's
// repo directory). The primary's alias is its repository's short name
// (recipe.AliasOf), the alias the product gives a primary repository.
// Everything is checked again here, though the schema did: an alias is one
// path segment, each once, none the primary's, no repository twice, and at
// most MaxWorkspaceRepositories.
func PlanWorkspace(claimDir string, acq protocol.ClaimAcquireBody) (*Workspace, error) {
	if len(acq.Repos) == 0 {
		return nil, nil //nolint:nilnil // documented: nil is the layout of a claim with no repos, not a failure
	}
	if claimDir == "" {
		return nil, errors.New("workspace: no claim directory")
	}
	if len(acq.Repos)+1 > MaxWorkspaceRepositories {
		return nil, fmt.Errorf("workspace: at most %d repositories", MaxWorkspaceRepositories)
	}
	// A name that leaves no alias is laid out as "repo", the alias the product gives it too.
	primary := recipe.AliasOf(acq.Repo.FullName)
	w := &Workspace{Root: filepath.Join(claimDir, WorkspaceDir), Primary: primary}
	w.Members = append(w.Members, Member{Alias: primary, Repo: acq.Repo, SHA: acq.Sha, Token: acq.RepoToken, Primary: true, Dir: filepath.Join(w.Root, primary)})
	aliases := map[string]bool{primary: true}
	repos := map[string]bool{repoKey(acq.Repo): true}
	for _, r := range acq.Repos {
		if !recipe.AliasPattern.MatchString(r.Alias) || !filepath.IsLocal(r.Alias) {
			return nil, fmt.Errorf("workspace: alias %q is not a directory name", r.Alias)
		}
		if aliases[r.Alias] {
			if r.Alias == primary {
				return nil, fmt.Errorf("workspace: alias %s is the claim's own repository's", r.Alias)
			}
			return nil, fmt.Errorf("workspace: alias %s twice", r.Alias)
		}
		if repos[repoKey(r.Repo)] {
			return nil, fmt.Errorf("workspace: repository %s twice", r.Repo.FullName)
		}
		aliases[r.Alias], repos[repoKey(r.Repo)] = true, true
		w.Members = append(w.Members, Member{Alias: r.Alias, Repo: r.Repo, SHA: r.Sha, Token: r.RepoToken, Dir: filepath.Join(w.Root, r.Alias)})
	}
	return w, nil
}

func repoKey(r protocol.RepoRef) string {
	return string(r.Provider) + "\x00" + strings.TrimRight(r.APIBase, "/") + "\x00" + strings.ToLower(r.FullName)
}

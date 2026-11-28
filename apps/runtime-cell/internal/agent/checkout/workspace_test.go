package checkout

import (
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/recipe"
)

// testClaimDir is the claim directory the plans are laid out in.
const testClaimDir = "/cell/claims/c1"

func repoRef(name string) protocol.RepoRef {
	return protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: name, APIBase: "https://api.github.com"}
}

func acquireWith(repos ...protocol.ClaimAcquireBodyReposItem) protocol.ClaimAcquireBody {
	return protocol.ClaimAcquireBody{Repo: repoRef("acme/Shop_API"), Sha: strings.Repeat("0", 40), RepoToken: "own", Repos: repos}
}

func member(alias, name string) protocol.ClaimAcquireBodyReposItem {
	return protocol.ClaimAcquireBodyReposItem{Alias: alias, Repo: repoRef(name), Sha: strings.Repeat("1", 40), RepoToken: "tok-" + alias}
}

// No repos, no workspace: the claim keeps its repo directory.
func TestOneRepositoryHasNoWorkspace(t *testing.T) {
	ws, err := PlanWorkspace("/cell/claims/c1", acquireWith())
	if ws != nil || err != nil {
		t.Fatalf("%+v %v", ws, err)
	}
}

// Every repository lives in ws/<alias>, the claim's own first under the
// alias its name gives, the others in the order the hub sent them.
func TestAWorkspaceLaysEveryRepositoryOutUnderItsAlias(t *testing.T) {
	ws, err := PlanWorkspace("/cell/claims/c1", acquireWith(member("billing", "acme/billing"), member("web.app", "acme/web-app")))
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(testClaimDir, "ws")
	if ws.Root != root || ws.Primary != "shop_api" || ws.PrimaryDir() != filepath.Join(root, "shop_api") {
		t.Fatalf("%+v", ws)
	}
	var got []string
	for _, m := range ws.Members {
		got = append(got, m.Alias)
	}
	if !slices.Equal(got, []string{"shop_api", "billing", "web.app"}) {
		t.Fatalf("aliases %v", got)
	}
	if m := ws.Members[0]; !m.Primary || m.Token != "own" || m.Dir != ws.PrimaryDir() {
		t.Fatalf("primary %+v", m)
	}
	if m := ws.Members[2]; m.Primary || m.Token != "tok-web.app" || m.Dir != filepath.Join(root, "web.app") || m.SHA != strings.Repeat("1", 40) {
		t.Fatalf("member %+v", m)
	}
	if !ws.Has("billing", "ACME/Billing") || ws.Has("billing", "acme/web-app") || ws.Has("ledger", "acme/ledger") {
		t.Fatal("Has")
	}
}

// A primary whose name leaves no alias is laid out as repo, as the product names it.
func TestAPrimaryWithoutAnAliasIsLaidOutAsRepo(t *testing.T) {
	acq := acquireWith(member("billing", "acme/billing"))
	acq.Repo = repoRef("acme/---")
	ws, err := PlanWorkspace("/cell/claims/c1", acq)
	if err != nil || ws.Primary != recipe.FallbackAlias || ws.PrimaryDir() != filepath.Join(testClaimDir, WorkspaceDir, "repo") {
		t.Fatalf("workspace %+v %v", ws, err)
	}
}

// What cannot be one directory per repository is refused.
func TestAWorkspaceRefusesWhatIsNotOneDirectoryEach(t *testing.T) {
	too := make([]protocol.ClaimAcquireBodyReposItem, MaxWorkspaceRepositories)
	for i := range too {
		too[i] = member("m"+string(rune('a'+i)), "acme/m"+string(rune('a'+i)))
	}
	for name, tc := range map[string]struct {
		acq  protocol.ClaimAcquireBody
		want string
	}{
		"dotdot":        {acquireWith(member("..", "acme/billing")), "not a directory name"},
		"slash":         {acquireWith(member("a/b", "acme/billing")), "not a directory name"},
		"upper":         {acquireWith(member("Billing", "acme/billing")), "not a directory name"},
		"twice":         {acquireWith(member("billing", "acme/billing"), member("billing", "acme/other")), "alias billing twice"},
		"primary alias": {acquireWith(member("shop_api", "acme/other")), "the claim's own repository's"},
		"primary repo":  {acquireWith(member("again", "ACME/shop_api")), "repository ACME/shop_api twice"},
		"repo twice":    {acquireWith(member("a", "acme/billing"), member("b", "acme/Billing")), "twice"},
		"too many":      {acquireWith(too...), "at most"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := PlanWorkspace("/cell/claims/c1", tc.acq); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err %v, want %q", err, tc.want)
			}
		})
	}
}

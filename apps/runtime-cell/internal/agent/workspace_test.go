package agent

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

const (
	billingSHA   = "1123456789abcdef0123456789abcdef01234567"
	ledgerSHA    = "2123456789abcdef0123456789abcdef01234567"
	billingToken = "member-token-billing-0123456789"
	ledgerToken  = "member-token-ledger-0123456789"
)

func otherRepos() []protocol.ClaimAcquireBodyReposItem {
	return []protocol.ClaimAcquireBodyReposItem{{
		Alias:     "billing",
		Repo:      protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/billing", APIBase: "https://api.github.com"},
		Sha:       billingSHA,
		RepoToken: billingToken,
	}}
}

func twoOtherRepos() []protocol.ClaimAcquireBodyReposItem {
	return append(otherRepos(), protocol.ClaimAcquireBodyReposItem{
		Alias:     "ledger",
		Repo:      protocol.RepoRef{Provider: protocol.GitProviderGithub, FullName: "o/ledger", APIBase: "https://api.github.com"},
		Sha:       ledgerSHA,
		RepoToken: ledgerToken,
	})
}

// tarballs serves one tarball per repository (/o/<name>), each holding the
// files given under the top directory GitHub puts them in; a repository in
// fail answers 404.
func tarballs(t *testing.T, repos map[string]map[string]string, fail ...string) string {
	t.Helper()
	bodies := map[string][]byte{}
	for name, files := range repos {
		var buf bytes.Buffer
		gz := gzip.NewWriter(&buf)
		tw := tar.NewWriter(gz)
		for path, content := range files {
			_ = tw.WriteHeader(&tar.Header{Name: "o-" + name + "-0123/" + path, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(content))})
			_, _ = tw.Write([]byte(content))
		}
		_ = tw.Close()
		_ = gz.Close()
		bodies["/o/"+name] = buf.Bytes()
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, ok := bodies[r.URL.Path]
		if !ok || slices.Contains(fail, strings.TrimPrefix(r.URL.Path, "/o/")) {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// recRevoker records every token revoked.
type recRevoker struct {
	mu      sync.Mutex
	revoked []string
}

func (r *recRevoker) Revoke(_ context.Context, token string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.revoked = append(r.revoked, token)
	return nil
}

func (r *recRevoker) tokens() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return sorted(r.revoked)
}

func sorted(s []string) []string { s = slices.Clone(s); slices.Sort(s); return s }

// wsComposer is a ComposeBooter that records the directory and the
// workspace root each Up was given.
type wsComposer struct {
	mu    sync.Mutex
	dirs  []string
	roots []string
}

func (w *wsComposer) Up(_ context.Context, req driver.UpRequest) ([]string, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.dirs = append(w.dirs, req.ProjectDir)
	w.roots = append(w.roots, req.WorkspaceRoot)
	return []string{"172.30.0.2"}, nil
}

func (w *wsComposer) ups() (dirs, roots []string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.dirs), slices.Clone(w.roots)
}

// wsHarness is a cell that lays workspaces out (a ComposeBooter), serving
// each repository's tarball, revoking into rev, and recording the
// repositories it fetched. A repository named nosource has no source, and
// its error names a token.
type wsHarness struct {
	*harness
	up      *wsComposer
	rev     *recRevoker
	mu      sync.Mutex
	fetched []string
}

func newWSHarness(t *testing.T, fail ...string) *wsHarness {
	t.Helper()
	srv := tarballs(t, shopRepos, fail...)
	w := &wsHarness{up: &wsComposer{}, rev: &recRevoker{}}
	w.harness = newHarness(t, func(c *Config) {
		c.Parts.Composer, c.Revoker = w.up, w.rev
		c.Repo = func(b protocol.ClaimAcquireBody) (string, error) {
			w.mu.Lock()
			w.fetched = append(w.fetched, b.Repo.FullName+"@"+b.Sha[:7])
			w.mu.Unlock()
			if strings.Contains(b.Repo.FullName, "nosource") {
				return "", errors.New("no source for " + b.Repo.FullName + " with " + billingToken)
			}
			return srv + "/" + b.Repo.FullName, nil
		}
	})
	return w
}

func (w *wsHarness) fetchedRepos() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.fetched)
}

func (w *wsHarness) claimDir(id string) string {
	return filepath.Join(w.a.cfg.WorkDir, "claims", id)
}

var shopRepos = map[string]map[string]string{
	"r":       {"README.md": "shop", "go.sum": "example.com/shop v1.0.0 h1:abc=\nexample.com/shop v1.0.0/go.mod h1:def=\n", "Dockerfile": "FROM node:22\n"},
	"billing": {"README.md": "billing", "go.sum": "example.com/billing v2.0.0 h1:abc=\nexample.com/billing v2.0.0/go.mod h1:def=\n", "Dockerfile": "FROM golang:1.23\n"},
	"ledger":  {"README.md": "ledger"},
}

var allTokens = sorted([]string{"ghs_download", billingToken, ledgerToken})

// The cell names the workspace feature only where it lays workspaces out:
// a driver that boots the compose project itself.
func TestHelloAnnouncesTheWorkspaceOnlyWhereItIsLaidOut(t *testing.T) {
	if !slices.Contains(protocol.Features(), protocol.FeatureWorkspace) {
		t.Fatal("the protocol does not know the workspace feature")
	}
	if h := newHarness(t); slices.Contains(h.a.Hello().Features, protocol.FeatureWorkspace) {
		t.Fatalf("a cell without a ComposeBooter announces workspace: %v", h.a.Hello().Features)
	}
	if w := newWSHarness(t); !slices.Contains(w.a.Hello().Features, protocol.FeatureWorkspace) {
		t.Fatalf("a ComposeBooter cell does not announce workspace: %v", w.a.Hello().Features)
	}
}

// A cell that does not announce the workspace boots a claim that carries
// repos as the claim of one repository: it fetches only its own.
func TestAClaimWithReposBootsItsOwnRepositoryOnly(t *testing.T) {
	var mu sync.Mutex
	var fetched []string
	h := newHarness(t, func(c *Config) {
		repo := c.Repo
		c.Repo = func(b protocol.ClaimAcquireBody) (string, error) {
			mu.Lock()
			fetched = append(fetched, b.Repo.FullName)
			mu.Unlock()
			return repo(b)
		}
	})
	b := h.acquireBody()
	b.Repos = otherRepos()
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(fetched, []string{"o/r"}) {
		t.Fatalf("fetched %v", fetched)
	}
}

// A cell that does not lay workspaces out never fetches the other
// repositories it was sent, and still revokes their tokens: a download token
// the cell will not use does not outlive the claim's preparation.
func TestAClaimWithReposOnACellWithoutWorkspacesRevokesTheirTokens(t *testing.T) {
	rev := &recRevoker{}
	h := newHarness(t, func(c *Config) { c.Revoker = rev })
	b := h.acquireBody()
	b.Repos = otherRepos()
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if got := rev.tokens(); !slices.Contains(got, billingToken) || !slices.Contains(got, b.RepoToken) || len(got) != 2 {
		t.Fatalf("revoked %v, want the claim's own token and %s once each", got, billingToken)
	}
}

// Every repository is fetched at its own commit into ws/<alias>, the
// claim's own under its alias; the project boots from ws/<primary> with ws
// as its sandbox root, after a reset too; every token is revoked once; the
// mirror pins what every repository pins.
func TestAWorkspaceFetchesEveryRepositoryIntoItsDirectory(t *testing.T) {
	w := newWSHarness(t)
	b := w.acquireBody()
	b.Repos = twoOtherRepos()
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	w.conn.next(t, isReady)
	if got, want := w.fetchedRepos(), []string{"o/r@0123456", "o/billing@1123456", "o/ledger@2123456"}; !slices.Equal(got, want) {
		t.Fatalf("fetched %v, want %v", got, want)
	}
	ws := filepath.Join(w.claimDir("claim-1"), "ws")
	for alias, want := range map[string]string{"r": "shop", "billing": "billing", "ledger": "ledger"} {
		got, err := os.ReadFile(filepath.Join(ws, alias, "README.md"))
		if err != nil || string(got) != want {
			t.Fatalf("ws/%s/README.md = %q, %v", alias, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(w.claimDir("claim-1"), "repo")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a workspace claim also has claim/repo: %v", err)
	}
	dirs, roots := w.up.ups()
	if !slices.Equal(dirs, []string{filepath.Join(ws, "r")}) || !slices.Equal(roots, []string{ws}) {
		t.Fatalf("up in %v with roots %v, want ws/r inside ws", dirs, roots)
	}
	if got := w.rev.tokens(); !slices.Equal(got, allTokens) {
		t.Fatalf("revoked %v, want each token once", got)
	}
	c, _ := w.a.claims.Get("claim-1")
	m := c.Machines()
	for _, pin := range []string{"example.com/shop@v1.0.0", "example.com/billing@v2.0.0"} {
		if !slices.Contains(m.GoPins, pin) {
			t.Fatalf("go pins %v lack %s", m.GoPins, pin)
		}
	}
	for _, image := range []string{"node", "golang"} {
		if !slices.ContainsFunc(m.ImagePins, func(p string) bool { return strings.Contains(p, image) }) {
			t.Fatalf("image pins %v lack %s", m.ImagePins, image)
		}
	}
	reset := &protocol.MachineResetBody{StepID: step1, Snapshot: protocol.Snapshot{Kind: protocol.SnapshotKindComposeVolumes, Ref: "v"}}
	if err := w.handle("claim-1", protocol.MessageTypeMachineReset, reset); err != nil {
		t.Fatal(err)
	}
	w.conn.next(t, isResult(step1))
	if dirs, roots := w.up.ups(); !slices.Equal(roots, []string{ws, ws}) || dirs[1] != dirs[0] {
		t.Fatalf("the reset's up in %v with roots %v", dirs, roots)
	}
}

// One repository on a workspace cell keeps claim/repo, an Up with no
// workspace root, and only its own token.
func TestOneRepositoryOnAWorkspaceCellKeepsItsLayout(t *testing.T) {
	w := newWSHarness(t)
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, w.acquireBody()); err != nil {
		t.Fatal(err)
	}
	w.conn.next(t, isReady)
	dirs, roots := w.up.ups()
	if !slices.Equal(dirs, []string{filepath.Join(w.claimDir("claim-1"), "repo")}) || !slices.Equal(roots, []string{""}) {
		t.Fatalf("up in %v with roots %q", dirs, roots)
	}
	if _, err := os.Stat(filepath.Join(w.claimDir("claim-1"), "ws")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a claim of one repository has ws: %v", err)
	}
	if got := w.rev.tokens(); !slices.Equal(got, []string{"ghs_download"}) {
		t.Fatalf("revoked %v", got)
	}
	if got := w.fetchedRepos(); !slices.Equal(got, []string{"o/r@0123456"}) {
		t.Fatalf("fetched %v", got)
	}
}

// A repository that fails to fetch names itself in the blocker, and the
// tokens of the repositories after it, never fetched, are revoked too.
func TestAFailedRepositoryNamesItselfAndEveryTokenIsRevoked(t *testing.T) {
	w := newWSHarness(t, "billing")
	b := w.acquireBody()
	b.Repos = twoOtherRepos()
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	f := w.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Kind != protocol.BlockerKindPlatform || f.Signature != "repo_fetch" || !strings.Contains(f.Reason, "repository billing:") {
		t.Fatalf("claim.failed %+v", f)
	}
	if got := w.fetchedRepos(); !slices.Equal(got, []string{"o/r@0123456", "o/billing@1123456"}) {
		t.Fatalf("fetched %v: the one after the failure was fetched", got)
	}
	w.a.Wait()
	if got := w.rev.tokens(); !slices.Equal(got, allTokens) {
		t.Fatalf("revoked %v, want %v", got, allTokens)
	}
}

// A repository with no source names itself, the token its error carried is
// redacted out of claim.failed, and every token is revoked; so is every
// token of a claim that stops before any fetch.
func TestAWorkspaceThatStopsEarlyRevokesEveryTokenAndRedactsThem(t *testing.T) {
	w := newWSHarness(t)
	b := w.acquireBody()
	b.Repos = twoOtherRepos()
	b.Repos[0].Repo.FullName = "o/nosource"
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	f := w.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Signature != "repo_source" || !strings.Contains(f.Reason, "repository billing:") || strings.Contains(f.Reason, billingToken) {
		t.Fatalf("claim.failed %+v", f)
	}
	w.a.Wait()
	if got := w.rev.tokens(); !slices.Equal(got, allTokens) {
		t.Fatalf("revoked %v, want %v", got, allTokens)
	}

	early := newWSHarness(t)
	early.drv.FailCreate = errors.New("no capacity")
	b = early.acquireBody()
	b.Repos = twoOtherRepos()
	if err := early.handle("claim-2", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	if f := early.conn.next(t, isFailed).(*protocol.ClaimFailedBody); f.Signature != "create_workload" {
		t.Fatalf("claim.failed %+v", f)
	}
	early.a.Wait()
	if got := early.rev.tokens(); !slices.Equal(got, allTokens) {
		t.Fatalf("revoked %v before any fetch, want %v", got, allTokens)
	}
	if got := early.fetchedRepos(); len(got) != 0 {
		t.Fatalf("fetched %v", got)
	}
}

// The claim's redactor knows every repository's token, not only its own.
func TestTheRedactorKnowsEveryRepositorysToken(t *testing.T) {
	w := newWSHarness(t)
	b := w.acquireBody()
	b.Repos = twoOtherRepos()
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	w.conn.next(t, isReady)
	c, _ := w.a.claims.Get("claim-1")
	out, n := w.a.claimRedactor(c).String("own ghs_download, billing " + billingToken + ", ledger " + ledgerToken)
	for _, token := range allTokens {
		if strings.Contains(out, token) {
			t.Fatalf("%q kept %s (%d redactions)", out, token, n)
		}
	}
	if n < 3 {
		t.Fatalf("%d redactions in %q", n, out)
	}
}

// services.needs boots when the hub sent every repository it names, by
// alias and repository.
func TestARecipeThatNeedsOtherReposBootsWithThem(t *testing.T) {
	w := newWSHarness(t)
	b := w.acquireBody()
	b.Repos = twoOtherRepos()
	withRecipe(b, "version: 1\nservices:\n  compose: { public: api }\n  needs: [{ repo: o/billing }, { repo: O/Ledger, alias: ledger }]\n")
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	w.conn.next(t, isReady)
}

// A need the hub did not send keeps the other_repo blocker, naming the
// alias that is missing; a need that is the claim's own repository is the
// recipe's to fix; on a cell that does not lay workspaces out,
// services.needs stays refused whatever the claim carries.
func TestARecipeThatNeedsAMissingRepoNamesIt(t *testing.T) {
	for name, tc := range map[string]struct {
		needs  string
		repos  []protocol.ClaimAcquireBodyReposItem
		sig    string
		reason string
	}{
		"no repos":           {"[{ repo: o/billing }]", nil, "recipe_needs", "repository billing:"},
		"another alias":      {"[{ repo: o/ledger }]", otherRepos(), "recipe_needs", "repository ledger:"},
		"same alias, other":  {"[{ repo: o/payments, alias: billing }]", otherRepos(), "recipe_needs", "repository billing:"},
		"one of two missing": {"[{ repo: o/billing }, { repo: o/ledger }]", otherRepos(), "recipe_needs", "repository ledger:"},
		"the claim's own":    {"[{ repo: O/R, alias: shop }]", otherRepos(), "recipe_needs_conflict", "own repository"},
		"the claim's alias":  {"[{ repo: o/other, alias: r }]", otherRepos(), "recipe_needs_conflict", "own repository"},
	} {
		t.Run(name, func(t *testing.T) {
			w := newWSHarness(t)
			b := w.acquireBody()
			b.Repos = tc.repos
			withRecipe(b, "version: 1\nservices:\n  compose: { public: api }\n  needs: "+tc.needs+"\n")
			if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
				t.Fatal(err)
			}
			f := w.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
			if f.Signature != tc.sig || !strings.Contains(f.Reason, tc.reason) {
				t.Fatalf("claim.failed %+v", f)
			}
			if tc.sig == "recipe_needs" && f.Kind != protocol.BlockerKindOtherRepo {
				t.Fatalf("kind %s", f.Kind)
			}
		})
	}
	t.Run("cell without workspaces", func(t *testing.T) {
		h := newHarness(t, func(c *Config) { c.FakeSupport = true })
		b := h.acquireBody()
		b.Repos = otherRepos()
		withRecipe(b, "version: 1\nservices:\n  compose: { public: api }\n  needs: [{ repo: o/billing }]\nfakes: {stripe: {image: 'stripe/stripe-mock@sha256:"+strings.Repeat("a", 64)+"'}}\n")
		if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
			t.Fatal(err)
		}
		f := h.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
		if f.Kind != protocol.BlockerKindOtherRepo || f.Signature != "recipe_needs" || !strings.Contains(f.Reason, "not supported by this cell") {
			t.Fatalf("claim.failed %+v", f)
		}
	})
}

// A layout the cell cannot make (an alias that is the claim's own) is the
// platform's blocker, and its tokens are revoked.
func TestAWorkspaceLayoutTheCellRefusesRevokesItsTokens(t *testing.T) {
	w := newWSHarness(t)
	b := w.acquireBody()
	b.Repos = otherRepos()
	b.Repos[0].Alias = "r"
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	f := w.conn.next(t, isFailed).(*protocol.ClaimFailedBody)
	if f.Kind != protocol.BlockerKindPlatform || f.Signature != "workspace_layout" {
		t.Fatalf("claim.failed %+v", f)
	}
	w.a.Wait()
	if got, want := w.rev.tokens(), sorted([]string{"ghs_download", billingToken}); !slices.Equal(got, want) {
		t.Fatalf("revoked %v, want %v", got, want)
	}
}

// The same claim asked again with other repositories is another claim; a
// new token is the same one.
func TestARejoinWithOtherReposIsRefused(t *testing.T) {
	w := newWSHarness(t)
	b := w.acquireBody()
	b.Repos = otherRepos()
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	w.conn.next(t, isReady)
	again := *b
	again.Repos = otherRepos()
	again.Repos[0].RepoToken = "member-token-new-0123456789"
	if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, &again); err != nil {
		t.Fatalf("rejoin: %v", err)
	}
	again.Repos[0].Sha = ledgerSHA
	if code := nackCode(w.handle("claim-1", protocol.MessageTypeClaimAcquire, &again)); code != "claim_exists" {
		t.Fatalf("rejoin at another commit: %q", code)
	}
	again.Repos = nil
	if code := nackCode(w.handle("claim-1", protocol.MessageTypeClaimAcquire, &again)); code != "claim_exists" {
		t.Fatalf("rejoin without repos: %q", code)
	}
}

// A setup of several repositories bakes under the refsDigest of all their
// commits; a bake whose refsDigest and the claim disagree is refused; one
// repository bakes as it did.
func TestAWorkspaceBakeCarriesItsRefsDigest(t *testing.T) {
	digest := "sha256:" + strings.Repeat("ab", 32)
	setup := func(t *testing.T, repos []protocol.ClaimAcquireBodyReposItem) *wsHarness {
		t.Helper()
		w := newWSHarness(t)
		b := w.acquireBody()
		b.Consumer, b.HardExpiresAt, b.Repos = protocol.ConsumerSetup, protocol.FormatTime(w.clk.Now().Add(40*time.Minute)), repos
		if err := w.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
			t.Fatal(err)
		}
		w.conn.next(t, isReady)
		return w
	}
	bake := func(refs *string) *protocol.ImageBakeBody {
		return &protocol.ImageBakeBody{OrgID: "org-a", EnvironmentID: "env-1", Sha: testSHA, RecipeSha: "r", RefsDigest: refs}
	}
	w := setup(t, otherRepos())
	if err := w.handle("claim-1", protocol.MessageTypeImageBake, bake(&digest)); err != nil {
		t.Fatal(err)
	}
	w.a.Wait()
	if bakes := w.drv.BakesSnapshot(); len(bakes) != 1 || bakes[0].RefsDigest != digest || bakes[0].SHA != testSHA {
		t.Fatalf("bakes %+v", bakes)
	}
	if code := nackCode(setup(t, otherRepos()).handle("claim-1", protocol.MessageTypeImageBake, bake(nil))); code != "refs_mismatch" {
		t.Fatalf("a workspace bake without refsDigest: %q", code)
	}
	if code := nackCode(setup(t, nil).handle("claim-1", protocol.MessageTypeImageBake, bake(&digest))); code != "refs_mismatch" {
		t.Fatalf("a one-repository bake with refsDigest: %q", code)
	}
	one := setup(t, nil)
	if err := one.handle("claim-1", protocol.MessageTypeImageBake, bake(nil)); err != nil {
		t.Fatal(err)
	}
	one.a.Wait()
	if bakes := one.drv.BakesSnapshot(); len(bakes) != 1 || bakes[0].RefsDigest != "" {
		t.Fatalf("one repository's bakes %+v", bakes)
	}
}

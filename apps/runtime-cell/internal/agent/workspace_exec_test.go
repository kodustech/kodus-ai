package agent

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// exec.repository: a command on another repository's code of a claim of
// several repositories reaches the driver with that repository's alias; a
// name that is not one of the claim's repositories is refused before
// anything runs; the claim's own alias, or none, runs as it always did.

type execRecorder struct {
	mu   sync.Mutex
	reqs []kodyexec.Request
}

func (r *execRecorder) exec(_ context.Context, req kodyexec.Request) (kodyexec.Result, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reqs = append(r.reqs, req)
	return kodyexec.Result{Stdout: "ok"}, nil
}

func (r *execRecorder) repositories() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	for _, q := range r.reqs {
		out = append(out, q.Repository)
	}
	return out
}

func newWSExecHarness(t *testing.T, repos []protocol.ClaimAcquireBodyReposItem) (*harness, *execRecorder) {
	t.Helper()
	srv := tarballs(t, shopRepos)
	rec := &execRecorder{}
	h := newHarness(t, func(c *Config) {
		c.Parts.Composer, c.Revoker = &wsComposer{}, &recRevoker{}
		c.Transport = stubTransport{exec: rec.exec}
		c.Repo = func(b protocol.ClaimAcquireBody) (string, error) {
			if b.Repo.FullName == "" {
				return "", errors.New("no repository")
			}
			return srv + "/" + b.Repo.FullName, nil
		}
	})
	b := h.acquireBody()
	b.Repos = repos
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	return h, rec
}

func execOn(repository *string) *protocol.ExecBody {
	return &protocol.ExecBody{StepID: hubclient.NewID(), Command: "npm test", TimeoutMs: 1000, Repository: repository}
}

func TestAnExecOnAMemberRepositoryReachesTheDriverWithItsAlias(t *testing.T) {
	h, rec := newWSExecHarness(t, otherRepos())
	for _, repository := range []*string{str("billing"), nil, str("r")} {
		b := execOn(repository)
		if err := h.handle("claim-1", protocol.MessageTypeExec, b); err != nil {
			t.Fatalf("exec %v: %v", repository, err)
		}
		h.conn.next(t, isResult(b.StepID))
	}
	// The claim's own alias is the claim's own repository: no repository reaches the driver.
	if got := strings.Join(rec.repositories(), ","); got != "billing,," {
		t.Fatalf("repositories %q", got)
	}
}

func TestAnExecOnARepositoryTheClaimDoesNotHaveIsRefused(t *testing.T) {
	h, rec := newWSExecHarness(t, otherRepos())
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeExec, execOn(str("ledger")))); code != "invalid_body" {
		t.Fatalf("exec on ledger: %q", code)
	}
	one, _ := newWSExecHarness(t, nil)
	if code := nackCode(one.handle("claim-1", protocol.MessageTypeExec, execOn(str("billing")))); code != "invalid_body" {
		t.Fatalf("exec on billing of a one-repository claim: %q", code)
	}
	if len(rec.repositories()) != 0 {
		t.Fatalf("a refused exec ran: %v", rec.repositories())
	}
}

func TestAnExecOnAMemberIsRefusedWhereWorkspacesAreNotLaidOut(t *testing.T) {
	h := newHarness(t)
	b := h.acquireBody()
	b.Repos = otherRepos()
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeExec, execOn(str("billing")))); code != "invalid_body" {
		t.Fatalf("exec on billing: %q", code)
	}
}

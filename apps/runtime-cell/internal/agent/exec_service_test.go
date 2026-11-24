package agent

import (
	"context"
	"slices"
	"sync"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver/fake"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/hubclient"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/kodyexec"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// exec.service reaches the driver as the request's Service; a service with a repository is two targets and is refused.
func TestAnExecWithAServiceReachesTheDriverWithIt(t *testing.T) {
	var mu sync.Mutex
	var got []kodyexec.Request
	h := newHarness(t, func(c *Config) {
		c.Transport = stubTransport{exec: func(_ context.Context, req kodyexec.Request) (kodyexec.Result, error) {
			mu.Lock()
			defer mu.Unlock()
			got = append(got, req)
			return kodyexec.Result{Stdout: "ok"}, nil
		}}
	})
	if err := h.handle("claim-1", protocol.MessageTypeClaimAcquire, h.acquireBody()); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isReady)
	b := &protocol.ExecBody{StepID: hubclient.NewID(), Command: "npx cypress run", TimeoutMs: 1000, Service: str("e2e")}
	if err := h.handle("claim-1", protocol.MessageTypeExec, b); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isResult(b.StepID))
	plain := &protocol.ExecBody{StepID: hubclient.NewID(), Command: "ls", TimeoutMs: 1000}
	if err := h.handle("claim-1", protocol.MessageTypeExec, plain); err != nil {
		t.Fatal(err)
	}
	h.conn.next(t, isResult(plain.StepID))
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 || got[0].Service != "e2e" || got[1].Service != "" {
		t.Fatalf("driver requests %+v", got)
	}
	both := &protocol.ExecBody{StepID: hubclient.NewID(), Command: "ls", TimeoutMs: 1000, Service: str("e2e"), Repository: str("billing")}
	if code := nackCode(h.handle("claim-1", protocol.MessageTypeExec, both)); code != "invalid_body" {
		t.Fatalf("service with repository: %q", code)
	}
}

// Only a driver that runs the project's own containers names the feature.
func TestHelloNamesExecServiceOnlyWhenTheDriverRunsServiceContainers(t *testing.T) {
	if got := newHarness(t).a.Hello().Features; slices.Contains(got, protocol.FeatureExecService) {
		t.Fatalf("named by a driver that cannot target a service: %v", got)
	}
	h := newHarness(t, func(cfg *Config) { cfg.Driver.(*fake.Driver).ExecService = true })
	if got := h.a.Hello().Features; !slices.Contains(got, protocol.FeatureExecService) {
		t.Fatalf("not named by a driver that can: %v", got)
	}
}

package dockercli

import (
	"context"
	"strings"
	"testing"
)

// A build whose claim ends is removed: the docker CLI's own death would
// leave the container compiling past the claim's ceiling.
func TestRunBuildRemovesItsContainerWhenTheClaimEnds(t *testing.T) {
	var calls [][]string
	ctx, cancel := context.WithCancel(context.Background())
	c := CLI{Run: func(rctx context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		calls = append(calls, args)
		if args[0] == "run" {
			cancel()
			return nil, context.Canceled
		}
		if rctx.Err() != nil {
			t.Error("the removal ran on the canceled context")
		}
		return nil, nil
	}}
	_ = c.RunBuild(ctx, BuildRun{Image: "b", Runtime: "runsc", Network: "n", Address: "10.0.0.9", Resolv: "/r", Context: "/c", Dockerfile: "Dockerfile", Tag: "t", Out: "/o"})
	if len(calls) != 2 || calls[1][0] != "rm" {
		t.Fatalf("calls %v", calls)
	}
	name := calls[1][len(calls[1])-1]
	if !strings.HasPrefix(name, "kodus-build-") || !strings.Contains(strings.Join(calls[0], " "), "--name "+name) {
		t.Fatalf("removed %q, ran %v", name, calls[0])
	}
}

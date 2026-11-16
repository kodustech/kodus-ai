package dockercli

import (
	"context"
	"errors"
	"testing"
)

// A removal or disconnect of something the daemon no longer has is already
// done; any other daemon failure is still returned. The stderr lines are the
// daemon's own.
func TestWhatIsAlreadyGoneIsDone(t *testing.T) {
	gone := map[string]string{
		"image rm":           "Error response from daemon: No such image: ghcr.io/o/r:old",
		"network disconnect": "Error response from daemon: container 3f2a is not connected to network kody-claim",
	}
	ops := map[string]func(CLI) error{
		"image rm":           func(c CLI) error { return c.RemoveImage(context.Background(), "ghcr.io/o/r:old") },
		"network disconnect": func(c CLI) error { return c.NetworkDisconnect(context.Background(), "kody-claim", "3f2a") },
	}
	for name, op := range ops {
		t.Run(name, func(t *testing.T) {
			fails := func(stderr string) CLI {
				return CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
					return nil, &ExitError{Command: "docker " + name, Code: 1, Stderr: stderr}
				}}
			}
			if err := op(fails(gone[name])); err != nil {
				t.Fatalf("already gone: %v", err)
			}
			if err := op(fails("Cannot connect to the Docker daemon")); err == nil {
				t.Fatal("an unreachable daemon was taken as done")
			}
		})
	}
}

// A tag of a source the daemon does not have is ErrNoSuchImage.
func TestTagOfAMissingSourceIsErrNoSuchImage(t *testing.T) {
	c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
		return nil, &ExitError{Command: "docker image tag", Code: 1, Stderr: "Error response from daemon: No such image: a:1"}
	}}
	if err := c.TagImage(context.Background(), "a:1", "b:1"); !errors.Is(err, ErrNoSuchImage) {
		t.Fatalf("got %v", err)
	}
}

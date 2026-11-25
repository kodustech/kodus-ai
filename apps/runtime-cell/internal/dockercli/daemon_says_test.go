package dockercli

import (
	"context"
	"errors"
	"testing"
	"time"
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

// A sweep and a release both ended the same machine: the second docker rm
// got "removal of container ... is already in progress", the release took
// it as a failed cleanup and the cell held the claim's memory for good
// (dev cell, 2026-11-19). That removal, and one of a container already
// gone, is a removal; Remove waits until the daemon no longer has it.
func TestRemoveOfAContainerAlreadyGoingOrGoneIsARemoval(t *testing.T) {
	removalPoll = time.Millisecond
	defer func() { removalPoll = 250 * time.Millisecond }()
	inProgress := "Error response from daemon: removal of container kodus-claim-1-observer is already in progress"
	for name, tc := range map[string]struct {
		rm      string
		inspect []string // stderr of each inspect, "" for a container still there
		wantErr bool
	}{
		"gone":          {rm: "Error response from daemon: No such container: kodus-claim-1-observer"},
		"in progress":   {rm: inProgress, inspect: []string{"", "", "Error: No such container: kodus-claim-1-observer"}},
		"daemon down":   {rm: "Cannot connect to the Docker daemon", wantErr: true},
		"another error": {rm: "Error response from daemon: could not kill: permission denied", wantErr: true},
	} {
		t.Run(name, func(t *testing.T) {
			inspects := 0
			c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
				if args[0] == "rm" {
					return nil, &ExitError{Command: "docker rm", Code: 1, Stderr: tc.rm}
				}
				if inspects >= len(tc.inspect) {
					t.Fatalf("inspected %d times", inspects+1)
				}
				stderr := tc.inspect[inspects]
				inspects++
				if stderr == "" {
					return []byte("abc\n"), nil
				}
				return nil, &ExitError{Command: "docker inspect", Code: 1, Stderr: stderr}
			}}
			err := c.Remove(context.Background(), "kodus-claim-1-observer")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, want error %v", err, tc.wantErr)
			}
			if inspects != len(tc.inspect) {
				t.Fatalf("inspected %d times, want %d", inspects, len(tc.inspect))
			}
		})
	}
}

// A removal that never ends is still an error, once the wait is over.
func TestRemoveGivesUpOnARemovalThatNeverEnds(t *testing.T) {
	removalWait, removalPoll = 20*time.Millisecond, time.Millisecond
	defer func() { removalWait, removalPoll = 2*time.Minute, 250*time.Millisecond }()
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		if args[0] == "rm" {
			return nil, &ExitError{Command: "docker rm", Code: 1, Stderr: "Error response from daemon: removal of container x is already in progress"}
		}
		return []byte("abc\n"), nil
	}}
	if err := c.Remove(context.Background(), "x"); err == nil {
		t.Fatal("a removal still in progress was taken as done")
	}
}

// An image the daemon does not hold yet is absent, not a failure: the cell
// waits for it at start. A daemon that cannot answer is still a failure.
func TestImagePresentTellsAMissingImageFromAFailedDaemon(t *testing.T) {
	answer := func(stderr string) CLI {
		return CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
			if stderr == "" {
				return []byte("sha256:" + "a"), nil
			}
			return nil, &ExitError{Command: "docker image inspect", Code: 1, Stderr: stderr}
		}}
	}
	if ok, err := answer("").ImagePresent(context.Background(), "b@sha256:1"); !ok || err != nil {
		t.Fatalf("a held image: %v %v", ok, err)
	}
	if ok, err := answer("Error response from daemon: No such image: b@sha256:1").ImagePresent(context.Background(), "b@sha256:1"); ok || err != nil {
		t.Fatalf("a missing image: %v %v", ok, err)
	}
	if _, err := answer("Cannot connect to the Docker daemon").ImagePresent(context.Background(), "b@sha256:1"); err == nil {
		t.Fatal("an unreachable daemon was taken as a missing image")
	}
}

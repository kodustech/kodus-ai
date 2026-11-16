package dockercli

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// Before aggregate enforcement, no launch carried its trusted parent and
// the copy helper could mutate a volume before an invalid parent was refused.
func TestContainerLaunchesUseTrustedCgroupParent(t *testing.T) {
	parent := "/kodus-cell/claim-ab12"
	for _, kind := range []string{"holder", "holder-extra-network", "builder", "copy"} {
		t.Run(kind, func(t *testing.T) {
			var calls [][]string
			c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
				calls = append(calls, append([]string(nil), args...))
				if args[0] == "inspect" {
					return []byte(`[{"Id":"c1","Name":"/holder"}]`), nil
				}
				return []byte("c1"), nil
			}}
			var err error
			switch kind {
			case "holder":
				_, err = c.RunHolder(context.Background(), HolderSpec{Name: "holder", Image: "i", Runtime: "runsc", Network: "n", CgroupParent: parent})
			case "holder-extra-network":
				_, err = c.RunHolder(context.Background(), HolderSpec{Name: "holder", Image: "i", Runtime: "runsc", Network: "n", AlsoOn: []string{"observer-net"}, CgroupParent: parent})
			case "builder":
				err = c.RunBuild(context.Background(), BuildRun{Image: "i", Runtime: "runsc", Out: t.TempDir(), CgroupParent: parent})
			case "copy":
				err = c.CopyVolumeBound(context.Background(), "runsc", "i", "from", "to", nil, parent)
			}
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, args := range calls {
				if args[0] != "run" && args[0] != "create" {
					continue
				}
				joined := strings.Join(args, " ")
				if !strings.Contains(joined, "--cgroup-parent "+parent+" ") {
					t.Fatalf("%s outside parent: %q", kind, args)
				}
				found = true
			}
			if !found {
				t.Fatal("no container launch")
			}
		})
	}
}

func TestInvalidCgroupParentRefusesBeforeAnyDockerCall(t *testing.T) {
	for _, parent := range []string{"/", "relative", "/cell/../other", "/cell//claim", "/system.slice", "/cell/a.scope", "/cell/claim\n"} {
		t.Run(parent, func(t *testing.T) {
			called := false
			c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
				called = true
				return nil, errors.New("must not call")
			}}
			if _, err := c.RunHolder(context.Background(), HolderSpec{CgroupParent: parent}); err == nil {
				t.Fatal("holder accepted")
			}
			if err := c.RunBuild(context.Background(), BuildRun{CgroupParent: parent}); err == nil {
				t.Fatal("builder accepted")
			}
			if err := c.CopyVolumeBound(context.Background(), "runsc", "i", "from", "to", map[string]string{"owner": "cell"}, parent); err == nil {
				t.Fatal("copy accepted")
			}
			if called {
				t.Fatal("invalid parent reached Docker or touched a volume")
			}
		})
	}
}

func TestValidateCgroupParent(t *testing.T) {
	for _, parent := range []string{"", "/kodus-cell/claim-ab12", "/delegated/kodus_a/abc123"} {
		if err := ValidateCgroupParent(parent); err != nil {
			t.Fatalf("%q: %v", parent, err)
		}
	}
	for _, parent := range []string{"/", "a", "/a/.", "/a/..", "/a//b", "/a/", "/a/b:c", "/a/b\\c", "/a/$b", "/a/é", "/a/" + strings.Repeat("b", 256), "/a/a.slice"} {
		if err := ValidateCgroupParent(parent); err == nil {
			t.Fatalf("accepted %q", parent)
		}
	}
}

func TestInspectExposesMeasuredContainerParentAndPID(t *testing.T) {
	c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
		return []byte(`[{"Id":"c1","Name":"/c","HostConfig":{"CgroupParent":"/cell/claim"},"State":{"Pid":1234}}]`), nil
	}}
	got, err := c.Inspect(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].CgroupParent != "/cell/claim" || got[0].PID != 1234 {
		t.Fatalf("%+v", got)
	}
}

func TestCgroupInfoReportsDaemonAndRootlessMode(t *testing.T) {
	for _, rootless := range []bool{false, true} {
		out := `{"ID":"daemon-1","Name":"linux-host","CgroupDriver":"cgroupfs","CgroupVersion":"2","SecurityOptions":["name=seccomp,profile=builtin"]}`
		if rootless {
			out = strings.Replace(out, "name=seccomp,profile=builtin", "name=rootless", 1)
		}
		c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
			if strings.Join(args, " ") != "info --format {{json .}}" {
				t.Fatalf("args %q", args)
			}
			return []byte(out), nil
		}}
		got, err := c.CgroupInfo(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if got.Version != "2" || got.Driver != "cgroupfs" || got.Rootless != rootless || got.ID != "daemon-1" {
			t.Fatalf("%+v", got)
		}
	}
}

func TestCgroupInfoRefusesMissingOrMalformedFacts(t *testing.T) {
	for _, out := range []string{`{`, `{}`, `{"CgroupVersion":"2"}`, `{"CgroupDriver":"cgroupfs"}`, `{"CgroupDriver":"cgroupfs","CgroupVersion":"2"}`} {
		c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) { return []byte(out), nil }}
		if _, err := c.CgroupInfo(context.Background()); err == nil {
			t.Fatalf("accepted daemon info %q", out)
		}
	}
}

func TestLegacyLaunchesDoNotSelectAnAggregateParent(t *testing.T) {
	var calls [][]string
	c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
		calls = append(calls, append([]string(nil), args...))
		if args[0] == "inspect" {
			return []byte(`[{"Id":"c1","Name":"/holder"}]`), nil
		}
		return []byte("c1"), nil
	}}
	if _, err := c.RunHolder(context.Background(), HolderSpec{Name: "holder", Image: "i", Runtime: "runsc", Network: "n"}); err != nil {
		t.Fatal(err)
	}
	if err := c.RunBuild(context.Background(), BuildRun{Image: "i", Runtime: "runsc", Out: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	if err := c.CopyVolumeIn(context.Background(), "runsc", "i", "from", "to", nil); err != nil {
		t.Fatal(err)
	}
	for _, args := range calls {
		if strings.Contains(strings.Join(args, " "), "--cgroup-parent") {
			t.Fatalf("disabled path selected parent: %q", args)
		}
	}
}

func TestDaemonEndpointHonorsDockerSelectionPrecedence(t *testing.T) {
	for _, tc := range []struct {
		name, host, selected, want string
		inspect                    bool
	}{
		{name: "host overrides default", host: "unix:///run/isolated.sock", want: "unix:///run/isolated.sock"},
		{name: "explicit context overrides host", host: "tcp://ignored:2375", selected: "fixture", want: "unix:///run/context.sock", inspect: true},
		{name: "selected default context", want: "unix:///run/context.sock", inspect: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("DOCKER_HOST", tc.host)
			t.Setenv("DOCKER_CONTEXT", tc.selected)
			called := false
			c := CLI{Run: func(_ context.Context, _ []byte, _ string, args ...string) ([]byte, error) {
				called = true
				want := []string{"context", "inspect", "--format", "{{.Endpoints.docker.Host}}"}
				if tc.selected != "" {
					want = append(want, "--", tc.selected)
				}
				if strings.Join(args, "\x00") != strings.Join(want, "\x00") {
					t.Fatalf("args %q want %q", args, want)
				}
				return []byte("unix:///run/context.sock\n"), nil
			}}
			got, err := c.DaemonEndpoint(context.Background())
			if err != nil || got != tc.want || called != tc.inspect {
				t.Fatalf("got=%q called=%v err=%v", got, called, err)
			}
		})
	}
}

func TestDaemonEndpointRefusesEmptyOrAmbiguousContext(t *testing.T) {
	t.Setenv("DOCKER_HOST", "")
	t.Setenv("DOCKER_CONTEXT", "")
	for _, out := range []string{"", "\n", "unix:///one\nunix:///two\n"} {
		c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) { return []byte(out), nil }}
		if _, err := c.DaemonEndpoint(context.Background()); err == nil {
			t.Fatalf("accepted %q", out)
		}
	}
}

func TestGeneratedSystemdParentAndRuntimeArgsArePreserved(t *testing.T) {
	parent := "kodus0123456789ab-" + strings.Repeat("a", 64) + ".slice"
	if err := ValidateCgroupParent(parent); err != nil {
		t.Fatal(err)
	}
	c := CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
		return []byte(`{"CgroupDriver":"systemd","CgroupVersion":"2","SecurityOptions":[],"Runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":["--systemd-cgroup"]}}}`), nil
	}}
	info, err := c.CgroupInfo(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	runsc := info.Runtimes["runsc"]
	if runsc.Path != "/usr/bin/runsc" || len(runsc.RuntimeArgs) != 1 || runsc.RuntimeArgs[0] != "--systemd-cgroup" {
		t.Fatalf("runtime=%+v", runsc)
	}
	for _, bad := range []string{"system.slice", "kodus0123456789ab.slice", parent + "/other", strings.Replace(parent, "a.slice", "A.slice", 1)} {
		if err := ValidateCgroupParent(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/claimlimits"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
)

func TestAggregateClaimLimitsAreExplicitAndValidated(t *testing.T) {
	s, err := parse(t)
	if err != nil {
		t.Fatal(err)
	}
	if s.GVisorClaimLimits != "off" || s.GVisorClaimCgroupRoot != "" {
		t.Fatalf("unexpected defaults: %+v", s)
	}
	for _, args := range [][]string{{"-gvisor-claim-limits", "auto"}, {"-gvisor-claim-limits", "required"}, {"-driver", "docker-gvisor", "-gvisor-claim-limits", "required"}, {"-gvisor-claim-cgroup-root", "/sys/fs/cgroup/test"}} {
		if _, err := parse(t, args...); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if _, err := startOn(t, "", "-driver", "local-docker", "-dev-insecure-local-docker", "-gvisor-claim-limits", "required", "-gvisor-claim-cgroup-root", "/sys/fs/cgroup/test"); err == nil {
		t.Fatal("claim limits accepted on local-docker")
	}
	if _, err := parse(t, "-driver", "docker-gvisor", "-gvisor-claim-limits", "required", "-gvisor-claim-cgroup-root", "/sys/fs/cgroup/test"); err != nil {
		t.Fatal(err)
	}
}

func TestAggregateClaimLimitsRejectRemoteEndpoints(t *testing.T) {
	for _, s := range []string{"", "tcp://127.0.0.1:2375", "ssh://example", "unix://relative", "unix:///a/../b", "unix:///a\n"} {
		if err := validateClaimEndpoint(s); err == nil {
			t.Errorf("accepted %q", s)
		}
	}
	if err := validateClaimEndpoint("unix:///var/run/docker.sock"); err != nil {
		t.Fatal(err)
	}
}

func TestAggregateClaimLimitsRequirePhysicalAdmission(t *testing.T) {
	if _, err := startOn(t, "gvisor", append(claimLimitArgs, "-driver", "docker-gvisor", "-memory-admission=false")...); err == nil {
		t.Fatal("aggregate mode accepted disabled physical admission")
	}
}

func TestSystemdClaimLimitConfigurationIsExplicitAndExclusive(t *testing.T) {
	s, err := parse(t)
	if err != nil || s.GVisorClaimLimitBackend != "cgroupfs" {
		t.Fatalf("default=%+v err=%v", s, err)
	}
	args := []string{"-driver", "docker-gvisor", "-gvisor-claim-limits", "required", "-gvisor-claim-limit-backend", "systemd", "-gvisor-claim-root-slice", "kodus0123456789ab.slice"}
	s, err = parse(t, args...)
	if err != nil || s.GVisorClaimRootSlice != "kodus0123456789ab.slice" {
		t.Fatalf("systemd=%+v err=%v", s, err)
	}
	for _, bad := range [][]string{
		{"-gvisor-claim-limit-backend", "other"},
		{"-gvisor-claim-limit-backend", "systemd"},
		{"-driver", "docker-gvisor", "-gvisor-claim-limits", "required", "-gvisor-claim-limit-backend", "systemd"},
		append(append([]string{}, args...), "-gvisor-claim-cgroup-root", "/sys/fs/cgroup/cell"),
		{"-driver", "docker-gvisor", "-gvisor-claim-limits", "required", "-gvisor-claim-root-slice", "kodus0123456789ab.slice", "-gvisor-claim-cgroup-root", "/sys/fs/cgroup/cell"},
	} {
		if _, err := parse(t, bad...); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
}

type testLimitLifecycle struct {
	calls []string
	fail  string
	// drained: RequireEmpty passes once the drain ran ("empty_until_drain").
	drained bool
}

func (f *testLimitLifecycle) Ensure(string, claimlimits.Limits) (string, error) { return "", nil }
func (f *testLimitLifecycle) Verify(string, int) error                          { return nil }
func (f *testLimitLifecycle) Remove(string) error                               { return nil }
func (f *testLimitLifecycle) Lower(string, int64) error                         { return nil }
func (f *testLimitLifecycle) Usage(string) (claimlimits.Usage, error) {
	return claimlimits.Usage{}, nil
}

func (f *testLimitLifecycle) PruneEmpty() error {
	f.calls = append(f.calls, "prune")
	if f.fail == "prune" {
		return errors.New("prune failed")
	}
	return nil
}

func (f *testLimitLifecycle) RequireEmpty() error {
	f.calls = append(f.calls, "empty")
	if f.fail == "empty" || f.fail == "drain" || f.fail == "empty_until_drain" && !f.drained {
		return errors.New("live claims remain")
	}
	return nil
}
func (f *testLimitLifecycle) Close() error { f.calls = append(f.calls, "close"); return nil }
func TestClaimLimitsFactoryPrunesBeforeAdmissionAndClosesOnFailure(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///run/isolated.sock")
	t.Setenv("DOCKER_CONTEXT", "")
	for _, backend := range []string{"cgroupfs", "systemd"} {
		for _, fail := range []string{"", "prune", "empty", "empty_until_drain", "drain"} {
			t.Run(backend+fail, func(t *testing.T) {
				s := settings{GVisorClaimLimitBackend: backend, GVisorClaimCgroupRoot: "/sys/fs/cgroup/cell", GVisorClaimRootSlice: claimlimits.RootSliceName("cell-1")}
				m := &testLimitLifecycle{fail: fail}
				cli := dockercli.CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
					return []byte(`{"CgroupDriver":"` + backend + `","CgroupVersion":"2","SecurityOptions":[],"Runtimes":{"runsc":{"path":"/usr/bin/runsc","runtimeArgs":["--systemd-cgroup"]}}}`), nil
				}}
				got, err := configureClaimLimitsWith(context.Background(), cli, s, "cell-1", func(_ context.Context, b, root, cell string) (claimlimits.Lifecycle, error) {
					want := s.GVisorClaimCgroupRoot
					if backend == "systemd" {
						want = s.GVisorClaimRootSlice
					}
					if b != backend || root != want || cell != "cell-1" {
						t.Fatalf("factory args %q %q %q", b, root, cell)
					}
					return m, nil
				}, func(context.Context) error {
					m.calls = append(m.calls, "drain")
					if fail == "drain" {
						return errors.New("drain failed")
					}
					m.drained = true
					return nil
				})
				want := map[string]string{
					"":      "prune,empty",
					"prune": "prune,close",
					// R3-04: a group left by the previous process used to
					// refuse the start until the old machines' ceilings
					// passed; the cell drains them and checks again.
					"empty":             "prune,empty,drain,prune,empty,close",
					"empty_until_drain": "prune,empty,drain,prune,empty",
					"drain":             "prune,empty,drain,close",
				}[fail]
				ok := fail == "" || fail == "empty_until_drain"
				if strings.Join(m.calls, ",") != want || (err == nil) != ok || (got == nil) == ok {
					t.Fatalf("calls=%v got=%v err=%v", m.calls, got, err)
				}
			})
		}
	}
}

func TestClaimLimitFactoryRefusesWrongDaemonBeforeOpeningRoot(t *testing.T) {
	t.Setenv("DOCKER_HOST", "unix:///run/isolated.sock")
	t.Setenv("DOCKER_CONTEXT", "")
	cli := dockercli.CLI{Run: func(context.Context, []byte, string, ...string) ([]byte, error) {
		return []byte(`{"CgroupDriver":"systemd","CgroupVersion":"2","SecurityOptions":[]}`), nil
	}}
	called := false
	_, err := configureClaimLimitsWith(context.Background(), cli, settings{GVisorClaimLimitBackend: "systemd"}, "cell-1", func(context.Context, string, string, string) (claimlimits.Lifecycle, error) {
		called = true
		return nil, nil //nolint:nilnil // never reached: the test fails if this is called
	}, func(context.Context) error { return nil })
	if err == nil || called {
		t.Fatal("missing runsc mode reached root controller")
	}
}

func TestSystemdClaimLimitConfigFileAndFlagPrecedence(t *testing.T) {
	p := filepath.Join(t.TempDir(), "cell.yaml")
	if err := os.WriteFile(p, []byte("driver: docker-gvisor\nclaimLimits: required\nclaimLimitBackend: systemd\nclaimRootSlice: kodus0123456789ab.slice\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := parse(t, "-config", p)
	if err != nil || s.GVisorClaimLimitBackend != "systemd" || s.GVisorClaimRootSlice != "kodus0123456789ab.slice" {
		t.Fatalf("file=%+v err=%v", s, err)
	}
	s, err = parse(t, "-config", p, "-gvisor-claim-root-slice", "kodusabcdef123456.slice")
	if err != nil || s.GVisorClaimRootSlice != "kodusabcdef123456.slice" {
		t.Fatalf("flag=%+v err=%v", s, err)
	}
}

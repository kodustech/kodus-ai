package main

import (
	"context"
	"errors"
	"os"
	"regexp"
	"testing"
)

// The chart's CronJob runs this binary with a -driver it must know: the
// k8s-sandbox reaper used to exit "unknown driver" on every run.
func TestTheChartsReaperDriverIsSupported(t *testing.T) {
	b, err := os.ReadFile("../../deploy/chart/runtime-cell/templates/reaper-cronjob.yaml")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`"-driver", "([^"]+)"`).FindSubmatch(b)
	if m == nil {
		t.Fatal("no -driver in the reaper CronJob")
	}
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	_, err = newDriver(context.Background(), string(m[1]), "cell-1", gvisorFlags{})
	if errors.Is(err, errUnsupported) {
		t.Fatalf("the chart runs -driver %s, which the reaper does not support", m[1])
	}
}

func TestNoFakeReaper(t *testing.T) {
	if _, err := newDriver(context.Background(), "fake", "cell-1", gvisorFlags{}); !errors.Is(err, errUnsupported) {
		t.Fatalf("fake: %v", err)
	}
}

// The driver the self-hosted cells run had no reaper (S-08): -driver
// docker-gvisor exited "unsupported driver".
func TestDockerGVisorHasAReaper(t *testing.T) {
	if _, err := newDriver(context.Background(), "docker-gvisor", "cell-1", gvisorFlags{workDir: t.TempDir()}); err != nil {
		t.Fatalf("docker-gvisor: %v", err)
	}
}

//go:build unix

package guest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// A sandbox the cell mounted its CA into (a claim with org secrets): every
// command starts with the trust variables, shown as they are (the machine's
// own setting, not a caller's secret).
func TestASandboxWithTheCellsCAMountedPointsEveryCommandAtIt(t *testing.T) {
	dir := t.TempDir()
	bundle, ca := filepath.Join(dir, "ca-bundle.pem"), filepath.Join(dir, "cell-ca.pem")
	must(t, os.WriteFile(bundle, []byte("bundle"), 0o644))
	must(t, os.WriteFile(ca, []byte("ca"), 0o644))
	env := trustEnvAt(bundle, ca)
	if len(env) != len(machinetrust.EnvNames) {
		t.Fatalf("env %v", env)
	}
	fs, _, _ := sandbox(t)
	fs.WithEnv(env)
	r := runCmd(t, fs, `echo "$SSL_CERT_FILE $NODE_EXTRA_CA_CERTS $GIT_SSL_CAINFO"`, 10_000, nil)
	if got := strings.TrimSpace(r.Exec.Stdout); got != bundle+" "+ca+" "+bundle {
		t.Fatalf("stdout %q", got)
	}
}

func TestASandboxWithoutTheCellsCAGetsNoTrustVariables(t *testing.T) {
	dir := t.TempDir()
	bundle := filepath.Join(dir, "ca-bundle.pem")
	must(t, os.WriteFile(bundle, []byte("bundle"), 0o644))
	if env := trustEnvAt(bundle, filepath.Join(dir, "missing.pem")); env != nil {
		t.Fatalf("env %v with one file missing", env)
	}
	if env := trustEnvAt(dir, dir); env != nil {
		t.Fatalf("env %v for a directory", env)
	}
	fs, _, _ := sandbox(t)
	fs.WithEnv(nil)
	r := runCmd(t, fs, `echo "[$SSL_CERT_FILE$NODE_EXTRA_CA_CERTS]"`, 10_000, nil)
	if strings.TrimSpace(r.Exec.Stdout) != "[]" {
		t.Fatalf("stdout %q", r.Exec.Stdout)
	}
}

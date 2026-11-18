//go:build unix

package guest

import (
	"os"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
)

// MountedTrustEnv is the trust variables of a sandbox the cell mounted its
// CA into (a claim with org secrets, machinetrust): set when both files are
// at their targets, nil otherwise, so a sandbox without secrets keeps the
// tool image's own trust. The root file system is read-only: nothing in the
// machine can put a file there.
func MountedTrustEnv() map[string]string {
	return trustEnvAt(machinetrust.BundleTarget, machinetrust.CellCATarget)
}

func trustEnvAt(bundle, cellCA string) map[string]string {
	for _, p := range []string{bundle, cellCA} {
		if st, err := os.Stat(p); err != nil || !st.Mode().IsRegular() {
			return nil
		}
	}
	return machinetrust.Env(bundle, cellCA)
}

package agent

import (
	"strings"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/machinetrust"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// A variable the cell sets in every machine (the guest agent's base env, the
// trust variables) is one the API refuses as a secret name, so an admin is
// told at once instead of the cell dropping the secret on each claim.
func TestTheAPIRefusesASecretNamedAfterAVariableTheCellSets(t *testing.T) {
	reserved := map[string]bool{}
	for _, n := range protocol.ReservedSecretNames {
		reserved[n] = true
	}
	names := append([]string{}, machinetrust.EnvNames...)
	for _, kv := range guest.BaseEnv {
		names = append(names, strings.SplitN(kv, "=", 2)[0])
	}
	for _, n := range names {
		if !reserved[n] {
			t.Errorf("%s is set by the cell but not reserved in RUNTIME_SECRET_RESERVED_NAMES (libs/runtime/api/domain/secrets.ts)", n)
		}
		if secretNameRefused(n) != "reserved_name" {
			t.Errorf("the cell does not drop a secret named %s", n)
		}
	}
}

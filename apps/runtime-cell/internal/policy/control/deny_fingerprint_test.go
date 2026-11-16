package control

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/netguard"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/policy"
)

// The operator's deny list is a flag of the proxy and a flag of the
// resolver. Before, nothing compared them: a resolver started without the
// proxy's -deny-hosts answered names the proxy refused, and the reverse.

type enforcer struct {
	name, denyHosts string
}

func pushTo(t *testing.T, enforcers ...enforcer) error {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	var eps []Endpoint
	for _, e := range enforcers {
		srv := &Server{Policies: policy.NewStore(nil), AgentKey: pub}
		if e.denyHosts != "-" {
			deny, err := netguard.ParseDenyList(e.denyHosts, nil)
			if err != nil {
				t.Fatal(err)
			}
			srv.DenyFingerprint = deny.Fingerprint()
		}
		hs := httptest.NewServer(srv.Handler())
		t.Cleanup(hs.Close)
		eps = append(eps, Endpoint{Name: e.name, URL: hs.URL})
	}
	pol := policy.ClaimPolicy{ClaimID: "claim-1", OrgID: "o", Sources: []string{"10.0.0.1"}, Phase: policy.PhaseTest, ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}
	return Pusher{Endpoints: eps, Key: priv}.Push(context.Background(), pol)
}

func TestAResolverAndAProxyGivenDifferentOperatorListsAreDetected(t *testing.T) {
	err := pushTo(t, enforcer{EndpointEgress, ".corp.example,files.example"}, enforcer{EndpointResolver, ".corp.example"}, enforcer{EndpointInjector, "-"})
	if !errors.Is(err, ErrDenyListsDiffer) {
		t.Fatalf("push = %v, want ErrDenyListsDiffer", err)
	}
}

func TestAProxyAndAResolverGivenTheSameOperatorListTakeThePush(t *testing.T) {
	if err := pushTo(t, enforcer{EndpointEgress, "files.example,.corp.example"}, enforcer{EndpointResolver, " .Corp.Example ,files.example"}, enforcer{EndpointInjector, "-"}); err != nil {
		t.Fatal(err)
	}
}

// An enforcer of a release before the fingerprint reports none: the push
// goes through, so the cell and its enforcers can be upgraded in any order.
func TestAnEnforcerThatReportsNoFingerprintIsNotCompared(t *testing.T) {
	if err := pushTo(t, enforcer{EndpointEgress, ".corp.example"}, enforcer{EndpointResolver, "-"}); err != nil {
		t.Fatal(err)
	}
}

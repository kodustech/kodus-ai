package policy

import (
	"testing"
	"time"
)

func TestBuildKeepsTheGoPinsSortedAndPinsGoFindsThem(t *testing.T) {
	p, _, err := Build(Spec{ClaimID: "c1", OrgID: "o", Phase: PhaseBuild, Sources: []string{"10.0.0.2"},
		GoPins:    []string{"golang.org/x/mod@v0.20.0", "github.com/a/b@v1.0.0", "github.com/a/b@v1.0.0"},
		ExpiresAt: time.Now().Add(time.Hour), IssuedAt: time.Now()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.GoPins) != 2 || !p.PinsGo("github.com/a/b", "v1.0.0") || !p.PinsGo("golang.org/x/mod", "v0.20.0") || p.PinsGo("github.com/a/b", "v1.0.1") {
		t.Fatalf("%v", p.GoPins)
	}
}

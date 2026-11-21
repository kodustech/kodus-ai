package compose

import (
	"reflect"
	"strings"
	"testing"
)

const withProfiles = `services:
  web: { image: web }
  mcp: { image: mcp, profiles: [mcp] }
  debug: { image: debug, profiles: [debug, tools] }
  worker: { image: worker, profiles: [mcp, jobs] }
`

func TestActivateProfilesKeepsWhatComposeWouldStart(t *testing.T) {
	p, err := FromYAML([]byte(withProfiles))
	if err != nil {
		t.Fatal(err)
	}
	if err := p.ActivateProfiles([]string{"mcp"}); err != nil {
		t.Fatal(err)
	}
	if got := p.ServiceNames(); !reflect.DeepEqual(got, []string{"mcp", "web", "worker"}) {
		t.Fatalf("services %v", got)
	}
	for _, n := range p.ServiceNames() {
		if _, ok := p.Service(n)["profiles"]; ok {
			t.Errorf("%s keeps its profiles key: compose run without --profile would not start it", n)
		}
	}
}

func TestActivateProfilesWithoutProfilesChangesNothing(t *testing.T) {
	p, _ := FromYAML([]byte(withProfiles))
	if err := p.ActivateProfiles(nil); err != nil || len(p.ServiceNames()) != 4 || p.Service("mcp")["profiles"] == nil {
		t.Fatalf("%v %v", err, p.ServiceNames())
	}
}

func TestActivateProfilesRefusesADependencyLeftBehind(t *testing.T) {
	for _, y := range []string{
		"services:\n  web: { image: web, depends_on: [db] }\n  db: { image: pg, profiles: [local-db] }\n",
		"services:\n  web: { image: web, depends_on: { db: { condition: service_healthy } } }\n  db: { image: pg, profiles: [local-db] }\n",
	} {
		p, _ := FromYAML([]byte(y))
		if err := p.ActivateProfiles([]string{"mcp"}); err == nil || !strings.Contains(err.Error(), `depends on "db"`) {
			t.Errorf("%v", err)
		}
	}
	p, _ := FromYAML([]byte("services:\n  web: { image: web, profiles: oops }\n"))
	if err := p.ActivateProfiles([]string{"mcp"}); err == nil {
		t.Error("profiles that is not a list was taken")
	}
}

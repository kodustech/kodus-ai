package sandbox

import (
	"go.yaml.in/yaml/v3"
	"strings"
	"testing"
)

// A trusted parent must be forced on every service without granting the
// repository access to the host's cgroup hierarchy.
func TestApplyInjectsOnlyTheTrustedCgroupParent(t *testing.T) {
	o := opts(checkout(t))
	o.CgroupParent = "/kodus-cell/claim-ab12"
	out, err := Apply([]byte(good), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	for name, raw := range doc["services"].(map[string]any) {
		if raw.(map[string]any)["cgroup_parent"] != o.CgroupParent {
			t.Fatalf("%s missing trusted parent", name)
		}
	}
	_, err = Apply([]byte("services:\n  api:\n    image: app\n    cgroup_parent: /attacker/claim\n"), o)
	if err == nil {
		t.Fatal("repository supplied cgroup parent was accepted")
	}
}

func TestCanonicalRequiresExactlyTheTrustedParent(t *testing.T) {
	o := opts(checkout(t))
	o.CgroupParent = "/kodus-cell/claim-ab12"
	base := canonical("")
	withParent := strings.Replace(base, `"runtime":"runsc"`, `"runtime":"runsc","cgroup_parent":"`+o.CgroupParent+`"`, 1)
	if err := VerifyCanonical([]byte(withParent), o); err != nil {
		t.Fatalf("trusted parent refused: %v", err)
	}
	for _, bad := range []string{base, strings.Replace(withParent, o.CgroupParent, "/other/claim", 1), strings.Replace(withParent, `"cgroup_parent":"`+o.CgroupParent+`"`, `"cgroup_parent":false`, 1)} {
		if err := VerifyCanonical([]byte(bad), o); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	o.CgroupParent = ""
	if err := VerifyCanonical([]byte(withParent), o); err == nil {
		t.Fatal("unexpected parent accepted while disabled")
	}
}

func TestSandboxRejectsInvalidTrustedParent(t *testing.T) {
	for _, parent := range []string{"/", "relative", "/a/../b", "/system.slice"} {
		o := opts(checkout(t))
		o.CgroupParent = parent
		if _, err := Apply([]byte("services:\n  api:\n    image: app\n"), o); err == nil {
			t.Fatalf("Apply accepted %q", parent)
		}
		if err := VerifyCanonical([]byte(canonical("")), o); err == nil {
			t.Fatalf("VerifyCanonical accepted %q", parent)
		}
	}
}

func TestGeneratedSystemdParentIsInjectedAndCanonicalMustMatchExactly(t *testing.T) {
	o := opts(checkout(t))
	o.CgroupParent = "kodus0123456789ab-" + strings.Repeat("a", 64) + ".slice"
	out, err := Apply([]byte(good), o)
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err = yaml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	for _, raw := range doc["services"].(map[string]any) {
		if raw.(map[string]any)["cgroup_parent"] != o.CgroupParent {
			t.Fatal("parent name lost")
		}
	}
	with := strings.Replace(canonical(""), `"runtime":"runsc"`, `"runtime":"runsc","cgroup_parent":"`+o.CgroupParent+`"`, 1)
	if err = VerifyCanonical([]byte(with), o); err != nil {
		t.Fatal(err)
	}
	if err = VerifyCanonical([]byte(strings.Replace(with, o.CgroupParent, strings.Replace(o.CgroupParent, "kodus0", "kodus1", 1), 1)), o); err == nil {
		t.Fatal("other valid slice accepted")
	}
}

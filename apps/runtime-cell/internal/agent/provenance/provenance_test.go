package provenance

import "testing"

func TestLatestIsTheEnvironmentsLastBakeAndNoOthers(t *testing.T) {
	r := New()
	if id, _, baked := r.Resolve("org-a", "env-1", LatestImage); id != "" || baked {
		t.Fatalf("latest before any bake resolved to %q (baked %v)", id, baked)
	}
	r.Add("img-1", Image{OrgID: "org-a", EnvironmentID: "env-1", SHA: "s1"}, true)
	r.Add("img-old", Image{OrgID: "org-a", EnvironmentID: "env-1", SHA: "s0"}, false)
	id, img, baked := r.Resolve("org-a", "env-1", LatestImage)
	if id != "img-1" || !baked || img.SHA != "s1" {
		t.Fatalf("latest resolved to %q %+v %v", id, img, baked)
	}
	if id, _, baked := r.Resolve("org-a", "env-2", LatestImage); id != "" || baked {
		t.Fatal("another environment took this one's bake")
	}
	if id, _, baked := r.Resolve("org-a", "env-1", "someone-elses"); id != "someone-elses" || baked {
		t.Fatal("an image this cell did not bake counts as baked")
	}
	if _, ok := r.Baked("img-old"); !ok || r.Latest("org-a", "env-1") != "img-1" {
		t.Fatal("an older bake replaced the latest or was lost")
	}
}

func TestOneBakeInProgressPerEnvironment(t *testing.T) {
	r := New()
	finish, ok := r.Reserve("org-a", "env-1")
	if !ok {
		t.Fatal("first reservation refused")
	}
	if _, ok := r.Reserve("org-a", "env-1"); ok {
		t.Fatal("a second bake of the environment was reserved")
	}
	if other, ok := r.Reserve("org-a", "env-2"); !ok {
		t.Fatal("another environment was blocked")
	} else {
		other()
	}
	finish()
	finish() // once
	if _, _, active := r.Counts(); active != 0 {
		t.Fatalf("%d reservations leaked", active)
	}
	if _, ok := r.Reserve("org-a", "env-1"); !ok {
		t.Fatal("the environment stayed reserved after its bake")
	}
}

func TestTaintFollowsTheMachine(t *testing.T) {
	r := New()
	r.Taint("m-1")
	if !r.Tainted("m-1") || r.Tainted("m-2") {
		t.Fatal("taint")
	}
	r.Untaint("m-1")
	if tainted, _, _ := r.Counts(); r.Tainted("m-1") || tainted != 0 {
		t.Fatal("a destroyed machine stayed tainted")
	}
}

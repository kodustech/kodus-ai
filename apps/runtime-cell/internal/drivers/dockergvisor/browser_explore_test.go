package dockergvisor

import (
	"context"
	"testing"
)

func TestBrowserExploreImageMustDeclarePinnedNativeContractBeforeAdvertising(t *testing.T) {
	d, r, err := newDriver(t, `{"runsc":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	for _, labels := range []string{`{}`, `{"io.kodus.browser-explore.protocol":"1"}`, `{"io.kodus.browser-explore.protocol":"1","io.kodus.agent-browser.version":"other"}`} {
		r.answers["image"] = labels
		if err := d.CheckBrowserExploreImage(context.Background(), browserImage); err == nil {
			t.Fatal("legacy/unversioned image accepted")
		}
	}
	r.answers["image"] = `{"io.kodus.browser-explore.protocol":"1","io.kodus.agent-browser.version":"0.41.2"}`
	if err := d.CheckBrowserExploreImage(context.Background(), browserImage); err != nil {
		t.Fatal(err)
	}
	if err := d.CheckBrowserExploreImage(context.Background(), "browser:latest"); err == nil {
		t.Fatal("mutable image accepted")
	}
	if r.find("run") != nil {
		t.Fatal("image preflight executed anything on the host")
	}
}

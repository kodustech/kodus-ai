package dockergvisor

import (
	"context"
	"slices"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/dockercli"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/isolation"
)

// The driver says what its backend and host give: gVisor, no memory
// snapshot, nested containers, and the host's KVM and arch as probed.
func TestTheDriverAnnouncesItsBackendAndHost(t *testing.T) {
	r := &recorder{answers: map[string]string{"info": `{"runsc":{}}`}}
	d, err := New(context.Background(), dockercli.CLI{Run: r.run}, Config{CellID: "cell-1", HolderImage: "h", WorkDir: t.TempDir(), Host: &isolation.Host{KVM: true, Arch: "arm64"}})
	if err != nil {
		t.Fatal(err)
	}
	c := d.Capabilities()
	if !slices.Equal(c.Backends, []string{isolation.GVisor}) || !c.NestedContainers || !c.KVM || c.HostArch != "arm64" {
		t.Fatalf("capabilities %+v", c)
	}
	if d.Parts().SnapshotsMemory() {
		t.Fatal("a gVisor driver says it keeps memory snapshots")
	}
}

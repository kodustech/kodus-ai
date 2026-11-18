package isolation

import "testing"

// A fresh cell (auto) runs gVisor unless the host can run microVMs that
// take every kind of work; an explicit backend is never second-guessed.
func TestChoose(t *testing.T) {
	kvm := Host{KVM: true, Arch: "x86_64"}
	ready := MicroVMReadiness{Kit: true, RunsEnvironments: true}
	cases := []struct {
		name      string
		requested string
		host      Host
		vm        MicroVMReadiness
		want      string
	}{
		{"no KVM", Auto, Host{Arch: "x86_64"}, ready, GVisor},
		{"empty means auto", "", Host{Arch: "arm64"}, ready, GVisor},
		{"KVM without a kit", Auto, kvm, MicroVMReadiness{RunsEnvironments: true}, GVisor},
		{"KVM and a kit, microVMs take sandboxes only", Auto, kvm, MicroVMReadiness{Kit: true}, GVisor},
		{"KVM, a kit, environments on microVMs", Auto, kvm, ready, Firecracker},
		{"asked for gVisor on a KVM host", GVisor, kvm, ready, GVisor},
		{"asked for firecracker without KVM", Firecracker, Host{}, MicroVMReadiness{}, Firecracker},
	}
	for _, c := range cases {
		got, err := Choose(c.requested, c.host, c.vm)
		if err != nil || got.Backend != c.want || got.Why == "" {
			t.Errorf("%s: Choose = %+v, %v; want %s with a reason", c.name, got, err, c.want)
		}
	}
	if _, err := Choose("kata", kvm, ready); err == nil {
		t.Error("an unknown backend was accepted")
	}
}

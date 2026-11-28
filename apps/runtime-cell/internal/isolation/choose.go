package isolation

import "fmt"

// Auto lets the cell pick its backend from the host (-isolation-backend
// auto, the default; docs/runtime/self-hosted.md "Defaults of a fresh cell").
const Auto = "auto"

// MicroVMReadiness is what firecracker needs beyond KVM before a cell picks
// it by itself.
type MicroVMReadiness struct {
	// Kit: the operator gave the cell a microVM kit (and its digest) to run.
	Kit bool
	// RunsEnvironments: the microVM driver boots an environment's compose
	// project, so the cell takes Runs as well as code sandboxes.
	RunsEnvironments bool
}

// Choice is the backend the cell runs and why.
type Choice struct {
	Backend string
	// Why says, for auto, what decided it.
	Why string
}

// Choose resolves the backend the operator asked for: gvisor and
// firecracker as they are (each still checks its host when it opens), auto
// firecracker only on a host whose /dev/kvm opens, with a kit, once the
// microVM driver runs environments; gVisor otherwise, so a fresh cell always
// takes every kind of work.
func Choose(requested string, host Host, vm MicroVMReadiness) (Choice, error) {
	switch requested {
	case GVisor, Firecracker:
		return Choice{Backend: requested, Why: "asked for"}, nil
	case Auto, "":
	default:
		return Choice{}, fmt.Errorf("isolation backend %q: auto, gvisor or firecracker", requested)
	}
	switch {
	case !host.KVM:
		return Choice{Backend: GVisor, Why: "no usable /dev/kvm"}, nil
	case !vm.Kit:
		return Choice{Backend: GVisor, Why: "KVM is usable but no microVM kit is configured (-firecracker-kit)"}, nil
	case !vm.RunsEnvironments:
		return Choice{Backend: GVisor, Why: "KVM and a kit are there, but microVM cells run code sandboxes only; environment Runs need gVisor"}, nil
	}
	return Choice{Backend: Firecracker, Why: "KVM is usable and a microVM kit is configured"}, nil
}

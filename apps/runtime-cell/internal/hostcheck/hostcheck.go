// Package hostcheck reads what makes a host fit to run many orgs'
// sandboxes side by side (SMT, KSM, swap, CPU mitigations, microcode), for
// any driver: a shared cell refuses an unsafe host at start, a dedicated
// one starts and reports it.
package hostcheck

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// A multi-tenant host's side channels and memory sharing, for every driver
// (docs/runtime/isolation-architecture.md, "Host checks"): Firecracker's
// production guide asks to disable SMT and KSM, to disable swap and to load
// the CPU's microcode, with the kernel's mitigations on. A shared cell (its
// machines are many orgs') refuses a host that is not so; a dedicated cell
// (one org's) starts and warns. Either reports what it found.

// Host policies.
const (
	// Shared refuses a host with SMT, KSM or swap on, a CPU
	// vulnerability the kernel does not mitigate, or one it cannot read.
	Shared = "shared"
	// Dedicated starts on any host and reports the same findings.
	Dedicated = "dedicated"
)

// State is what the cell found of its host.
type State struct {
	Policy string
	// SMT, KSM and Swap are "on", "off" or "unknown".
	SMT, KSM, Swap string
	// Vulnerable are the CPU vulnerabilities the kernel reports as not
	// mitigated (sysfs cpu/vulnerabilities), by name.
	Vulnerable []string
	// Microcode is the CPU's microcode revision ("" when not reported).
	Microcode string
}

// Unsafe are the findings a shared cell refuses, in words.
func (h State) Unsafe() []string {
	var out []string
	for _, c := range []struct{ name, state, why string }{
		{"SMT", h.SMT, "sibling threads share caches across VMs (echo off > /sys/devices/system/cpu/smt/control, or one thread per core at launch)"},
		{"KSM", h.KSM, "merged pages leak between VMs (echo 0 > /sys/kernel/mm/ksm/run)"},
		{"swap", h.Swap, "guest memory written to the host's disk (swapoff -a)"},
	} {
		if c.state != "off" {
			out = append(out, fmt.Sprintf("%s is %s: %s", c.name, c.state, c.why))
		}
	}
	if len(h.Vulnerable) > 0 {
		out = append(out, "the kernel reports CPU vulnerabilities as not mitigated: "+strings.Join(h.Vulnerable, ", "))
	}
	return out
}

func readTrim(read func(string) ([]byte, error), p string) (string, bool) {
	raw, err := read(p)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(string(raw)), true
}

// Probe reads the host's SMT, KSM, swap, CPU vulnerabilities and
// microcode under root ("/" on a host; tests) with read (os.ReadFile when
// nil).
func Probe(read func(string) ([]byte, error), root, policy string) State {
	if read == nil {
		read = os.ReadFile
	}
	at := func(p string) string { return filepath.Join(root, p) }
	h := State{Policy: policy, SMT: "unknown", KSM: "off", Swap: "unknown"}
	if policy == "" {
		h.Policy = Dedicated
	}
	if v, ok := readTrim(read, at("sys/devices/system/cpu/smt/active")); ok {
		h.SMT = map[string]string{"1": "on", "0": "off"}[v]
		if h.SMT == "" {
			h.SMT = "unknown"
		}
	}
	// A kernel without KSM has no ksm directory: nothing is merged. A switch
	// that is there but cannot be read is unknown, never off.
	switch raw, err := read(at("sys/kernel/mm/ksm/run")); {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		h.KSM = "unknown"
	case strings.TrimSpace(string(raw)) != "0":
		h.KSM = "on"
	}
	if v, ok := readTrim(read, at("proc/swaps")); ok {
		h.Swap = "off"
		if lines := strings.Split(v, "\n"); len(lines) > 1 {
			h.Swap = "on"
		}
	}
	dir := at("sys/devices/system/cpu/vulnerabilities")
	if ents, err := os.ReadDir(dir); err == nil {
		for _, e := range ents {
			// "KVM: Vulnerable" is itlb_multihit's on a host that runs VMs.
			if v, ok := readTrim(read, filepath.Join(dir, e.Name())); ok && (strings.HasPrefix(v, "Vulnerable") || strings.HasPrefix(v, "KVM: Vulnerable")) {
				h.Vulnerable = append(h.Vulnerable, e.Name())
			}
		}
		sort.Strings(h.Vulnerable)
	}
	if v, ok := readTrim(read, at("proc/cpuinfo")); ok {
		for _, l := range strings.Split(v, "\n") {
			if k, val, ok := strings.Cut(l, ":"); ok && strings.TrimSpace(k) == "microcode" {
				h.Microcode = strings.TrimSpace(val)
				break
			}
		}
	}
	return h
}

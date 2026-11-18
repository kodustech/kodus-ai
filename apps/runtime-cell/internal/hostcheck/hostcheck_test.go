package hostcheck

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The same host probe serves every driver: SMT, KSM, swap and the CPU
// vulnerabilities the kernel does not mitigate are what a shared cell
// refuses, each named; the microcode revision is reported alone.
func TestAHostIsReadTheSameForEveryDriver(t *testing.T) {
	root := t.TempDir()
	for p, v := range map[string]string{
		"sys/devices/system/cpu/smt/active":                           "1\n",
		"proc/swaps":                                                  "Filename Type Size Used Priority\n",
		"sys/devices/system/cpu/vulnerabilities/spectre_v2":           "Mitigation: Enhanced IBRS\n",
		"sys/devices/system/cpu/vulnerabilities/gather_data_sampling": "Vulnerable\n",
		"proc/cpuinfo":                                                "microcode\t: 0x2b000603\n",
	} {
		f := filepath.Join(root, p)
		_ = os.MkdirAll(filepath.Dir(f), 0o755)
		if err := os.WriteFile(f, []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := Probe(nil, root, "")
	if h.Policy != Dedicated || h.SMT != "on" || h.KSM != "off" || h.Swap != "off" || !slices.Equal(h.Vulnerable, []string{"gather_data_sampling"}) || h.Microcode != "0x2b000603" {
		t.Fatalf("%+v", h)
	}
	if u := h.Unsafe(); len(u) != 2 {
		t.Fatalf("unsafe %v", u)
	}
}

// F3-08: KVM iTLB multihit reads "KVM: Vulnerable", which only a prefix of
// "Vulnerable" missed, and a KSM switch the probe could not read counted as
// off. Both are now findings a shared cell refuses.
func TestKVMVulnerableAndAnUnreadableKSMAreFindings(t *testing.T) {
	root := t.TempDir()
	for p, v := range map[string]string{
		"sys/devices/system/cpu/smt/active": "0\n",
		"proc/swaps":                        "Filename Type Size Used Priority\n",
		"sys/devices/system/cpu/vulnerabilities/itlb_multihit": "KVM: Vulnerable\n",
		"sys/devices/system/cpu/vulnerabilities/spectre_v2":    "Mitigation: Enhanced IBRS\n",
	} {
		f := filepath.Join(root, p)
		_ = os.MkdirAll(filepath.Dir(f), 0o755)
		if err := os.WriteFile(f, []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// ksm/run exists but cannot be read (a directory in its place here).
	if err := os.MkdirAll(filepath.Join(root, "sys/kernel/mm/ksm/run"), 0o755); err != nil {
		t.Fatal(err)
	}
	h := Probe(nil, root, Shared)
	if !slices.Equal(h.Vulnerable, []string{"itlb_multihit"}) || h.KSM != "unknown" {
		t.Fatalf("%+v", h)
	}
	if u := h.Unsafe(); len(u) != 2 {
		t.Fatalf("unsafe %v", u)
	}
}

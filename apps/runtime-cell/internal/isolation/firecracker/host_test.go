package firecracker

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// hostRoot lays /sys and /proc files under a directory.
func hostRoot(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for p, v := range files {
		f := filepath.Join(root, p)
		if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, []byte(v), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

const swapsHeader = "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n"

// A shared cell (many orgs' machines on one host) refuses a host with SMT,
// KSM or swap on or a CPU vulnerability the kernel does not mitigate, each
// named with its fix; a dedicated cell starts there. A host that is none of
// those passes either policy, and what was found is read the same way.
func TestASharedCellRefusesAnUnsafeHostAndADedicatedOneReportsIt(t *testing.T) {
	unsafe := hostRoot(t, map[string]string{
		"sys/devices/system/cpu/smt/active":               "1\n",
		"sys/kernel/mm/ksm/run":                           "1\n",
		"proc/swaps":                                      swapsHeader + "/swapfile file 2097148 0 -2\n",
		"sys/devices/system/cpu/vulnerabilities/mds":      "Vulnerable: Clear CPU buffers attempted, no microcode\n",
		"sys/devices/system/cpu/vulnerabilities/meltdown": "Not affected\n",
		"proc/cpuinfo":                                    "processor\t: 0\nmicrocode\t: 0x2b000603\n",
	})
	h := ProbeHost(nil, unsafe, HostShared)
	if h.SMT != "on" || h.KSM != "on" || h.Swap != "on" || !slices.Equal(h.Vulnerable, []string{"mds"}) || h.Microcode != "0x2b000603" {
		t.Fatalf("probed %+v", h)
	}
	if u := h.Unsafe(); len(u) != 4 || !strings.Contains(u[0], "smt/control") {
		t.Fatalf("unsafe %v", u)
	}
	cfg := func(policy, root string) Config {
		c := Config{StateDir: t.TempDir(), HostPolicy: policy, HostRoot: root}
		return c
	}
	refusals := func(c Config) []string {
		var out []string
		for _, m := range Missing(c, false) {
			if strings.HasPrefix(m, "a shared cell's host: ") {
				out = append(out, m)
			}
		}
		return out
	}
	if got := refusals(cfg(HostShared, unsafe)); len(got) != 4 {
		t.Fatalf("a shared cell on an unsafe host: %v", got)
	}
	if got := refusals(cfg(HostDedicated, unsafe)); len(got) != 0 {
		t.Fatalf("a dedicated cell refused: %v", got)
	}
	safe := hostRoot(t, map[string]string{
		"sys/devices/system/cpu/smt/active":               "0\n",
		"proc/swaps":                                      swapsHeader,
		"sys/devices/system/cpu/vulnerabilities/meltdown": "Mitigation: PTI\n",
	})
	if got := refusals(cfg(HostShared, safe)); len(got) != 0 {
		t.Fatalf("a shared cell on a safe host: %v", got)
	}
	// A kernel that does not say whether SMT is on is not proven safe.
	if got := refusals(cfg(HostShared, hostRoot(t, map[string]string{"proc/swaps": swapsHeader}))); len(got) != 1 || !strings.Contains(got[0], "SMT is unknown") {
		t.Fatalf("SMT unknown: %v", got)
	}
}

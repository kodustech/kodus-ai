package dockercli

import (
	"slices"
	"strings"
	"testing"
)

func sandboxSpec() SandboxSpec {
	return SandboxSpec{
		HolderSpec: HolderSpec{Name: "kodus-c1-workload", Image: "sandbox@sha256:x", Network: "kodus-c1", Runtime: "runsc", Resolv: "/var/lib/cell/resolv/kodus-c1"},
		User:       "1000:1000", Memory: "4g", CPUs: "2", WorkspaceSize: "2048m", TmpSize: "512m",
	}
}

// What a command in the sandbox could use to get out: a capability, a new
// privilege, a writable root, a host directory, root. None is given.
func TestASandboxContainerGetsNoWayOut(t *testing.T) {
	args, err := SandboxArgs(sandboxSpec())
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Join(args, " ")
	for _, want := range []string{"--runtime runsc", "--cap-drop ALL", "--security-opt no-new-privileges:true", "--read-only", "--user 1000:1000", "--memory 4g", "--memory-swap 4g", "--cpus 2"} {
		if !strings.Contains(line, want) {
			t.Fatalf("missing %q in %s", want, line)
		}
	}
	for i, a := range args {
		if a == "-v" && args[i+1] != "/var/lib/cell/resolv/kodus-c1:/etc/resolv.conf:ro" {
			t.Fatalf("a host directory reaches the sandbox: %s", args[i+1])
		}
		if a == "--privileged" || a == "--cap-add" {
			t.Fatalf("%s in %s", a, line)
		}
	}
	if !slices.Contains(args, "/workspace:rw,nosuid,nodev,mode=0755,uid=1000,gid=1000,size=2048m") {
		t.Fatalf("/workspace is not a bounded tmpfs of the sandbox's user: %s", line)
	}
}

func TestASandboxSpecWithInjectedFlagsIsRefused(t *testing.T) {
	for _, edit := range []func(*SandboxSpec){
		func(s *SandboxSpec) { s.User = "0:0 --privileged" },
		func(s *SandboxSpec) { s.Memory = "4g --privileged" },
		func(s *SandboxSpec) { s.WorkspaceSize = "1g,exec" },
		func(s *SandboxSpec) { s.CPUs = "2 --cap-add=ALL" },
	} {
		s := sandboxSpec()
		edit(&s)
		if _, err := SandboxArgs(s); err == nil {
			t.Fatalf("accepted %+v", s)
		}
	}
}

// A sandbox of a claim with org secrets gets the cell's trust files, as
// read-only binds; still no other host directory.
func TestASandboxMountsTheCellsFilesReadOnly(t *testing.T) {
	s := sandboxSpec()
	s.Mounts = []string{"/var/lib/cell/trust/ca-bundle.pem:/etc/kodus/ca-bundle.pem", "/var/lib/cell/trust/cell-ca.pem:/etc/kodus/cell-ca.pem"}
	args, err := SandboxArgs(s)
	if err != nil {
		t.Fatal(err)
	}
	var binds []string
	for i, a := range args {
		if a == "-v" {
			binds = append(binds, args[i+1])
		}
	}
	want := []string{"/var/lib/cell/resolv/kodus-c1:/etc/resolv.conf:ro", "/var/lib/cell/trust/ca-bundle.pem:/etc/kodus/ca-bundle.pem:ro", "/var/lib/cell/trust/cell-ca.pem:/etc/kodus/cell-ca.pem:ro"}
	if !slices.Equal(binds, want) {
		t.Fatalf("binds %v, want %v", binds, want)
	}
}

package drivertest

import (
	"context"
	"errors"
	"testing"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
)

// RequestSubject is a driver under the request tier: every field of
// driver.UpRequest and driver.SandboxRequest is honored, by what the
// driver's backend shows afterwards, not by what the driver says. A driver
// that boots no compose project leaves Booter nil; one that makes no code
// sandbox leaves Sandboxer nil.
type RequestSubject struct {
	// Capabilities are the driver's.
	Capabilities driver.Capabilities

	Booter driver.ComposeBooter
	// Prepare readies a claim's workload machine and its project (ws/<app>
	// under a workspace root) and returns ask with Ref, Compose, ProjectDir
	// and WorkspaceRoot set. Compose has a service that builds an image
	// that asks a build secret named BuildSecretName. ask carries the other
	// fields, so a backend that stands in for compose answers as compose
	// would for them.
	Prepare func(t *testing.T, ask driver.UpRequest) driver.UpRequest
	// Booted is what the backend shows of the last Up of ref.
	Booted func(t *testing.T, ref driver.MachineRef) Booted

	Sandboxer driver.Sandboxer
	// SandboxSpec is a valid sandbox spec of a fresh claim on its network.
	SandboxSpec func(t *testing.T) driver.MachineSpec
	// SandboxTrusted is whether the backend gave the sandbox the cell's
	// trust files.
	SandboxTrusted func(t *testing.T, ref driver.MachineRef) bool
}

// BuildSecretName is the build secret Prepare's project asks for.
const BuildSecretName = "NPM_TOKEN"

// Booted is what a backend shows of one Up.
type Booted struct {
	// Trusted: the project's services got the cell's trust files.
	Trusted bool
	// Decoy is the npmrc decoy file the services read, "" without one.
	Decoy string
	// BuildSecrets: the boot acted on the claim's build secrets: handed to
	// the build that asked them, or recorded on the machine so it never
	// becomes a template or a session.
	BuildSecrets bool
}

// RunRequests runs every request check that applies to the subject, each
// on a fresh one.
func RunRequests(t *testing.T, newSubject func(t *testing.T) RequestSubject) {
	t.Helper()
	up := map[string]func(*testing.T, RequestSubject){
		"an Up asked with CellTrust gives the services the trust files": upHonorsCellTrust,
		"an Up plants the Run's npmrc decoy, and none without canaries": upHonorsCanaries,
		"an Up hands its builds the claim's secrets, and none without":  upHonorsBuildSecrets,
		"an Up gives its Output the boot's lines":                       upHonorsOutput,
		"an Up of a project outside its WorkspaceRoot is refused":       upHonorsWorkspaceRoot,
	}
	sandbox := map[string]func(*testing.T, RequestSubject){
		"a sandbox asked with CellTrust gets the trust files, or is refused as unsupported": sandboxHonorsCellTrust,
	}
	for _, name := range sortedKeys(up) {
		t.Run(name, func(t *testing.T) {
			s := newSubject(t)
			if s.Booter == nil {
				t.Skip("the driver boots no compose project (no driver.ComposeBooter)")
			}
			up[name](t, s)
		})
	}
	for _, name := range sortedKeys(sandbox) {
		t.Run(name, func(t *testing.T) {
			s := newSubject(t)
			if s.Sandboxer == nil {
				t.Skip("the driver makes no code sandbox (no driver.Sandboxer)")
			}
			sandbox[name](t, s)
		})
	}
}

func (s RequestSubject) up(t *testing.T, ask driver.UpRequest) (driver.UpRequest, Booted) {
	t.Helper()
	req := s.Prepare(t, ask)
	if _, err := s.Booter.Up(context.Background(), req); err != nil {
		t.Fatalf("Up: %v", err)
	}
	return req, s.Booted(t, req.Ref)
}

func upHonorsCellTrust(t *testing.T, s RequestSubject) {
	if _, b := s.up(t, driver.UpRequest{CellTrust: true}); !b.Trusted {
		t.Fatal("an Up asked with CellTrust left the services without the trust files")
	}
	if _, b := s.up(t, driver.UpRequest{}); b.Trusted {
		t.Fatal("an Up asked without CellTrust gave the services the trust files")
	}
}

func upHonorsCanaries(t *testing.T, s RequestSubject) {
	cs := []driver.Canary{{Slot: driver.CanarySlotNpmrc, Value: "npm_0123456789abcdef0123456789abcdef"}, {Slot: driver.CanarySlotConfig, Value: "kdx_live_0123456789abcdef"}}
	if _, b := s.up(t, driver.UpRequest{Canaries: cs}); b.Decoy != driver.CanaryFileOf(cs) {
		t.Fatalf("decoy %q, want the npmrc canary's file", b.Decoy)
	}
	if _, b := s.up(t, driver.UpRequest{}); b.Decoy != "" {
		t.Fatalf("an Up without canaries planted %q", b.Decoy)
	}
}

func upHonorsBuildSecrets(t *testing.T, s RequestSubject) {
	if _, b := s.up(t, driver.UpRequest{BuildSecrets: map[string]string{BuildSecretName: "kodus-ph-npm"}}); !b.BuildSecrets { //nolint:gosec // G101: a placeholder value the conformance suite hands the driver, not a credential
		t.Fatal("an Up handed build secrets did nothing with them")
	}
	if _, b := s.up(t, driver.UpRequest{}); b.BuildSecrets {
		t.Fatal("an Up without build secrets acted as if it had some")
	}
}

func upHonorsOutput(t *testing.T, s RequestSubject) {
	var lines []string
	s.up(t, driver.UpRequest{Output: func(l string) { lines = append(lines, l) }})
	if len(lines) == 0 {
		t.Fatal("the boot's Output got no line")
	}
	// Without an Output the same boot runs.
	s.up(t, driver.UpRequest{})
}

func upHonorsWorkspaceRoot(t *testing.T, s RequestSubject) {
	req := s.Prepare(t, driver.UpRequest{})
	if req.WorkspaceRoot == "" {
		t.Fatal("Prepare gave no workspace root")
	}
	if _, err := s.Booter.Up(context.Background(), req); err != nil {
		t.Fatalf("a project inside its workspace: %v", err)
	}
	req = s.Prepare(t, driver.UpRequest{})
	req.WorkspaceRoot = t.TempDir() // another workspace: the project is outside it
	if _, err := s.Booter.Up(context.Background(), req); err == nil {
		t.Fatal("an Up of a project outside its workspace root ran")
	}
}

func sandboxHonorsCellTrust(t *testing.T, s RequestSubject) {
	ref, err := s.Sandboxer.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: s.SandboxSpec(t)})
	if err != nil {
		t.Fatalf("CreateSandbox: %v", err)
	}
	if s.SandboxTrusted(t, ref) {
		t.Fatal("a sandbox asked without CellTrust got the trust files")
	}
	ref, err = s.Sandboxer.CreateSandbox(context.Background(), driver.SandboxRequest{Spec: s.SandboxSpec(t), CellTrust: true})
	if !s.Capabilities.SandboxCellTrust {
		if !errors.Is(err, driver.ErrUnsupported) {
			t.Fatalf("a driver whose sandboxes take no trust files answered %v, want ErrUnsupported", err)
		}
		return
	}
	if err != nil {
		t.Fatalf("CreateSandbox with CellTrust: %v", err)
	}
	if !s.SandboxTrusted(t, ref) {
		t.Fatal("a sandbox asked with CellTrust was made without the trust files")
	}
}

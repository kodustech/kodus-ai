package driver

// UpRequest is one compose Up of a claim's project: everything the boot
// must honor is a field here, so a driver cannot drop one and still
// compile. The ctx of Up carries cancellation and the trace only.
type UpRequest struct {
	// Ref is the claim's workload machine.
	Ref MachineRef
	// Compose is the cell's compose file of the project; ProjectDir the
	// checkout directory it runs from.
	Compose    []byte
	ProjectDir string
	// WorkspaceRoot is the workspace of a claim of several repositories
	// (claim/ws, ProjectDir being ws/<primary>): a host path of the project
	// may name another repository's directory, and nothing outside it. A
	// ProjectDir outside it is refused. Empty: ProjectDir is the root, as
	// for one repository.
	WorkspaceRoot string
	// CellTrust: the claim's machines must trust the cell CA (a claim with
	// org secrets, whose requests the injector terminates with it, or a cell
	// that inspects egress; internal/machinetrust). The driver mounts the
	// cell's files into every service and points their variables at them.
	CellTrust bool
	// Canaries are the Run's decoys (claim.acquire canaries), planted only
	// in a Run's workload: CanaryEnvOf and CanaryFileOf. Empty for a setup.
	Canaries []Canary
	// BuildSecrets are the claim's org secrets, name to placeholder (G6,
	// docs/runtime/egress-allowlist.md §16): a driver whose builder trusts
	// the cell CA offers a build the ones it asked for (its compose
	// build.secrets, its Dockerfile's RUN --mount=type=secret,id=<name>) as
	// BuildKit secrets, and no other. Only the placeholder enters the
	// build; the injector swaps it for the value on the secret's hosts. A
	// machine whose builds hold them never becomes a template or a session.
	BuildSecrets map[string]string
	// Coverage is where a Run's instrumented services write V8 coverage
	// (feature exercisedLines). The agent sets it for a Run's claim only,
	// on a driver with a CoverageFlusher, never for a setup, a bake or a
	// pool sandbox. Zero: none.
	Coverage Coverage
	// Output takes the lines a long boot step prints (a build's progress,
	// compose's own messages), so the agent can show a setup as it runs
	// (claim.progress). It is called from the step's goroutine and must
	// return quickly. Nil: nobody listens.
	Output func(line string)
	// SharedImages are the environment's images another cell of the org
	// baked (claim.acquire sharedImages). A driver that shares bakes pulls
	// one by digest for a build whose fingerprint matches and that it holds
	// no image of, and builds as before when the pull fails. Empty for a
	// setup.
	SharedImages []SharedImage
}

// Coverage is a Run's V8 coverage files, in the claim's own directory and
// removed with it: Dir, the directory the services write (writable at
// sandbox.CoverageTarget), and Preload, the file NODE_OPTIONS requires
// (read-only at sandbox.CoveragePreloadTarget). Services are the services
// the agent instrumented by their image (compose.AddNodeCoverage); a driver
// that builds adds the built ones whose image runs Node
// (compose.AddBuiltNodeCoverage) and names them all after the Up
// (CoverageFlusher.CoverageServices). No other service gets the files.
type Coverage struct {
	Dir, Preload string
	Services     []string
}

// Set says the request asks for coverage, on Services or on what the
// driver builds.
func (c Coverage) Set() bool { return c.Dir != "" && c.Preload != "" }

// Emit sends line to the request's Output, when there is one.
func (r UpRequest) Emit(line string) {
	if r.Output != nil {
		r.Output(line)
	}
}

// SandboxRequest is one code sandbox to make (Sandboxer.CreateSandbox,
// Snapshotter.CreateSandboxFromSnapshot): its spec and what its boot must
// honor. The ctx carries cancellation and the trace only.
type SandboxRequest struct {
	Spec MachineSpec
	// CellTrust: the sandbox must trust the cell CA, as UpRequest.CellTrust.
	// A driver whose Capabilities say SandboxCellTrust false refuses it with
	// ErrUnsupported; never asked for a blank pool sandbox.
	CellTrust bool
}

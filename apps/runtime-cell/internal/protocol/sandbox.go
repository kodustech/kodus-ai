package protocol

import "fmt"

// The code sandbox's bounds are SANDBOX_* in libs/runtime/protocol/sandbox.ts
// (constants_gen.go). The schema carries the per-field limits; the guest
// agent applies the rest on top, with the refinement zod's .refine adds
// (sandboxOpError).
const (
	// SandboxExecMaxEnvWire is what an exec's env may hold on the wire to
	// the guest agent: the caller's (SandboxExecMaxEnv, checked by the hub
	// and by the cell agent before it relays) plus the claim's secrets
	// (MaxClaimSecrets), which the cell adds (agent.secretEnvFor).
	SandboxExecMaxEnvWire   = SandboxExecMaxEnv + MaxClaimSecrets
	sandboxDefaultReadBytes = SandboxFileChunkBytes
)

type sandboxFields struct{ required, optional []string }

var sandboxUses = map[SandboxOpKind]sandboxFields{
	SandboxOpKindExec:   {[]string{"command", "timeoutMs"}, []string{"cwd", "env"}},
	SandboxOpKindRead:   {[]string{"path"}, []string{"offset", "length"}},
	SandboxOpKindWrite:  {[]string{"path", "content"}, []string{"mode", "append", "mkdirs"}},
	SandboxOpKindList:   {nil, []string{"path", "depth", "maxEntries"}},
	SandboxOpKindStat:   {nil, []string{"path"}},
	SandboxOpKindRemove: {[]string{"path"}, nil},
}

// present lists the optional fields an op carries.
func (o SandboxOp) present() map[string]bool {
	return map[string]bool{
		"path": o.Path != nil, "command": o.Command != nil, "cwd": o.Cwd != nil, "timeoutMs": o.TimeoutMs != nil,
		"env": o.Env != nil, "offset": o.Offset != nil, "length": o.Length != nil, "content": o.Content != nil,
		"mode": o.Mode != nil, "append": o.Append != nil, "mkdirs": o.Mkdirs != nil, "depth": o.Depth != nil,
		"maxEntries": o.MaxEntries != nil,
	}
}

// CheckSandboxOp mirrors sandboxOpError: an op carries its own fields and
// no other op's. Its env bound is the wire's (SandboxExecMaxEnvWire); the
// caller's own is CheckCallerEnv.
func CheckSandboxOp(o SandboxOp) error {
	use, ok := sandboxUses[o.Op]
	if !ok {
		return fmt.Errorf("op: unknown op %q", o.Op)
	}
	has := o.present()
	allowed := map[string]bool{}
	for _, k := range use.required {
		if !has[k] {
			return fmt.Errorf("op: %s needs %s", o.Op, k)
		}
		allowed[k] = true
	}
	for _, k := range use.optional {
		allowed[k] = true
	}
	for k, v := range has {
		if v && !allowed[k] {
			return fmt.Errorf("op: %s takes no %s", o.Op, k)
		}
	}
	if len(o.Env) > SandboxExecMaxEnvWire {
		return fmt.Errorf("op: exec takes at most %d env entries", SandboxExecMaxEnvWire)
	}
	return nil
}

// CheckCallerEnv is sandboxOpError's env bound: what the hub's caller may
// put in an exec's env, before the cell adds the claim's secrets.
func CheckCallerEnv(o SandboxOp) error {
	if len(o.Env) > SandboxExecMaxEnv {
		return fmt.Errorf("op: exec takes at most %d env entries", SandboxExecMaxEnv)
	}
	return nil
}

// ReadLength is how many bytes a read op asks for.
func (o SandboxOp) ReadLength() int64 {
	if o.Length != nil {
		return *o.Length
	}
	return sandboxDefaultReadBytes
}

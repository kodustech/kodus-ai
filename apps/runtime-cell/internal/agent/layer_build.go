package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/agent/claims"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/driver"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/guest"
	"github.com/kodustech/kodus-ai/apps/runtime-cell/internal/protocol"
)

// Tool layers (docs/runtime/persistent-state.md section 4). A review asks to
// mount layers (sandbox.acquire toolLayers; the driver answers hit or miss per
// layer, claim.ready carries it). A layer builder (sandbox.acquire layerBuild)
// is a sandbox claim the cell drives itself: it runs the API's install plan
// through the guest agent, audits the packages' signatures, seals the egress,
// reads /opt/kcli/<id> out through the driver into the org's store, reports
// toollayer.built or toollayer.failed and ends the claim. No caller gets
// sandbox.op on it, no secret reaches it and no checkout is made in it.

const (
	// layerInstallTimeout is the timeout of an install today (cli-prefix-install.ts).
	layerInstallTimeout = 300 * time.Second
	layerAuditTimeout   = 120 * time.Second
	layerIngestTimeout  = 3 * time.Minute
	// layerBuildTimeout bounds the whole build, the claim's ceiling aside.
	layerBuildTimeout = 10 * time.Minute
	// layerGrace is how much longer than a command's own timeout the cell waits for the guest.
	layerGrace = 60 * time.Second
	// layerHomeRoot is the builder's throwaway HOME, in its in-memory /workspace.
	layerHomeRoot = "/workspace/.kcli"
)

// layerPlanOf is what a sandbox.acquire asks of tool layers: the layers to
// mount, or a build, admitted here (single-flight, per cell and per org, 10
// minutes after a failure). A claim this cell already holds is a rejoin and
// asks nothing new. It nacks what the cell cannot or must not do.
func (a *Agent) layerPlanOf(claimID string, b protocol.SandboxAcquireBody) (claims.LayerPlan, error) {
	if b.LayerBuild == nil && len(b.ToolLayers) == 0 {
		return claims.LayerPlan{}, nil
	}
	tl := a.cfg.Parts.ToolLayers
	if tl == nil {
		return claims.LayerPlan{}, nack("not_supported", "this cell keeps no tool layers")
	}
	if _, held := a.claims.Get(claimID); held {
		return claims.LayerPlan{}, nil
	}
	var plan claims.LayerPlan
	for _, l := range b.ToolLayers {
		plan.Mount = append(plan.Mount, driver.ToolLayerRef{Key: l.Key, ID: l.ID})
	}
	if b.LayerBuild == nil {
		return plan, nil
	}
	lb := b.LayerBuild
	if a.cfg.Egress == nil {
		// Without egress control the builder could not be held to its registry host.
		return claims.LayerPlan{}, nack("egress_unavailable", "this cell has no egress control to hold a layer builder to its registry")
	}
	if tl.ImageDigest() == "" {
		return claims.LayerPlan{}, nack("tool_layers_unavailable", "this cell has no digest for its sandbox image")
	}
	spec := driver.ToolLayerBuild{Key: lb.Key, ID: lb.ID, Installer: string(lb.Installer), Argv: lb.Argv, Binary: lb.Binary, Registry: lb.Registry}
	if err := tl.CheckBuild(spec); err != nil {
		return claims.LayerPlan{}, nack("invalid_body", "layerBuild: %v", err)
	}
	end, err := tl.BeginBuild(b.OrgID, spec.Key)
	var refused *driver.ErrBuildRefused
	if errors.As(err, &refused) {
		return claims.LayerPlan{}, nack("layer_build_refused", "%s", refused.Reason)
	}
	if err != nil {
		return claims.LayerPlan{}, nack("internal", "layer build admission: %v", err)
	}
	plan.Build, plan.EndBuild = &spec, end
	return plan, nil
}

// layerItems is claim.ready toolLayers: one entry per layer the review asked
// for, from what the driver decided. A layer with no decision (the sandbox
// started from a template or a session, which mounts none) is a miss.
func layerItems(c *claims.Claim) []protocol.ClaimReadyBodyToolLayersItem {
	if len(c.Layers.Mount) == 0 {
		return nil
	}
	by := map[string]driver.ToolLayerState{}
	for _, s := range c.LayerStates() {
		by[s.ID] = s
	}
	out := make([]protocol.ClaimReadyBodyToolLayersItem, 0, len(c.Layers.Mount))
	for _, ref := range c.Layers.Mount {
		s, ok := by[ref.ID]
		if !ok {
			s = driver.ToolLayerState{ID: ref.ID, Reason: "not_mounted"}
		}
		it := protocol.ClaimReadyBodyToolLayersItem{ID: s.ID, State: protocol.ClaimReadyBodyToolLayersItemStateMiss}
		if s.Hit {
			it.State = protocol.ClaimReadyBodyToolLayersItemStateHit
			it.BinaryPath, it.Interpreter, it.Digest = strPtr(s.BinaryPath), strPtr(s.Interpreter), strPtr(s.Digest)
		} else {
			it.Reason = strPtr(s.Reason)
			if s.Build {
				t := true
				it.Build = &t
			}
		}
		out = append(out, it)
	}
	return out
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// startLayerBuild runs a builder claim's build in the background, once the
// claim is ready; any other claim is left alone.
func (a *Agent) startLayerBuild(c *claims.Claim, hard time.Time) {
	if c.Layers.Build == nil {
		return
	}
	a.goTracked(func(ctx context.Context) { a.runLayerBuild(ctx, c, hard) })
}

var reasonCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)

// runLayerBuild builds the claim's layer, tells the hub how it went, and ends
// the claim.
func (a *Agent) runLayerBuild(ctx context.Context, c *claims.Claim, hard time.Time) {
	spec := *c.Layers.Build
	start := a.clock.Now()
	bctx, cancel := context.WithTimeout(ctx, layerBuildTimeout)
	defer cancel()
	if d := hard.Sub(start); d > 0 && d < layerBuildTimeout {
		cancel()
		bctx, cancel = context.WithTimeout(ctx, d)
		defer cancel()
	}
	built, reason, err := a.buildLayer(bctx, c, spec)
	ms := a.clock.Now().Sub(start).Milliseconds()
	// A frame the hub reads as the result; the claim ends either way. Never the
	// installer's output: a short code only.
	if reason != "" {
		if !reasonCode.MatchString(reason) {
			reason = "build_failed"
		}
		c.Log.Warn("toollayer.failed", "id", spec.ID, "reason", reason, "ms", ms, "err", err)
		a.m.toolLayerBuilds.Inc("failed")
		c.Layers.EndBuild(true)
		_ = a.deliver(ctx, c, "toollayer.failed", &protocol.ToollayerFailedBody{Key: spec.Key, ID: spec.ID, Reason: reason})
	} else {
		c.Log.Info("toollayer.built", "id", spec.ID, "digest", built.Digest, "bytes", built.Bytes, "unsigned", built.Unsigned, "ms", ms)
		a.m.toolLayerBuilds.Inc("built")
		c.Layers.EndBuild(false)
		body := &protocol.ToollayerBuiltBody{Key: spec.Key, ID: spec.ID, Digest: built.Digest, Bytes: built.Bytes}
		if built.Unsigned > 0 {
			n := int64(built.Unsigned)
			body.Unsigned = &n
		}
		_ = a.deliver(ctx, c, "toollayer.built", body)
	}
	a.cleanup(ctx, c, "layer_build_done")
}

// buildLayer is the builder's four steps: install, audit, seal, copy out. It
// returns a reason code when one fails.
func (a *Agent) buildLayer(ctx context.Context, c *claims.Claim, spec driver.ToolLayerBuild) (driver.ToolLayerBuilt, string, error) {
	tl := a.cfg.Parts.ToolLayers
	cl := a.guests.get(c.ID)
	if cl == nil {
		return driver.ToolLayerBuilt{}, "no_guest", errors.New("no guest agent")
	}
	if reason, err := a.layerExec(ctx, cl, installScript(spec), layerInstallTimeout); reason != "" {
		return driver.ToolLayerBuilt{}, reason, err
	}
	in := driver.ToolLayerIntegrity{LockfileIntegrity: true} // npm and pnpm check each tarball's sha512 against the registry's answer
	if spec.Installer == "npm" {
		out, reason, err := a.layerOutput(ctx, cl, auditScript(spec), layerAuditTimeout, true)
		if reason != "" {
			return driver.ToolLayerBuilt{}, "audit_" + reason, err
		}
		if in, err = parseAudit(out, in); err != nil {
			return driver.ToolLayerBuilt{}, "signature_audit_failed", err
		}
		if in.SignaturesInvalid > 0 {
			// U5: a package whose signature does not verify refuses the layer; unsigned ones are allowed and counted.
			return driver.ToolLayerBuilt{}, "invalid_signature", fmt.Errorf("%d packages", in.SignaturesInvalid)
		}
	}
	// Whatever a lifecycle script left running can reach nothing from here on.
	if err := a.applySeal(ctx, c); err != nil {
		return driver.ToolLayerBuilt{}, "seal_failed", err
	}
	ictx, cancel := context.WithTimeout(ctx, layerIngestTimeout)
	defer cancel()
	built, err := tl.Ingest(ictx, c.Acquire.OrgID, c.Machines().Workload, spec, in)
	if err != nil {
		var te *driver.ToolLayerError
		if errors.As(err, &te) {
			return driver.ToolLayerBuilt{}, te.Reason, err
		}
		return driver.ToolLayerBuilt{}, "ingest_failed", err
	}
	return built, "", nil
}

// layerExec runs the install in the guest and says why it failed.
func (a *Agent) layerExec(ctx context.Context, cl *guest.Client, script string, limit time.Duration) (string, error) {
	_, reason, err := a.layerOutput(ctx, cl, script, limit, false)
	if reason == "" {
		return "", nil
	}
	return "install_" + reason, err
}

// layerOutput runs script in the guest with the build's limits and returns
// what it printed; the reason is failed (no answer), timeout or exit (a
// non-zero exit, unless the command's exit code means nothing: npm audit
// signatures exits 1 for packages it found unsigned, and its JSON decides).
func (a *Agent) layerOutput(ctx context.Context, cl *guest.Client, script string, limit time.Duration, anyExit bool) (string, string, error) {
	ms := (limit + layerGrace).Milliseconds()
	res, err := cl.Do(ctx, guest.NewID(), protocol.SandboxOp{Op: protocol.SandboxOpKindExec, Command: &script, TimeoutMs: &ms})
	switch {
	case err != nil:
		return "", "failed", err
	case res.Exec == nil:
		return "", "failed", errors.New("the guest answered no exec result")
	case res.Exec.TimedOut:
		return "", "timeout", nil
	case res.Exec.ExitCode != 0 && !anyExit:
		return "", "exit", fmt.Errorf("exit %d", res.Exec.ExitCode)
	}
	return res.Exec.Stdout, "", nil
}

// sq quotes a word for the guest's /bin/sh. Everything quoted is built from
// values the validators accepted, never from the install's own output.
func sq(s string) string { return `'` + strings.ReplaceAll(s, `'`, `'\''`) + `'` }

// layerEnv is the install's whole environment (env -i): npm and pnpm write
// into the layer's prefix, and their cache and HOME stay in a throwaway
// directory of the builder's workspace.
func layerEnv(spec driver.ToolLayerBuild) []string {
	prefix := path.Join(driver.ToolLayerMountDir, spec.ID)
	home := path.Join(layerHomeRoot, spec.ID)
	return []string{
		"HOME=" + home,
		"PATH=" + prefix + "/.local/bin:" + prefix + "/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
		"NPM_CONFIG_PREFIX=" + prefix + "/.local",
		"NPM_CONFIG_CACHE=" + home + "/.cache/npm",
		"PNPM_HOME=" + prefix + "/.local/bin",
		// The one registry host the builder may reach is the one it installs from.
		"NPM_CONFIG_REGISTRY=https://" + spec.Registry + "/",
	}
}

func quoted(words []string) string {
	q := make([]string, len(words))
	for i, w := range words {
		q[i] = sq(w)
	}
	return strings.Join(q, " ")
}

// installScript runs the validated argv in the layer's prefix as the sandbox
// user, with today's install timeout.
func installScript(spec driver.ToolLayerBuild) string {
	prefix := path.Join(driver.ToolLayerMountDir, spec.ID)
	home := path.Join(layerHomeRoot, spec.ID)
	return strings.Join([]string{
		"set -eu",
		"mkdir -p " + sq(prefix+"/.local/bin") + " " + sq(home+"/.cache/npm"),
		"cd " + sq(prefix),
		fmt.Sprintf("/usr/bin/env -i %s /usr/bin/timeout -k 5 %d %s >&2", quoted(layerEnv(spec)), int(layerInstallTimeout/time.Second), quoted(spec.Argv)),
	}, "\n")
}

// auditScript is npm audit signatures over the packages the install left:
// the global tree when the install was global (npm audit refuses -g itself).
func auditScript(spec driver.ToolLayerBuild) string {
	prefix := path.Join(driver.ToolLayerMountDir, spec.ID)
	project := prefix
	for _, a := range spec.Argv {
		if a == "-g" || a == "--global" {
			project = prefix + "/.local/lib"
		}
	}
	return strings.Join([]string{
		"set -u",
		"cd " + sq(prefix),
		fmt.Sprintf("/usr/bin/env -i %s /usr/bin/timeout -k 5 %d npm audit signatures --json --prefix %s 2>&1", quoted(layerEnv(spec)), int(layerAuditTimeout/time.Second), sq(project)),
		"true",
	}, "\n")
}

// parseAudit reads npm audit signatures --json ({"invalid": [...], "missing":
// [...]}), with its stderr merged into the same stream. An answer it cannot read is an error: the
// layer is not kept on a check that did not run. "No installed dependencies"
// means there was nothing to audit.
func parseAudit(out string, base driver.ToolLayerIntegrity) (driver.ToolLayerIntegrity, error) {
	text := strings.TrimSpace(out)
	var doc struct {
		Invalid []json.RawMessage `json:"invalid"`
		Missing []json.RawMessage `json:"missing"`
	}
	if i := strings.IndexByte(text, '{'); i >= 0 && json.Unmarshal([]byte(text[i:]), &doc) == nil {
		base.SignaturesInvalid, base.SignaturesMissing = len(doc.Invalid), len(doc.Missing)
		return base, nil
	}
	if strings.Contains(text, "found no installed dependencies to audit") {
		return base, nil
	}
	return base, errors.New("npm audit signatures answered nothing readable")
}

package driver

import (
	"context"
	"sort"
)

// Canary is one of a Run's decoys (claim.acquire canaries, ADR-043): a
// value nothing legitimate reads out of the workload, so seeing it in a
// prompt, the egress, the evidence or the comment means code sent it out.
// It is never a real secret, and still never a label, a tag, a log field
// or anything the cell sends back: the worker alone checks for it.
type Canary struct {
	Slot, Value string
}

// The places a cell plants the decoys in a workload: the config slot as an
// env var of every service, the npmrc slot as a credentials file. Names a
// legitimate tool never consumes (npm never reads DecoyFile), so a decoy
// changes nothing the app does.
const (
	CanaryEnv        = "KODUS_DEPLOY_KEY"
	CanarySlotConfig = "config"
	CanarySlotNpmrc  = "npmrc"
)

// CanaryEnvOf is the env a workload's services get: the config slot's
// value under CanaryEnv; nil without one.
func CanaryEnvOf(cs []Canary) map[string]string {
	for _, c := range cs {
		if c.Slot == CanarySlotConfig {
			return map[string]string{CanaryEnv: c.Value}
		}
	}
	return nil
}

// CanaryFileOf is the credentials file the npmrc slot plants, in .npmrc
// form; "" without one.
func CanaryFileOf(cs []Canary) string {
	for _, c := range cs {
		if c.Slot == CanarySlotNpmrc {
			return "//registry.npmjs.org/:_authToken=" + c.Value + "\n"
		}
	}
	return ""
}

type canaryKey struct{}

// WithCanaries carries a claim's decoys to the driver's boot (Up), as
// WithOutput carries its sink: per call, never kept in the driver's state.
func WithCanaries(ctx context.Context, cs []Canary) context.Context {
	if len(cs) == 0 {
		return ctx
	}
	out := append([]Canary(nil), cs...)
	sort.Slice(out, func(i, j int) bool { return out[i].Slot < out[j].Slot })
	return context.WithValue(ctx, canaryKey{}, out)
}

// CanariesFrom is what WithCanaries set, or nil.
func CanariesFrom(ctx context.Context) []Canary {
	cs, _ := ctx.Value(canaryKey{}).([]Canary)
	return cs
}

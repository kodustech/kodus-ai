import { createHmac } from 'node:crypto';
import type { Probe } from '@libs/runtime/probe';
import type { ClaimRunIdentity } from '@libs/runtime/protocol';

// A Run's drawn identifiers (spec §4 Replay, S-36, ADR-039): the hostname of
// the workload's services, the seed's user name and the seed's e-mail domain.
// Drawn per Run from the Run's own secret, so a PR cannot hardcode the values
// its probes will use, and the same for both sides, so base and PR stay
// comparable. Derived, never stored: every retry and every DBOS replay of the
// workflow gets the same values without a step of its own.

/**
 * The Run's identifiers: an HMAC of the runId under the Run's token. The
 * runId is public (it is in the check's link); the token never leaves the
 * control plane, so nobody outside it can compute them before the Run.
 */
export function runIdentityOf(run: { runId: string; runToken: string }): ClaimRunIdentity {
    const hex = createHmac('sha256', run.runToken).update(`kodus-runtime-identity\0${run.runId}`).digest('hex');
    return { hostname: `kr-${hex.slice(0, 8)}`, user: `u${hex.slice(8, 18)}`, domain: `d${hex.slice(18, 28)}.test` };
}

/**
 * How a planned probe names them: the replay puts the Run's values in its
 * spec before it is played, so a reused plan stays right for the next Run.
 */
export const RUN_IDENTITY_TOKENS = { hostname: '{{run.hostname}}', user: '{{run.user}}', domain: '{{run.domain}}' } as const;

/**
 * The probe with the Run's values in place of RUN_IDENTITY_TOKENS in its
 * spec; unchanged without an identity. The replay passes the base claim's
 * (Claim.identity), so every round of both sides plays the same probe; a
 * claim from a cell without runIdentity has none, and its tokens stay.
 */
export function withRunIdentity(probe: Probe, identity: ClaimRunIdentity | undefined): Probe {
    if (!identity) return probe;
    const swap = (s: string) =>
        s.split(RUN_IDENTITY_TOKENS.hostname).join(identity.hostname).split(RUN_IDENTITY_TOKENS.user).join(identity.user).split(RUN_IDENTITY_TOKENS.domain).join(identity.domain);
    const deep = (v: unknown): unknown => (typeof v === 'string' ? swap(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
    return { ...probe, spec: deep(probe.spec) as Probe['spec'] };
}

/**
 * How the two sides' claims differ in the drawn identity their cells set
 * (Claim.identity): `base_unset` or `pr_unset`, that side's cell did not set
 * it (no runIdentity feature) while the other did; `differ`, both set one and
 * they are not the same. Undefined: both set the same, or neither did (both
 * workloads kept the recipe's values and the probes keep their tokens on both).
 */
export type RunIdentityMismatch = 'base_unset' | 'pr_unset' | 'differ';

export function runIdentityMismatchOf(base: { identity?: ClaimRunIdentity }, pr: { identity?: ClaimRunIdentity }): RunIdentityMismatch | undefined {
    const b = base.identity;
    const p = pr.identity;
    if (!b && !p) return undefined;
    if (!b) return 'base_unset';
    if (!p) return 'pr_unset';
    return b.hostname === p.hostname && b.user === p.user && b.domain === p.domain ? undefined : 'differ';
}

/** Whether a probe names a drawn identifier through a {{run.*}} token anywhere in its spec. */
export function usesRunIdentity(probe: Probe): boolean {
    const spec = JSON.stringify(probe.spec);
    return Object.values(RUN_IDENTITY_TOKENS).some((token) => spec.includes(token));
}

export const IDENTITY_MISMATCH_REASON = 'the probe uses the Run\'s drawn identity, and the two sides did not run with the same one';

/**
 * A probe that sends a drawn identifier, on a Run whose sides do not share
 * one, was sent the base's values on a PR side that does not hold them (or
 * the reverse): its comparison proves nothing, so it is inconclusive, never
 * a finding or a not_reproduced (the gate fails closed). Any other probe sent
 * the same request to both sides and keeps its decision.
 */
export function skewedByIdentity<D extends { verdict: string; reason: string; findingKind?: unknown; differingFields?: string[]; intendedChange?: unknown }>(
    decision: D,
    probe: Probe,
    mismatch: RunIdentityMismatch | undefined,
): D {
    if (!mismatch || !usesRunIdentity(probe)) return decision;
    const { findingKind: _kind, intendedChange: _change, ...rest } = decision;
    return { ...rest, verdict: 'inconclusive', reason: IDENTITY_MISMATCH_REASON, differingFields: [] } as unknown as D;
}

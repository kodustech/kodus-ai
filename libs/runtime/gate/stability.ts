// The versioned stability history of ADR-050 (§8 runtime_stability): what
// earlier Runs saw vary on the base of the same probe shape, in the same
// environment, read back as the policy the gate starts this probe with.
// Pure: the store and its 90-day retention live in apps/runtime; the gate
// only ever receives the policy (decideProbe stays a function of Steps, the
// normalizer version and the policy snapshot recorded on the Run).

import { createHash } from 'node:crypto';

import type { ProbeSpec } from '@libs/runtime/probe/probe.schema';
import type { Verdict } from '@libs/runtime/contracts/enums';
import { redactPatterns } from '@libs/runtime/redaction/redaction';

import { GateStep, healthyStep, isMeasureField } from './gate';

/**
 * The version of the field extraction the gate compares (probe-fields.ts,
 * html-fields.ts): a field name means the same thing only under the same
 * version. Bump it when a field is renamed, split or normalized differently;
 * history written under another version is then ignored, never reinterpreted.
 */
export const NORMALIZER_VERSION = 'fields/1';

/** The version of the policy below; part of its snapshot. */
export const STABILITY_POLICY_VERSION = 1;

/** Rounds the decision table starts with on the base (two) and its ceiling per side (ADR-050). */
export const DEFAULT_BASE_ROUNDS = 2;
export const DEFAULT_MAX_ROUNDS_PER_SIDE = 4;
export const DEFAULT_MAX_MASKED_FIELDS = 5;

/** How many history fields a policy carries: past the masked-field ceiling the probe is inconclusive anyway. */
export const MAX_KNOWN_UNSTABLE_FIELDS = 32;

/** How long a probe's history is kept, by environment (§8). */
export const STABILITY_RETENTION_DAYS = 90;

/** One earlier Run's outcome for a probe shape, as the store returns it. */
export interface StabilityRecord {
    normalizerVersion: string;
    /** Fields that varied between that Run's healthy base rounds (baseUnstableFields). */
    unstableFields: string[];
    verdict: Verdict;
}

/** What the gate and the replay start a probe with; `snapshot` is what the verdict records. */
export interface StabilityPolicy {
    baseRounds: number;
    maxRoundsPerSide: number;
    maxMaskedFields: number;
    knownUnstableFields: string[];
    /** Records of this normalizer version the policy was built from. */
    historyRuns: number;
    /** The policy as one stable string, recorded on every verdict decided with it (ProbeVerdict.stabilityPolicy). */
    snapshot: string;
}

/**
 * The policy for a probe from its history. History only ever makes the gate
 * more careful, never less: a probe whose base varied, or that ended
 * inconclusive, starts with one more base round (so the oscillation shows in
 * this Run too) and its known fields masked; a decisive one among them, or
 * more than the ceiling, makes it inconclusive in decideProbe. With no history
 * it is exactly the table's default.
 */
export function stabilityPolicyFor(history: StabilityRecord[]): StabilityPolicy {
    const usable = history.filter((r) => r.normalizerVersion === NORMALIZER_VERSION);
    const known = [...new Set(usable.flatMap((r) => r.unstableFields))].sort().slice(0, MAX_KNOWN_UNSTABLE_FIELDS);
    const unstable = known.length > 0 || usable.some((r) => r.verdict === 'inconclusive');
    const policy = {
        v: STABILITY_POLICY_VERSION,
        baseRounds: unstable ? DEFAULT_BASE_ROUNDS + 1 : DEFAULT_BASE_ROUNDS,
        maxRoundsPerSide: DEFAULT_MAX_ROUNDS_PER_SIDE,
        maxMaskedFields: DEFAULT_MAX_MASKED_FIELDS,
        knownUnstableFields: known,
        historyRuns: usable.length,
    };
    const { v: _v, ...rest } = policy;
    return { ...rest, snapshot: JSON.stringify(policy) };
}

/**
 * The fields that varied between this Run's healthy observer base rounds: the
 * only thing a Run writes to the history. The PR side never writes it, so a PR
 * cannot poison the history to mask its own change (S-36).
 */
export function baseUnstableFields(steps: GateStep[]): string[] {
    const base = steps.filter((s) => s.side === 'base' && s.executor === 'observer' && healthyStep(s));
    if (base.length < 2) return [];
    const fields = new Set(base.flatMap((s) => Object.keys(s.fields)));
    return [...fields].filter((f) => !isMeasureField(f) && new Set(base.map((s) => s.fields[f])).size > 1).sort();
}

/** Path without query or fragment, secrets redacted: the key is stored. */
const routeOf = (path: string) => redactPatterns(path.split(/[?#]/, 1)[0] || '/').text;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/**
 * The probe shape history is kept by, from its typed spec only: `http GET
 * /orders` (an LLM writes a new body each Run, the route stays), `sql db
 * <hash of the query>`, `browser /login <hash of the steps>`. A shell probe
 * never decides and has none. Never a value the probe sent in clear.
 */
export function probeKeyOf(spec: ProbeSpec): string | undefined {
    switch (spec.kind) {
        case 'http':
            return `http ${spec.method} ${routeOf(spec.path)}`;
        case 'sql':
            return `sql ${spec.target.service} ${digest(spec.query)}`;
        case 'browser': {
            const first = spec.steps.find((s): s is { goto: string } => 'goto' in s);
            return `browser ${first ? routeOf(first.goto) : '-'} ${digest(spec.steps)}`;
        }
        default:
            return undefined;
    }
}

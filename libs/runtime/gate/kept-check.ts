import type { FindingIntent, Verdict } from '@libs/runtime/contracts/enums';
import type { KeptCheckOutcomeKind, KeptCheckStaleReason } from '@libs/runtime/contracts/kept-check';

import { type GateStep, healthyStep } from './gate';

// A kept check's outcome (docs/runtime/kept-checks.md §5). Pure: it reads the
// observer steps the gate read and the expectation main had when the check was
// kept. It never turns an unknown case into `passed`.

const ABSENT = new Set(['404', '405']);

/**
 * Whether main no longer has what the kept check guarded, from main's healthy
 * observer rounds only: every one answered 404 or 405 where main answered
 * something else when it was kept (`route_gone`), or every one fails the kept
 * expectation (`baseline_changed`). Undefined when main still holds it, holds it
 * in some rounds only (the gate decides those), or gave no healthy round.
 */
export function keptCheckStaleness(steps: GateStep[], kept: { keptStatus?: number }): KeptCheckStaleReason | undefined {
    const base = steps.filter((s) => s.side === 'base' && s.executor === 'observer' && healthyStep(s));
    if (base.length === 0) return undefined;
    const keptAbsent = kept.keptStatus !== undefined && ABSENT.has(String(kept.keptStatus));
    if (kept.keptStatus !== undefined && !keptAbsent && base.every((s) => ABSENT.has(s.fields.status ?? ''))) return 'route_gone';
    if (base.every((s) => s.expectedHolds === false)) return 'baseline_changed';
    return undefined;
}

/** The outcome of a played kept check from its final verdict (after intent) and its staleness. */
export function keptCheckOutcomeOf(v: { verdict: Verdict; intent?: FindingIntent }, stale?: KeptCheckStaleReason): KeptCheckOutcomeKind {
    if (stale) return 'stale';
    if (v.verdict === 'finding') return v.intent === 'intended' ? 'intended' : 'failed';
    if (v.verdict === 'not_reproduced') return 'passed';
    return 'inconclusive';
}

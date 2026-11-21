import { BLOCKER_KINDS, type BlockerKind } from '@libs/runtime/contracts/enums';

import type { EnvironmentHealth } from './environment-runtime';

/** How far back the health reads boots: the week the setup record keeps (SETUP_BOOTS_WINDOW_MS). */
export const HEALTH_WINDOW_MS = 7 * 24 * 3_600_000;

/**
 * What the health is computed from: the environment's setup record as the
 * runtime-worker keeps it (EnvironmentSetupRecord fits it), or a fake's own
 * history. Nothing here asks a cell or a cloud.
 */
export interface EnvironmentHealthInput {
    environmentId: string;
    /** The last setup's state; absent: the environment was never set up. */
    state?: 'setting_up' | 'active' | 'blocked';
    imageId?: string;
    cellId?: string;
    /** The setup boots kept (each ended ready or failed, with the failure's signature). */
    boots?: ReadonlyArray<{ at: string; outcome: 'ready' | 'failed'; ms: number; signature?: string }>;
    /** The blockers the last setup left open. */
    blockers?: ReadonlyArray<{ kind: string; signature: string; at: string }>;
}

const KINDS = new Set<string>(BLOCKER_KINDS);
const kindOf = (k: string | undefined): BlockerKind => (k && KINDS.has(k) ? (k as BlockerKind) : 'unknown');

/** The median, nearest rank (as the Environment page's percentile). */
function median(values: number[]): number | undefined {
    if (!values.length) return undefined;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(1, Math.ceil(sorted.length / 2)) - 1];
}

/**
 * EnvironmentHealth (docs §5): the week's boots (rate, median time to ready)
 * and the blockers grouped by signature. A blocker the last setup left open
 * gives the group its kind; each failed boot of the week with that signature
 * counts once. A group with no open blocker reads kind unknown (a boot keeps
 * only the signature).
 */
export function environmentHealthOf(input: EnvironmentHealthInput, now: Date): EnvironmentHealth {
    const since = now.getTime() - HEALTH_WINDOW_MS;
    const week = (input.boots ?? []).filter((b) => Date.parse(b.at) >= since);
    const ready = week.filter((b) => b.outcome === 'ready').map((b) => b.ms);
    const groups = new Map<string, { signature: string; kind: BlockerKind; count: number; lastAt: string }>();
    const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);
    for (const b of input.blockers ?? []) {
        groups.set(b.signature, { signature: b.signature, kind: kindOf(b.kind), count: 0, lastAt: b.at });
    }
    for (const b of week) {
        if (b.outcome !== 'failed' || !b.signature) continue;
        const g = groups.get(b.signature);
        if (g) {
            g.count += 1;
            g.lastAt = later(g.lastAt, b.at);
        } else groups.set(b.signature, { signature: b.signature, kind: 'unknown', count: 1, lastAt: b.at });
    }
    const blockers = [...groups.values()].map((g) => ({ ...g, count: Math.max(1, g.count) })).sort((a, b) => b.count - a.count || Date.parse(b.lastAt) - Date.parse(a.lastAt));
    const p50 = median(ready);
    return {
        environmentId: input.environmentId,
        state: input.state ?? 'not_set_up',
        boots7d: week.length,
        ...(week.length ? { bootRate7d: ready.length / week.length } : {}),
        ...(p50 !== undefined ? { readyP50Ms: p50 } : {}),
        ...(input.imageId ? { imageId: input.imageId } : {}),
        ...(input.cellId ? { cellId: input.cellId } : {}),
        blockers,
    };
}

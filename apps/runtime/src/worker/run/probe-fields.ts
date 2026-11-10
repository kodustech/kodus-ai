import { createHash } from 'crypto';

import type { GateStep } from '@libs/runtime/gate';
import type { Probe, ProbeResult } from '@libs/runtime/probe';
import type { EnvError, ProbeOutcome } from '@libs/runtime/environment';
import { httpExpectedHolds, type ProbeAssertions } from '@libs/runtime/contracts/probe-assertions';

// Normalizes an observer result into the compared fields of the gate: the
// fields the probe asked for in `compare`, plus a floor per kind the agent
// cannot drop (an HTTP probe always compares status and body, a SQL probe
// its row count), so a narrow `compare` cannot hide a regression.

const COMPARE_FLOOR: Partial<Record<Probe['spec']['kind'], Probe['compare']>> = {
    http: ['status', 'json'],
    sql: ['db_count'],
    // A browser probe always compares its closed outcomes (ADR-071): each
    // step's pass or fail and what it read, and the pixel diffs.
    browser: ['pixels'],
};

/**
 * Share of a screenshot's pixels that may change (beyond the cell's
 * per-channel tolerance) before it reads as a different screen: 0.1 %, a
 * few words of text on a 1280x720 page.
 */
export const PIXEL_CHANGE_THRESHOLD = 0.001;

/** A browser step's outcome as one compared token: `ok`, or why it failed (`fail:mismatch`). */
const stepToken = (s: NonNullable<NonNullable<ProbeResult['browser']>['steps']>[number]) => (s.ok ? 'ok' : `fail:${s.error ?? 'error'}`);

/** What a probe really compares: what it asked for plus the floor of its kind. */
export function effectiveCompare(probe: Probe): Probe['compare'] {
    return [...new Set([...(COMPARE_FLOOR[probe.spec.kind] ?? []), ...probe.compare])];
}

function flatten(value: unknown, prefix: string, out: Record<string, string>, depth = 0) {
    if (depth > 8) return;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        for (const k of Object.keys(value as object).sort()) flatten((value as any)[k], `${prefix}.${k}`, out, depth + 1);
        return;
    }
    out[prefix] = JSON.stringify(value);
}

/**
 * The browser probe's closed outcomes as fields (ADR-071): `steps`, every
 * step's outcome in order (decisive: the verdict rests on it); `step.N.value`,
 * what an expectText or getAttribute step read; and with `pixels`,
 * `pixels.N` for each screenshot step: whether it changed from main's
 * baseline round over PIXEL_CHANGE_THRESHOLD. The baseline round itself is
 * `same` by definition. A screenshot the cell did not measure has no field;
 * the gate then sets pixels aside (gate.ts isMeasureField).
 */
function browserFields(probe: Probe, result: ProbeResult, fields: Record<string, string>, pixels: boolean, baselineRound: boolean) {
    const steps = result.browser?.steps;
    if (!steps?.length) return;
    fields.steps = steps.map(stepToken).join(',');
    for (const s of steps) {
        if ((s.kind === 'expectText' || s.kind === 'getAttribute') && s.value !== undefined) fields[`step.${s.index}.value`] = s.value;
    }
    if (!pixels || probe.spec.kind !== 'browser') return;
    const spec = probe.spec;
    for (const s of steps) {
        if (s.kind !== 'screenshot' || !('screenshot' in (spec.steps[s.index] ?? {})) || s.screenshot === undefined) continue;
        if (baselineRound) {
            fields[`pixels.${s.index}`] = 'same';
            continue;
        }
        const d = result.browser?.pixels?.find((p) => p.screenshot === s.screenshot);
        if (d) fields[`pixels.${s.index}`] = d.sizeDiffers || d.ratio > PIXEL_CHANGE_THRESHOLD ? 'changed' : 'same';
    }
}

export function normalizeFields(probe: Probe, result: ProbeResult, opts: { baselineRound?: boolean } = {}): Record<string, string> {
    const fields: Record<string, string> = {};
    const compare = effectiveCompare(probe);
    if (probe.spec.kind === 'browser') browserFields(probe, result, fields, compare.includes('pixels'), !!opts.baselineRound);
    for (const c of compare) {
        if (c === 'status' && result.http) fields.status = String(result.http.status);
        if (c === 'json' && result.http) {
            try {
                flatten(JSON.parse(result.http.body), 'json', fields);
            } catch {
                // Not JSON: the body still counts, by its digest (volatile text is masked by the base rounds).
                fields.json = 'not_json';
                fields['body.sha256'] = createHash('sha256').update(result.http.body).digest('hex');
            }
        }
        if (c === 'lines' && result.http) fields.lines = String(result.http.body.split('\n').length);
        if (c === 'db_count' && result.sql) fields.db_count = String(result.sql.rows.length);
        if (c === 'dom' && result.browser?.dom !== undefined) fields.dom = result.browser.dom;
        if (c === 'network' && result.browser) fields.network = JSON.stringify(result.browser.network.map((n) => `${n.method} ${n.url} ${n.status}`));
        if (c === 'console' && result.browser) fields.console = String(result.browser.console.filter((m) => m.level === 'error').length);
    }
    return fields;
}

/** HTTP assertions are explicit; legacy prose that cannot be demonstrated stays unknown. */
export function expectedHolds(probe: Probe, result: ProbeResult, assertions?: ProbeAssertions): boolean | undefined {
    if (probe.spec.kind === 'http') return httpExpectedHolds(probe, result, assertions);
    // A browser probe's expectation is its steps: every one passed.
    if (probe.spec.kind === 'browser' && result.browser?.steps?.length) return result.browser.steps.every((s) => s.ok);
    const expected = probe.expected.trim();
    if (/^\d{3}$/.test(expected)) return result.http ? String(result.http.status) === expected : false;
    const body = result.http?.body ?? result.browser?.dom ?? JSON.stringify(result.sql?.rows ?? '');
    return body.includes(expected);
}

export function toGateStep(args: {
    probe: Probe;
    assertions?: ProbeAssertions;
    side: 'base' | 'pr';
    round: number;
    stepId: string;
    result: ProbeOutcome | EnvError;
    /** This round is the browser probe's baseline (the screenshots every other round is diffed against). */
    baselineRound?: boolean;
}): GateStep {
    const { probe, side, round, stepId, result } = args;
    if ('code' in result) {
        return {
            stepId,
            probeId: probe.id,
            side,
            round,
            executor: 'observer',
            imageId: '',
            transport: result.code === 'transport_lost' || result.code === 'cell_unavailable' ? 'lost' : 'ok',
            vmHealth: result.code === 'vm_unhealthy' ? result.vmHealth : 'ok',
            timedOut: result.code === 'timeout',
            fields: {},
            expectedHolds: false,
        };
    }
    return {
        stepId,
        probeId: probe.id,
        side,
        round,
        executor: result.executor,
        imageId: result.imageId,
        transport: result.transport,
        // From step.result: an OOM or crash on the PR side is what pr_destabilizes_machine reads.
        vmHealth: result.vmHealth ?? 'ok',
        timedOut: false,
        fields: normalizeFields(probe, result, { baselineRound: args.baselineRound }),
        expectedHolds: expectedHolds(probe, result, args.assertions),
        requests: (result.requests ?? []).map((r) => ({ method: r.method, route: r.route })),
    };
}

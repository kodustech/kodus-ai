import type { GateStep, StatedIntentCheck } from '@libs/runtime/gate';
import { expectedHolds, normalizeFields } from '@libs/runtime/gate/probe-fields';
import type { EnvError, ProbeOutcome } from '@libs/runtime/environment';
import type { Probe } from '@libs/runtime/probe';
import type { ProbeAssertions } from '@libs/runtime/contracts/probe-assertions';

// The gate step of one observer round: its result's compared fields
// (gate/probe-fields.ts) and whether the probe's expectation held, or the
// environment error that stood in for a result.

export function toGateStep(args: {
    probe: Probe;
    assertions?: ProbeAssertions;
    /** An intent probe's quoted assertions: its expectation (gate/stated-intent.ts). */
    intent?: readonly StatedIntentCheck[];
    side: 'base' | 'pr';
    round: number;
    stepId: string;
    result: ProbeOutcome | EnvError;
    /** This round is the browser probe's baseline (the screenshots every other round is diffed against). */
    baselineRound?: boolean;
    /** What the ready check answered right before the probe (GateStep.readyStatus). */
    readyStatus?: number;
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
            ...(round === 1 ? { warmup: true } : {}),
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
        expectedHolds: expectedHolds(probe, result, args.assertions, args.intent),
        // Round 1 follows the side's first reset: the gate may set it aside when only it differs (GateStep.warmup).
        ...(round === 1 ? { warmup: true } : {}),
        requests: (result.requests ?? []).map((r) => ({ method: r.method, route: r.route })),
        ...(args.readyStatus !== undefined ? { readyStatus: args.readyStatus } : {}),
    };
}

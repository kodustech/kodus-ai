import type { EnvError, ProbeOutcome } from '@libs/runtime/environment';
import { decideProbe } from '@libs/runtime/gate';
import type { Probe } from '@libs/runtime/probe';

import { toGateStep } from './probe-fields';

const probe: Probe = {
    id: 'control-plane-loss', origin: 'agent', purpose: 'the orders route answers', expected: '200', compare: ['status'],
    spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'GET', path: '/orders', timeoutMs: 1_000 },
};
const healthy: ProbeOutcome = {
    stepId: 'synthetic', executor: 'observer', imageId: 'img', transport: 'ok', vmHealth: 'ok', durationMs: 1,
    http: { status: 200, headers: {}, body: '{}' }, requests: [],
};
const step = (side: 'base' | 'pr', round: number, result: ProbeOutcome | EnvError) =>
    toGateStep({ probe, side, round, stepId: `${side}-${round}`, result });
const base = () => [step('base', 1, healthy), step('base', 2, healthy)];
const opts = { pinnedImageId: 'img', maxRoundsPerSide: 4 };

describe('cell transport availability is not a VM-health fact', () => {
    it('maps cell_unavailable to a lost transport without inventing unhealthy VM evidence', () => {
        expect(step('pr', 1, { code: 'cell_unavailable', cellId: 'unknown' })).toMatchObject({ transport: 'lost', vmHealth: 'ok', imageId: '' });
    });

    it('asks for another round after repeated cell unavailability instead of blaming the PR', () => {
        const pr = [1, 2].map((round) => step('pr', round, { code: 'cell_unavailable', cellId: 'unknown' }));
        expect(decideProbe([...base(), ...pr], opts)).toMatchObject({ kind: 'more_rounds', pr: 1 });
    });

    it('ends inconclusive when the cell stays unavailable through the round ceiling', () => {
        const pr = [1, 2, 3, 4].map((round) => step('pr', round, { code: 'cell_unavailable', cellId: 'unknown' }));
        const decision = decideProbe([...base(), ...pr], opts);
        expect(decision).toMatchObject({ kind: 'verdict', verdict: 'inconclusive' });
        expect(decision).not.toHaveProperty('findingKind');
    });

    it.each(['oom', 'crashed', 'unreachable'] as const)('preserves explicit vm_unhealthy %s evidence', (vmHealth) => {
        const pr = [1, 2].map((round) => step('pr', round, { code: 'vm_unhealthy', stepId: `pr-${round}`, vmHealth }));
        expect(decideProbe([...base(), ...pr], opts)).toMatchObject({ verdict: 'finding', findingKind: 'pr_destabilizes_machine' });
    });

    it('preserves an observed OOM even when its probe transport was lost', () => {
        const pr = [1, 2].map((round) => step('pr', round, { ...healthy, transport: 'lost', vmHealth: 'oom' }));
        expect(decideProbe([...base(), ...pr], opts)).toMatchObject({ verdict: 'finding', findingKind: 'pr_destabilizes_machine' });
    });
});

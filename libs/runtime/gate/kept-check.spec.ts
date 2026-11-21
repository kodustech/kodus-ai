import type { GateStep } from './gate';
import { keptCheckOutcomeOf, keptCheckStaleness } from './kept-check';

let n = 0;
const step = (side: 'base' | 'pr', fields: Record<string, string>, over: Partial<GateStep> = {}): GateStep => ({
    stepId: `s${++n}`,
    probeId: 'kept:1',
    side,
    round: 1,
    executor: 'observer',
    imageId: 'img',
    transport: 'ok',
    vmHealth: 'ok',
    timedOut: false,
    fields,
    expectedHolds: true,
    ...over,
});

describe('keptCheckStaleness', () => {
    it('calls a kept check stale with route_gone when main now answers 404 on every round where it answered 200 when kept', () => {
        const steps = [step('base', { status: '404' }, { expectedHolds: false }), step('base', { status: '404' }, { expectedHolds: false }), step('pr', { status: '404' }, { expectedHolds: false })];
        expect(keptCheckStaleness(steps, { keptStatus: 200 })).toBe('route_gone');
    });

    it('does not call it route_gone when main answered 404 already when it was kept', () => {
        const steps = [step('base', { status: '404' }), step('base', { status: '404' }), step('pr', { status: '200' }, { expectedHolds: false })];
        expect(keptCheckStaleness(steps, { keptStatus: 404 })).toBeUndefined();
    });

    it('calls it stale with baseline_changed when main fails the kept expectation on every round', () => {
        const steps = [step('base', { status: '500' }, { expectedHolds: false }), step('base', { status: '500' }, { expectedHolds: false }), step('pr', { status: '400' })];
        expect(keptCheckStaleness(steps, { keptStatus: 400 })).toBe('baseline_changed');
    });

    it('is not stale while main still satisfies it, whatever the PR answers', () => {
        const steps = [step('base', { status: '400' }), step('base', { status: '400' }), step('pr', { status: '500' }, { expectedHolds: false })];
        expect(keptCheckStaleness(steps, { keptStatus: 400 })).toBeUndefined();
    });

    it('is not stale when main holds it in one round only: the gate decides that one', () => {
        const steps = [step('base', { status: '400' }), step('base', { status: '500' }, { expectedHolds: false })];
        expect(keptCheckStaleness(steps, { keptStatus: 400 })).toBeUndefined();
    });

    it('never calls a check stale from base rounds that did not answer', () => {
        const steps = [step('base', {}, { transport: 'lost', expectedHolds: undefined }), step('base', {}, { timedOut: true, expectedHolds: undefined })];
        expect(keptCheckStaleness(steps, { keptStatus: 200 })).toBeUndefined();
    });

    it('reads a browser check as baseline_changed when main no longer passes its steps', () => {
        const steps = [step('base', { steps: 'ok,fail:not_found' }, { expectedHolds: false }), step('base', { steps: 'ok,fail:not_found' }, { expectedHolds: false })];
        expect(keptCheckStaleness(steps, {})).toBe('baseline_changed');
    });

    it('never reads a vm step as main', () => {
        const steps = [step('base', { exit: '1' }, { executor: 'vm', expectedHolds: false })];
        expect(keptCheckStaleness(steps, { keptStatus: 200 })).toBeUndefined();
    });
});

describe('keptCheckOutcomeOf', () => {
    it('is failed for a finding nothing marked intended', () => {
        expect(keptCheckOutcomeOf({ verdict: 'finding', intent: 'unintended' })).toBe('failed');
        expect(keptCheckOutcomeOf({ verdict: 'finding', intent: 'uncertain' })).toBe('failed');
        expect(keptCheckOutcomeOf({ verdict: 'finding' })).toBe('failed');
    });

    it('is intended for a finding the diff or the classifier marked intended', () => {
        expect(keptCheckOutcomeOf({ verdict: 'finding', intent: 'intended' })).toBe('intended');
    });

    it('is passed only for the same answer on both sides', () => {
        expect(keptCheckOutcomeOf({ verdict: 'not_reproduced' })).toBe('passed');
    });

    it('is stale when the replay found main no longer has what it guarded, whatever the verdict', () => {
        expect(keptCheckOutcomeOf({ verdict: 'not_reproduced' }, 'route_gone')).toBe('stale');
        expect(keptCheckOutcomeOf({ verdict: 'finding' }, 'baseline_changed')).toBe('stale');
    });

    it('is inconclusive for anything else the gate gave, never passed', () => {
        for (const v of ['inconclusive', 'pre_existing', 'blocker', 'unverified', 'new_endpoint'] as const) {
            expect(keptCheckOutcomeOf({ verdict: v })).toBe('inconclusive');
        }
    });
});

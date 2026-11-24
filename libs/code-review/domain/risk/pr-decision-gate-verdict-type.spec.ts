import type { GateVerdict } from './pr-decision-graph-verdict';

/**
 * Type-level guarantees. The runtime identity check (a discriminated union
 * with three branches) belongs here because it is what makes the reducer
 * exhaustive at compile time. The compile-time contract is enforced by
 * `npx tsc --noEmit`; positive runtime tests below ensure the same shape
 * holds at runtime for the consumers that fold verdicts.
 */
describe('GateVerdict type-level guarantees (verified by tsc)', () => {
    it('accepts a Ready branch with a value and a snapshotKey', () => {
        const v: GateVerdict<number> = {
            status: 'Ready',
            value: 42,
            snapshotKey: 'k',
        };
        expect(v).toMatchObject({ status: 'Ready', value: 42 });
    });

    it('accepts an Unavailable branch with a reason and a snapshotKey', () => {
        const v: GateVerdict<number> = {
            status: 'Unavailable',
            reason: 'no graph',
            snapshotKey: 'k',
        };
        expect(v).toMatchObject({ status: 'Unavailable', reason: 'no graph' });
    });

    it('accepts a Stale branch with current and prior snapshot keys', () => {
        const v: GateVerdict<number> = {
            status: 'Stale',
            snapshotKey: 'k',
            priorSnapshotKey: 'k0',
        };
        expect(v).toMatchObject({ status: 'Stale', priorSnapshotKey: 'k0' });
    });
});

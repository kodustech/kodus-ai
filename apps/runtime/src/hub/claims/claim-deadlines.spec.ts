import { freshDeadlines, readyWaitMs, retryDeadlines } from './claim-deadlines';

const MIN = 60_000;
const T0 = Date.parse('2026-11-06T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('claim deadlines', () => {
    it('a first round gets its consumer lease and ceiling', () => {
        expect(freshDeadlines('runtime', T0)).toEqual({ leaseExpiresAt: iso(T0 + 45 * MIN), hardExpiresAt: iso(T0 + 60 * MIN) });
        expect(freshDeadlines('setup', T0)).toEqual({ leaseExpiresAt: iso(T0 + 45 * MIN), hardExpiresAt: iso(T0 + 45 * MIN) });
    });

    describe('a retried round', () => {
        const first = { cellId: 'cell-a', ...freshDeadlines('runtime', T0) };
        const later = T0 + 10 * MIN;
        const fresh = freshDeadlines('runtime', later);

        it('on the cell it was sent to keeps the recorded deadlines: the ones a cell that rejoins it enforces', () => {
            expect(retryDeadlines(first, 'cell-a', fresh, later)).toEqual({ leaseExpiresAt: first.leaseExpiresAt, hardExpiresAt: first.hardExpiresAt });
        });

        it('on another cell is a new boot', () => {
            expect(retryDeadlines(first, 'cell-b', fresh, later)).toEqual(fresh);
        });

        it('after the ceiling passed is a new boot: no cell still holds the claim', () => {
            expect(retryDeadlines(first, 'cell-a', freshDeadlines('runtime', T0 + 60 * MIN), T0 + 60 * MIN)).toEqual(freshDeadlines('runtime', T0 + 60 * MIN));
        });

        it('with its recorded lease past (or none recorded) keeps the ceiling and gets a fresh lease under it', () => {
            const at = T0 + 50 * MIN;
            const want = { leaseExpiresAt: first.hardExpiresAt, hardExpiresAt: first.hardExpiresAt };
            expect(retryDeadlines(first, 'cell-a', freshDeadlines('runtime', at), at)).toEqual(want);
            expect(retryDeadlines({ cellId: 'cell-a', hardExpiresAt: first.hardExpiresAt }, 'cell-a', freshDeadlines('runtime', at), at)).toEqual(want);
        });
    });

    it('the wait for claim.ready is the consumer one, and ends a minute before the ceiling', () => {
        expect(readyWaitMs('runtime', freshDeadlines('runtime', T0), T0)).toBe(15 * MIN);
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0)).toBe(44 * MIN);
        // A retry 40 minutes into a setup's 45: four minutes left to boot, not 44.
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0 + 40 * MIN)).toBe(4 * MIN);
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0 + 44.5 * MIN)).toBe(0);
    });
});

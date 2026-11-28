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
        // The PR side builds the pull request's commit: it waits for that build, and the base side does not.
        expect(readyWaitMs('runtime', freshDeadlines('runtime', T0), T0, 'pr')).toBe(30 * MIN);
        expect(readyWaitMs('runtime', freshDeadlines('runtime', T0), T0, 'base')).toBe(15 * MIN);
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0, 'pr')).toBe(44 * MIN);
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0)).toBe(44 * MIN);
        // A retry 40 minutes into a setup's 45: four minutes left to boot, not 44.
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0 + 40 * MIN)).toBe(4 * MIN);
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0 + 44.5 * MIN)).toBe(0);
    });

    it('a Run of an environment whose setup booted in 14 min 38 s waits past 15 min on both sides', () => {
        const d = freshDeadlines('runtime', T0);
        const booted = (14 * 60 + 38) * 1000;
        expect(readyWaitMs('runtime', d, T0, 'base', booted)).toBe(22 * MIN);
        expect(readyWaitMs('runtime', d, T0, 'pr', booted)).toBe(30 * MIN);
    });

    it('a fast environment keeps the default wait', () => {
        const d = freshDeadlines('runtime', T0);
        expect(readyWaitMs('runtime', d, T0, 'base', 3 * MIN)).toBe(15 * MIN);
        expect(readyWaitMs('runtime', d, T0, 'pr', 3 * MIN)).toBe(30 * MIN);
        expect(readyWaitMs('runtime', d, T0, 'base', undefined)).toBe(15 * MIN);
    });

    it("the measured boot never stretches the wait past a setup's, nor a Run's own ceiling", () => {
        const d = freshDeadlines('runtime', T0);
        expect(readyWaitMs('runtime', d, T0, 'base', 40 * MIN)).toBe(44 * MIN);
        // A retried round with 10 minutes left of the 60 waits 9, whatever the setup measured.
        expect(readyWaitMs('runtime', d, T0 + 50 * MIN, 'base', 40 * MIN)).toBe(9 * MIN);
    });

    it('a setup and the other consumers ignore the measured boot', () => {
        expect(readyWaitMs('setup', freshDeadlines('setup', T0), T0, undefined, 40 * MIN)).toBe(44 * MIN);
        expect(readyWaitMs('mcp', freshDeadlines('mcp', T0), T0, undefined, 40 * MIN)).toBe(15 * MIN);
    });
});

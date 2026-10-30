import { mapWithinBudget } from '../budget';

describe('mapWithinBudget', () => {
    it('never runs more than `concurrency` items at once and keeps order', async () => {
        let inFlight = 0;
        let peak = 0;
        const { done, skipped } = await mapWithinBudget(
            [1, 2, 3, 4, 5, 6, 7],
            { concurrency: 3, deadline: Number.MAX_SAFE_INTEGER },
            async (n) => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setTimeout(r, 5 * (8 - n)));
                inFlight--;
                return n * 10;
            },
        );
        expect(peak).toBe(3);
        expect(done.map((d) => d.result)).toEqual([10, 20, 30, 40, 50, 60, 70]);
        expect(skipped).toEqual([]);
    });

    it('starts nothing after the deadline and returns what it skipped', async () => {
        let clock = 0;
        const { done, skipped } = await mapWithinBudget(
            ['a', 'b', 'c', 'd'],
            { concurrency: 1, deadline: 2, now: () => clock },
            async (x) => {
                clock++;
                return x;
            },
        );
        expect(done.map((d) => d.item)).toEqual(['a', 'b']);
        expect(skipped).toEqual(['c', 'd']);
    });
});

import { describeLostJobs, describeStaleHolders } from './lost-work-alerts';

describe('lost-work text', () => {
    it('names who held the stale locks and when they were taken', () => {
        const text = describeStaleHolders(
            Array.from({ length: 7 }, (_, i) => ({
                lockedBy: `ip-${i}`,
                count: 7 - i,
                oldestLockedAt: `2026-11-19T11:3${i}:00.000Z`,
                newestLockedAt: `2026-11-19T11:3${i}:30.000Z`,
            })),
        );
        expect(text).toBe(
            'held by ip-0 (7), ip-1 (6), ip-2 (5), ip-3 (4), ip-4 (3) and 2 more, taken between 11:30:00Z and 11:36:30Z',
        );
        expect(describeStaleHolders([])).toBe('');
    });

    it('names when the lost jobs started and which PRs lost their review', () => {
        const job = (pr: number, startedAt: string) => ({
            startedAt: new Date(startedAt),
            repository: 'wellvector/wellvector-app',
            prNumber: pr,
        });
        expect(
            describeLostJobs([
                job(8129, '2026-11-19T13:20:41Z'),
                job(8129, '2026-11-19T13:25:00Z'),
                job(8130, '2026-11-19T13:29:58Z'),
            ]),
        ).toBe(
            ' Started between 13:20:41Z and 13:29:58Z. Most affected: wellvector/wellvector-app#8129 (2), wellvector/wellvector-app#8130.',
        );
        expect(describeLostJobs([{}])).toBe('');
    });
});

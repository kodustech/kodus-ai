import { describeInboxReclaim, describeStaleJobReap } from './lost-work-alerts';

describe('lost-work alert text', () => {
    it('says the reclaim reports old work and who held it', () => {
        const text = describeInboxReclaim(
            'workflow-job-consumer.code_review',
            13,
            150 * 60_000,
            Array.from({ length: 7 }, (_, i) => ({
                lockedBy: `ip-${i}`,
                count: 7 - i,
                oldestLockedAt: `2026-11-19T11:3${i}:00.000Z`,
                newestLockedAt: `2026-11-19T11:3${i}:30.000Z`,
            })),
        );
        expect(text).toContain(
            '13 messages stuck in PROCESSING for over 150 min',
        );
        expect(text).toContain('between 11:30:00Z and 11:36:30Z');
        expect(text).toContain('ip-0 (7), ip-1 (6)');
        expect(text).toContain('and 2 more');
        expect(text).toContain('the sending host only ran the reaper');
    });

    it('still reads without holders or a start time', () => {
        expect(describeInboxReclaim('c', 6, 20 * 60_000, [])).toContain(
            'Their workers stopped without releasing them',
        );
        expect(describeStaleJobReap(6, 180, [{}])).not.toContain(
            'Most affected',
        );
    });
});

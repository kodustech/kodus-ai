import { KodyLearningStatus } from '@libs/organization/domain/parameters/types/configValue.type';

import {
    hasExhaustedStuckRetries,
    isKodyLearningStatusStale,
    MAX_STUCK_RETRIES,
    STALE_GENERATING_THRESHOLD_MS,
} from './kody-learning-staleness';

describe('isKodyLearningStatusStale', () => {
    const NOW = 1_700_000_000_000;

    it('returns false for a non-generating status', () => {
        expect(
            isKodyLearningStatusStale(
                KodyLearningStatus.ENABLED,
                new Date(NOW),
                NOW,
            ),
        ).toBe(false);
    });

    it('returns false while a generating status is still fresh', () => {
        const updatedAt = new Date(NOW - 60_000); // 1 minute ago
        expect(
            isKodyLearningStatusStale(
                KodyLearningStatus.GENERATING_RULES,
                updatedAt,
                NOW,
            ),
        ).toBe(false);
    });

    it('returns true once a generating status is older than the threshold', () => {
        const updatedAt = new Date(NOW - STALE_GENERATING_THRESHOLD_MS - 1);
        expect(
            isKodyLearningStatusStale(
                KodyLearningStatus.GENERATING_RULES,
                updatedAt,
                NOW,
            ),
        ).toBe(true);
    });

    it('treats a generating status with no timestamp as stale', () => {
        expect(
            isKodyLearningStatusStale(
                KodyLearningStatus.GENERATING_CONFIG,
                undefined,
                NOW,
            ),
        ).toBe(true);
    });
});

describe('hasExhaustedStuckRetries', () => {
    it('returns false when there is no retry count yet', () => {
        expect(hasExhaustedStuckRetries(undefined)).toBe(false);
        expect(hasExhaustedStuckRetries(0)).toBe(false);
    });

    it('returns false while still under the cap', () => {
        expect(hasExhaustedStuckRetries(MAX_STUCK_RETRIES - 1)).toBe(false);
    });

    it('returns true once the cap is reached', () => {
        expect(hasExhaustedStuckRetries(MAX_STUCK_RETRIES)).toBe(true);
        expect(hasExhaustedStuckRetries(MAX_STUCK_RETRIES + 1)).toBe(true);
    });
});

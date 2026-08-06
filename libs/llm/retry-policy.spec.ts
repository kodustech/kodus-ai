import {
    RETRYABLE_CATEGORY,
    jitteredBackoffMs,
    RETRY_BASE_DELAY_MS,
    RETRY_MAX_DELAY_MS,
} from './retry-policy';
import { LlmErrorCategory } from './error-classifier';

describe('retry-policy', () => {
    it('re-issues only on the TRANSIENT category (RATE_LIMIT backs off via cooldown)', () => {
        expect(RETRYABLE_CATEGORY).toBe(LlmErrorCategory.TRANSIENT);
    });

    describe('jitteredBackoffMs — full jitter in [0.5, 1] × exponential', () => {
        it('attempt 1 stays within [0.5·base, base]', () => {
            for (let i = 0; i < 200; i++) {
                const d = jitteredBackoffMs(1);
                expect(d).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS * 0.5);
                expect(d).toBeLessThanOrEqual(RETRY_BASE_DELAY_MS);
            }
        });

        it('grows exponentially per attempt (2 → up to 2·base)', () => {
            for (let i = 0; i < 200; i++) {
                const d = jitteredBackoffMs(2);
                expect(d).toBeGreaterThanOrEqual(RETRY_BASE_DELAY_MS); // 0.5 × 2 × base
                expect(d).toBeLessThanOrEqual(RETRY_BASE_DELAY_MS * 2);
            }
        });

        it('never exceeds the cap', () => {
            for (let i = 0; i < 200; i++) {
                expect(jitteredBackoffMs(100)).toBeLessThanOrEqual(
                    RETRY_MAX_DELAY_MS,
                );
            }
        });

        it('spreads: not all samples collide (jitter actually applies)', () => {
            const samples = new Set(
                Array.from({ length: 50 }, () => jitteredBackoffMs(3)),
            );
            expect(samples.size).toBeGreaterThan(1);
        });
    });
});

import { Criticality } from '../domain/enums';
import { decideRetry } from './retry-policy';

describe('decideRetry', () => {
    // Pin Math.random so jitter is deterministic. 0.5 → multiplier 1.0
    // (no jitter), which makes the math easy to assert below.
    const NO_JITTER = 0.5;

    beforeEach(() => {
        jest.spyOn(Math, 'random').mockReturnValue(NO_JITTER);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('non-critical (informational / transactional / system)', () => {
        const NOW = new Date('2026-01-01T00:00:00.000Z');

        it.each([
            Criticality.INFORMATIONAL,
            Criticality.TRANSACTIONAL,
            Criticality.SYSTEM,
        ])('schedules a retry for %s on first failure', (criticality) => {
            const decision = decideRetry(criticality, 1, NOW);

            expect(decision.shouldRetry).toBe(true);
            expect(decision.maxAttempts).toBe(5);
            // attemptsSoFar=1 → 10s * 2^0 = 10s base, no jitter at 0.5
            expect(decision.nextAttemptAt.getTime() - NOW.getTime()).toBe(
                10_000,
            );
        });

        it('doubles the delay each subsequent attempt', () => {
            const a1 = decideRetry(Criticality.INFORMATIONAL, 1, NOW);
            const a2 = decideRetry(Criticality.INFORMATIONAL, 2, NOW);
            const a3 = decideRetry(Criticality.INFORMATIONAL, 3, NOW);

            expect(a1.nextAttemptAt.getTime() - NOW.getTime()).toBe(10_000);
            expect(a2.nextAttemptAt.getTime() - NOW.getTime()).toBe(20_000);
            expect(a3.nextAttemptAt.getTime() - NOW.getTime()).toBe(40_000);
        });

        it('caps the delay at 5 minutes', () => {
            // 10s * 2^7 = 1280s ≫ 5min; should clamp.
            const decision = decideRetry(Criticality.INFORMATIONAL, 8, NOW);
            // attemptsSoFar=8 is past maxAttempts (5) → terminal
            expect(decision.shouldRetry).toBe(false);

            // Force the cap path by checking attempt within budget but
            // beyond exp cap (lower max attempts wouldn't hit it, so we
            // assert the cap on a CRITICAL run which has 8 attempts).
            const critical = decideRetry(Criticality.CRITICAL, 7, NOW);
            expect(critical.shouldRetry).toBe(true);
            expect(
                critical.nextAttemptAt.getTime() - NOW.getTime(),
            ).toBeLessThanOrEqual(5 * 60 * 1000);
        });

        it('marks terminal once attemptsSoFar reaches maxAttempts', () => {
            const decision = decideRetry(Criticality.INFORMATIONAL, 5, NOW);
            expect(decision.shouldRetry).toBe(false);
            expect(decision.maxAttempts).toBe(5);
        });
    });

    describe('critical', () => {
        const NOW = new Date('2026-01-01T00:00:00.000Z');

        it('uses the tighter base delay of 5s', () => {
            const decision = decideRetry(Criticality.CRITICAL, 1, NOW);
            expect(decision.shouldRetry).toBe(true);
            expect(decision.maxAttempts).toBe(8);
            expect(decision.nextAttemptAt.getTime() - NOW.getTime()).toBe(
                5_000,
            );
        });

        it('grants 8 attempts before going terminal', () => {
            const last = decideRetry(Criticality.CRITICAL, 7, NOW);
            const terminal = decideRetry(Criticality.CRITICAL, 8, NOW);

            expect(last.shouldRetry).toBe(true);
            expect(terminal.shouldRetry).toBe(false);
        });
    });

    describe('jitter window', () => {
        it('produces delays within ±15% of the exponential base', () => {
            jest.restoreAllMocks();
            // Run a batch and confirm every sample sits in [85%, 115%]
            // of the 10s base for attempt 1. Real random — we just need
            // the bounds.
            const NOW = new Date();
            const samples = Array.from({ length: 200 }, () =>
                decideRetry(Criticality.INFORMATIONAL, 1, NOW),
            );

            for (const s of samples) {
                const delayMs = s.nextAttemptAt.getTime() - NOW.getTime();
                expect(delayMs).toBeGreaterThanOrEqual(8_500); // 10s * 0.85
                expect(delayMs).toBeLessThanOrEqual(11_500); // 10s * 1.15
            }
        });
    });
});

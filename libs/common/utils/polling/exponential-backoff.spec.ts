import {
    calculateBackoffIntervalExact,
    calculateBackoffWithMetadata,
    calculateBackoffInterval,
    createBackoffCalculator,
    generateBackoffSequence,
    generateBackoffSequenceWithMetadata,
} from './exponential-backoff';

describe('exponential-backoff deterministic logic', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('calculateBackoffWithMetadata', () => {
        // Mock Math.random to 0.5 so jitter = range * (0.5 - 0.5) * 2 = 0,
        // making the default jitterFactor (0.25) path fully deterministic.
        const mockRandomHalf = () =>
            jest.spyOn(Math, 'random').mockReturnValue(0.5);

        it('applies defaults exactly: base 1000, exponential (multiplier 2)', () => {
            mockRandomHalf();
            const result = calculateBackoffWithMetadata(0);
            expect(result).toEqual({
                interval: 1000,
                baseInterval: 1000,
                jitter: 0,
                capped: false,
                strategy: 'exponential',
            });
        });

        it('grows exponentially with default multiplier 2', () => {
            expect(
                calculateBackoffWithMetadata(3, { jitterFactor: 0 })
                    .baseInterval,
            ).toBe(8000); // 1000 * 2^3
        });

        it('uses linear formula base * (attempt + 1) when multiplier === 1', () => {
            const result = calculateBackoffWithMetadata(2, {
                baseInterval: 5000,
                multiplier: 1,
                jitterFactor: 0,
                maxInterval: 60000,
            });
            expect(result.strategy).toBe('linear');
            expect(result.baseInterval).toBe(15000); // 5000 * (2 + 1)
            expect(result.interval).toBe(15000);
        });

        it('selects exponential strategy for multiplier 2 (not linear)', () => {
            const result = calculateBackoffWithMetadata(2, {
                baseInterval: 5000,
                multiplier: 2,
                jitterFactor: 0,
                maxInterval: 60000,
            });
            expect(result.strategy).toBe('exponential');
            expect(result.baseInterval).toBe(20000); // 5000 * 2^2
        });

        it('linear attempt 0 equals baseInterval (attempt + 1 offset)', () => {
            const result = calculateBackoffWithMetadata(0, {
                baseInterval: 5000,
                multiplier: 1,
                jitterFactor: 0,
            });
            expect(result.baseInterval).toBe(5000); // 5000 * (0 + 1)
        });

        it('is NOT capped when rawInterval equals maxInterval (boundary)', () => {
            const result = calculateBackoffWithMetadata(2, {
                baseInterval: 1000,
                maxInterval: 4000,
                multiplier: 2,
                jitterFactor: 0,
            });
            // raw = 4000, 4000 > 4000 is false -> not capped
            expect(result.capped).toBe(false);
            expect(result.baseInterval).toBe(4000);
        });

        it('IS capped when rawInterval exceeds maxInterval (boundary + 1 step)', () => {
            const result = calculateBackoffWithMetadata(3, {
                baseInterval: 1000,
                maxInterval: 4000,
                multiplier: 2,
                jitterFactor: 0,
            });
            // raw = 8000 > 4000 -> capped, baseInterval clamped to 4000
            expect(result.capped).toBe(true);
            expect(result.baseInterval).toBe(4000);
            expect(result.interval).toBe(4000);
        });

        it('computes positive jitter with Math.random = 1', () => {
            jest.spyOn(Math, 'random').mockReturnValue(1);
            const result = calculateBackoffWithMetadata(0, {
                baseInterval: 1000,
                jitterFactor: 0.25,
                maxInterval: 30000,
            });
            // jitter = (1000 * 0.25) * (1 - 0.5) * 2 = 250
            expect(result.jitter).toBe(250);
            expect(result.interval).toBe(1250);
        });

        it('computes negative jitter with Math.random = 0', () => {
            jest.spyOn(Math, 'random').mockReturnValue(0);
            const result = calculateBackoffWithMetadata(0, {
                baseInterval: 1000,
                jitterFactor: 0.25,
                maxInterval: 30000,
            });
            // jitter = 250 * (0 - 0.5) * 2 = -250
            expect(result.jitter).toBe(-250);
            expect(result.interval).toBe(750);
        });

        it('floors fractional jitter and interval', () => {
            jest.spyOn(Math, 'random').mockReturnValue(0);
            const result = calculateBackoffWithMetadata(0, {
                baseInterval: 1001,
                jitterFactor: 0.25,
                maxInterval: 30000,
            });
            // range = 250.25, jitter = -250.25 -> floor = -251
            expect(result.jitter).toBe(-251);
            // 1001 - 250.25 = 750.75 -> floor = 750
            expect(result.interval).toBe(750);
        });

        it('clamps final interval to minimum of 1', () => {
            jest.spyOn(Math, 'random').mockReturnValue(0);
            const result = calculateBackoffWithMetadata(0, {
                baseInterval: 1,
                jitterFactor: 1,
                maxInterval: 30000,
            });
            // jitter = 1 * (0 - 0.5) * 2 = -1 -> 1 + (-1) = 0 -> max(1, 0) = 1
            expect(result.interval).toBe(1);
        });

        it('throws when attempt is negative', () => {
            expect(() => calculateBackoffWithMetadata(-1)).toThrow(
                'Attempt number must be non-negative',
            );
        });

        it('does not throw when attempt is exactly 0 (boundary)', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { jitterFactor: 0 }),
            ).not.toThrow();
        });

        it('throws when baseInterval is 0 (boundary)', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { baseInterval: 0 }),
            ).toThrow('Base interval must be positive');
        });

        it('throws when baseInterval is negative', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { baseInterval: -1 }),
            ).toThrow('Base interval must be positive');
        });

        it('throws when maxInterval < baseInterval', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, {
                    baseInterval: 1000,
                    maxInterval: 999,
                }),
            ).toThrow('Max interval must be >= base interval');
        });

        it('does not throw when maxInterval equals baseInterval (boundary)', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, {
                    baseInterval: 1000,
                    maxInterval: 1000,
                    jitterFactor: 0,
                }),
            ).not.toThrow();
        });

        it('throws when jitterFactor < 0', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { jitterFactor: -0.01 }),
            ).toThrow('Jitter factor must be between 0 and 1');
        });

        it('throws when jitterFactor > 1', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { jitterFactor: 1.01 }),
            ).toThrow('Jitter factor must be between 0 and 1');
        });

        it('does not throw at jitterFactor boundaries 0 and 1', () => {
            jest.spyOn(Math, 'random').mockReturnValue(0.5);
            expect(() =>
                calculateBackoffWithMetadata(0, { jitterFactor: 0 }),
            ).not.toThrow();
            expect(() =>
                calculateBackoffWithMetadata(0, { jitterFactor: 1 }),
            ).not.toThrow();
        });

        it('throws when multiplier < 1 (boundary just below)', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { multiplier: 0.99 }),
            ).toThrow('Multiplier must be >= 1');
        });

        it('does not throw when multiplier is exactly 1 (boundary)', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, {
                    multiplier: 1,
                    jitterFactor: 0,
                }),
            ).not.toThrow();
        });
    });

    describe('calculateBackoffIntervalExact', () => {
        it('returns the exact base interval with no jitter regardless of options', () => {
            expect(calculateBackoffIntervalExact(3)).toBe(8000); // 1000 * 2^3
        });

        it('forces jitterFactor to 0 even when a jitterFactor is passed', () => {
            // If the override were dropped, jitter with random=0 would subtract.
            jest.spyOn(Math, 'random').mockReturnValue(0);
            expect(
                calculateBackoffIntervalExact(0, {
                    baseInterval: 1000,
                    jitterFactor: 1,
                }),
            ).toBe(1000);
        });

        it('respects linear mode deterministically', () => {
            expect(
                calculateBackoffIntervalExact(3, {
                    baseInterval: 5000,
                    multiplier: 1,
                    maxInterval: 60000,
                }),
            ).toBe(20000); // 5000 * (3 + 1)
        });

        it('applies the cap', () => {
            expect(
                calculateBackoffIntervalExact(10, {
                    baseInterval: 1000,
                    maxInterval: 30000,
                }),
            ).toBe(30000);
        });
    });

    describe('calculateBackoffInterval', () => {
        it('returns just the interval field from the metadata result', () => {
            jest.spyOn(Math, 'random').mockReturnValue(1);
            const interval = calculateBackoffInterval(0, {
                baseInterval: 1000,
                jitterFactor: 0.25,
            });
            const meta = calculateBackoffWithMetadata(0, {
                baseInterval: 1000,
                jitterFactor: 0.25,
            });
            expect(interval).toBe(meta.interval);
            expect(interval).toBe(1250);
        });
    });

    describe('createBackoffCalculator', () => {
        it('applies pre-configured default options', () => {
            const backoff = createBackoffCalculator({
                baseInterval: 500,
                maxInterval: 10000,
                jitterFactor: 0,
            });
            expect(backoff(1)).toBe(1000); // 500 * 2^1
        });

        it('lets per-call overrides win over defaults', () => {
            const backoff = createBackoffCalculator({
                baseInterval: 500,
                jitterFactor: 0,
                multiplier: 2,
            });
            // override baseInterval and multiplier at call time
            expect(
                backoff(2, {
                    baseInterval: 5000,
                    multiplier: 1,
                    maxInterval: 60000,
                }),
            ).toBe(15000); // 5000 * (2 + 1)
        });

        it('keeps defaults when overrides omit a key', () => {
            const backoff = createBackoffCalculator({
                baseInterval: 500,
                jitterFactor: 0,
            });
            expect(backoff(0, { multiplier: 2 })).toBe(500);
        });
    });

    describe('generateBackoffSequence', () => {
        it('produces the exact exponential sequence', () => {
            expect(generateBackoffSequence(5, { jitterFactor: 0 })).toEqual([
                1000, 2000, 4000, 8000, 16000,
            ]);
        });

        it('produces the exact linear sequence', () => {
            expect(
                generateBackoffSequence(5, {
                    baseInterval: 5000,
                    multiplier: 1,
                    jitterFactor: 0,
                    maxInterval: 30000,
                }),
            ).toEqual([5000, 10000, 15000, 20000, 25000]);
        });

        it('produces exactly maxAttempts entries', () => {
            expect(
                generateBackoffSequence(3, { jitterFactor: 0 }),
            ).toHaveLength(3);
        });

        it('throws when maxAttempts is 0 (boundary)', () => {
            expect(() => generateBackoffSequence(0)).toThrow(
                'Max attempts must be positive',
            );
        });

        it('throws when maxAttempts is negative', () => {
            expect(() => generateBackoffSequence(-1)).toThrow(
                'Max attempts must be positive',
            );
        });

        it('does not throw when maxAttempts is 1 (boundary)', () => {
            expect(() =>
                generateBackoffSequence(1, { jitterFactor: 0 }),
            ).not.toThrow();
        });
    });

    describe('generateBackoffSequenceWithMetadata', () => {
        it('returns one BackoffResult per attempt with exact values', () => {
            jest.spyOn(Math, 'random').mockReturnValue(0.5);
            const results = generateBackoffSequenceWithMetadata(3, {
                baseInterval: 1000,
                maxInterval: 4000,
                multiplier: 2,
                jitterFactor: 0,
            });
            expect(results).toEqual([
                {
                    interval: 1000,
                    baseInterval: 1000,
                    jitter: 0,
                    capped: false,
                    strategy: 'exponential',
                },
                {
                    interval: 2000,
                    baseInterval: 2000,
                    jitter: 0,
                    capped: false,
                    strategy: 'exponential',
                },
                {
                    interval: 4000,
                    baseInterval: 4000,
                    jitter: 0,
                    capped: false,
                    strategy: 'exponential',
                },
            ]);
        });

        it('marks capped entries once the cap is exceeded', () => {
            const results = generateBackoffSequenceWithMetadata(4, {
                baseInterval: 1000,
                maxInterval: 4000,
                multiplier: 2,
                jitterFactor: 0,
            });
            expect(results.map((r) => r.capped)).toEqual([
                false,
                false,
                false,
                true,
            ]);
        });

        it('throws when maxAttempts is 0 (boundary)', () => {
            expect(() => generateBackoffSequenceWithMetadata(0)).toThrow(
                'Max attempts must be positive',
            );
        });

        it('throws when maxAttempts is negative', () => {
            expect(() => generateBackoffSequenceWithMetadata(-2)).toThrow(
                'Max attempts must be positive',
            );
        });
    });
});

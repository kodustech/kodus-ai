import {
    calculateBackoffWithMetadata,
    calculateBackoffInterval,
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

        it('throws when baseInterval is 0 (boundary)', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { baseInterval: 0 }),
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

        it('throws when multiplier < 1 (boundary just below)', () => {
            expect(() =>
                calculateBackoffWithMetadata(0, { multiplier: 0.99 }),
            ).toThrow('Multiplier must be >= 1');
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
});

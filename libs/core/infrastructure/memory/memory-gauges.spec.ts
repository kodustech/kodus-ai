import {
    clearMemoryGauges,
    readMemoryGauges,
    registerMemoryGauge,
} from './memory-gauges';

describe('memory gauges', () => {
    afterEach(() => clearMemoryGauges());

    it('reads every registered gauge by name', () => {
        registerMemoryGauge('cache', () => ({ entries: 3, mb: 1.5 }));
        registerMemoryGauge('pool', () => ({ open: 2 }));

        expect(readMemoryGauges()).toEqual({
            cache: { entries: 3, mb: 1.5 },
            pool: { open: 2 },
        });
    });

    it('reports a gauge that throws without failing the others', () => {
        registerMemoryGauge('broken', () => {
            throw new Error('boom');
        });
        registerMemoryGauge('cache', () => ({ entries: 1 }));

        expect(readMemoryGauges()).toEqual({
            broken: { error: 1 },
            cache: { entries: 1 },
        });
    });

    it('keeps one reader per name', () => {
        registerMemoryGauge('cache', () => ({ entries: 1 }));
        registerMemoryGauge('cache', () => ({ entries: 2 }));

        expect(readMemoryGauges()).toEqual({ cache: { entries: 2 } });
    });
});

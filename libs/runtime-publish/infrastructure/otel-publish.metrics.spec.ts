import { OtelPublishMetrics, PUBLISH_METRIC } from './otel-publish.metrics';

function fakeMeter(counter: { add: jest.Mock }, histogram = { record: jest.fn() }) {
    const callbacks: Array<(r: { observe: jest.Mock }) => void> = [];
    return {
        callbacks,
        createCounter: jest.fn(() => counter),
        createHistogram: jest.fn(() => histogram),
        createObservableGauge: jest.fn(() => ({ addCallback: (cb: (r: { observe: jest.Mock }) => void) => callbacks.push(cb) })),
    };
}

describe('OtelPublishMetrics', () => {
    it('counts outcomes and times deliveries with the same labels', () => {
        const counter = { add: jest.fn() };
        const histogram = { record: jest.fn() };
        const meter = fakeMeter(counter, histogram);
        new OtelPublishMetrics(meter as any).record({ kind: 'comment', outcome: 'refused', reason: 'key_mismatch', durationMs: 12 });

        expect(meter.createCounter).toHaveBeenCalledWith(PUBLISH_METRIC.outcome, expect.anything());
        const labels = { kind: 'comment', outcome: 'refused', reason: 'key_mismatch' };
        expect(counter.add).toHaveBeenCalledWith(1, labels);
        expect(histogram.record).toHaveBeenCalledWith(12, labels);
    });

    it('counts redrives by kind, step and outcome', () => {
        const counter = { add: jest.fn() };
        const meter = fakeMeter(counter);
        new OtelPublishMetrics(meter as any).recordRedrive({ kind: 'comment', step: 'fallback', outcome: 'gave_up' });

        expect(meter.createCounter).toHaveBeenCalledWith(PUBLISH_METRIC.redrive, expect.anything());
        expect(counter.add).toHaveBeenCalledWith(1, { kind: 'comment', step: 'fallback', outcome: 'gave_up' });
    });

    it('the stuck gauge reports the last sweep only, nothing before the first', () => {
        const meter = fakeMeter({ add: jest.fn() });
        const m = new OtelPublishMetrics(meter as any);
        const observe = jest.fn();
        meter.callbacks[0]({ observe });
        expect(observe).not.toHaveBeenCalled();

        m.recordStuck(3);
        meter.callbacks[0]({ observe });
        expect(observe).toHaveBeenCalledWith(3);
        expect(meter.createObservableGauge).toHaveBeenCalledWith(PUBLISH_METRIC.stuck, expect.anything());
    });
});

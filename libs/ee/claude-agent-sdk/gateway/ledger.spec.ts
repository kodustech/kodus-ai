import { SessionLedger, compactionOf } from './ledger';

describe('session ledger', () => {
    it('sums usage over requests, skipping ones without usage', () => {
        const ledger = new SessionLedger();
        ledger.record({ status: 200, ms: 10, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 } });
        ledger.record({ status: 429, ms: 3 });
        ledger.record({ status: 200, ms: 12, usage: { inputTokens: 150, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 0 } });
        expect(ledger.snapshot().usage).toEqual({ inputTokens: 250, outputTokens: 30, cacheReadTokens: 180, cacheWriteTokens: 5 });
        expect(ledger.snapshot().requests.map((r) => r.status)).toEqual([200, 429, 200]);
    });

    it('keeps every upstream error in order, the last one being the attempt’s error', () => {
        const ledger = new SessionLedger();
        expect(ledger.lastError()).toBeUndefined();
        ledger.recordError({ status: 429, body: '{"error":{"type":"rate_limit_error"}}', retryAfter: '2' });
        ledger.recordError({ status: 401, body: '{"error":{"type":"authentication_error"}}' });
        expect(ledger.lastError()).toEqual({ status: 401, body: '{"error":{"type":"authentication_error"}}' });
        expect(ledger.snapshot().upstreamErrors).toHaveLength(2);
    });

    it('counts compaction requests by the CLI’s header, and ignores unknown values', () => {
        expect(compactionOf('auto')).toBe('auto');
        expect(compactionOf(['Reactive'])).toBe('reactive');
        expect(compactionOf('manual ')).toBe('manual');
        expect(compactionOf('yes')).toBeUndefined();
        expect(compactionOf(undefined)).toBeUndefined();
        const ledger = new SessionLedger();
        ledger.record({ status: 200, ms: 1, compaction: 'auto' });
        ledger.record({ status: 200, ms: 1 });
        expect(ledger.snapshot().compactions).toBe(1);
    });

    it('hands out a copy, so a snapshot never changes after the fact', () => {
        const ledger = new SessionLedger();
        ledger.record({ status: 200, ms: 1 });
        const snap = ledger.snapshot();
        ledger.record({ status: 200, ms: 1 });
        expect(snap.requests).toHaveLength(1);
    });
});

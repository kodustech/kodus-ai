import { evidenceRequestFor, type EvidenceRequest } from './messages';

const grant = (type: 'logs' | 'db' | 'cast') => ({
    type,
    url: `https://evidence.kodus.test/o/r/pr/0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d/${type}?exp=1&max=1&nonce=AAAAAAAAAAAAAAAA&sig=x`,
    contentType: 'text/plain' as const,
    maxBytes: 1,
    expiresAt: '2026-11-06T12:00:00.000Z',
});

describe('evidenceRequestFor (what a cell may be sent)', () => {
    const req: EvidenceRequest = { capture: ['logs', 'db', 'outbound'], uploads: [grant('logs'), grant('db')] };

    it('sends an older cell nothing', () => {
        expect(evidenceRequestFor(undefined, req)).toBeUndefined();
        expect(evidenceRequestFor(['seedsCache', 'readyBuildSteps'], req)).toBeUndefined();
    });

    it('keeps only the captures and grants of the features the cell named', () => {
        expect(evidenceRequestFor(['serviceLogs'], req)).toEqual({ capture: ['logs'], uploads: [grant('logs')] });
        expect(evidenceRequestFor(['outboundCalls', 'dbEffects'], req)).toEqual({ capture: ['db', 'outbound'], uploads: [grant('db')] });
    });

    it('never sends a grant for something not captured', () => {
        expect(evidenceRequestFor(['serviceLogs', 'execCast'], { capture: ['logs'], uploads: [grant('cast'), grant('logs')] })).toEqual({ capture: ['logs'], uploads: [grant('logs')] });
        expect(evidenceRequestFor(['outboundCalls'], { capture: ['outbound'], uploads: [grant('logs')] })).toEqual({ capture: ['outbound'] });
    });
});

describe('evidenceRequestFor with the browser capture (ADR-071)', () => {
    const shot = { type: 'screenshot-0' as const, url: 'https://evidence.kodus.test/o/r/pr/0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d/screenshot-0?exp=1&max=1&nonce=AAAAAAAAAAAAAAAA&sig=x', contentType: 'image/png' as const, maxBytes: 1, expiresAt: '2026-11-06T12:00:00.000Z' };
    const baseline = [{ step: 2, screenshot: 0, url: 'https://evidence.kodus.test/o/r/base/0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d/screenshot-0?exp=1&sig=x' }];
    const req: EvidenceRequest = { capture: ['logs', 'outbound', 'browser'], uploads: [grant('logs'), shot], baseline };

    it('a cell that names browser gets its grants and the baseline', () => {
        expect(evidenceRequestFor(['serviceLogs', 'outboundCalls', 'browser'], req)).toEqual(req);
    });

    it('a cell without it gets neither: it refuses the probe as before (browser_unavailable)', () => {
        expect(evidenceRequestFor(['serviceLogs', 'outboundCalls'], req)).toEqual({ capture: ['logs', 'outbound'], uploads: [grant('logs')] });
        expect(evidenceRequestFor(['browser'], { capture: ['logs'], uploads: [shot], baseline })).toBeUndefined();
    });
});

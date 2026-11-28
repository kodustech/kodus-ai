import type { PlannedProbe } from '@libs/runtime/contracts/run-plan';

import { keepFirstStatuses, reconDoubts, reconOnBase } from './plan-recon';

// What a probe's first answer from base says about the probe itself: does
// the request reach the app, and can its compared fields show a change. Never
// what status to expect (planner-eval.md fix 2).

const planned = (path: string, over: Partial<PlannedProbe> = {}): PlannedProbe => ({
    entryPoint: `GET ${path}`,
    assertions: { kind: 'http', status: 200 },
    probe: { id: 'p', origin: 'agent', purpose: 'x', expected: 'x', compare: ['status', 'json'], spec: { kind: 'http', target: { service: 'app', port: 3000 }, method: 'GET', path, timeoutMs: 30_000 } },
    ...over,
});
const answer = (over: Record<string, unknown>) => ({ probeId: 'p', request: 'GET /x', ...over });

describe('reconDoubts', () => {
    it("an API path answered by the web app's HTML page is a doubt (demo-immich#1 without /api)", () => {
        expect(reconDoubts(planned('/server/ping'), answer({ status: 200, contentType: 'text/html', bodyStart: '<!doctype html>' }), [])).toEqual([expect.stringContaining('HTML page')]);
    });

    it('a 404 is a doubt, except on a route the PR adds (absent on base by design)', () => {
        expect(reconDoubts(planned('/x'), answer({ status: 404, contentType: 'text/plain' }), [])).toEqual([expect.stringContaining('404')]);
        expect(reconDoubts(planned('/x'), answer({ status: 404, contentType: 'text/plain' }), [{ id: 'GET /x', added: true }])).toEqual([]);
    });

    it('a body that varies between two requests, and a bodyIncludes base does not show, are doubts (demo-nextjs#2)', () => {
        const p = planned('/', { assertions: { kind: 'http', status: 200, bodyIncludes: 'Production configuration, ready to deploy' } });
        const doubts = reconDoubts(p, answer({ status: 200, contentType: 'text/plain', bodyStart: 'x', varies: true, bodyIncludesOnBase: false }), []);
        expect(doubts).toEqual([expect.stringContaining('different bodies'), expect.stringContaining('bodyIncludes')]);
    });

    it('a JSON answer on the path the plan names is no doubt, whatever its status (a 5xx stays the plan\'s prediction to judge)', () => {
        expect(reconDoubts(planned('/api/x'), answer({ status: 200, contentType: 'application/json', bodyStart: '{}' }), [])).toEqual([]);
        expect(reconDoubts(planned('/api/x'), answer({ status: 500, contentType: 'application/json', bodyStart: '{}' }), [])).toEqual([]);
    });
});

describe('keepFirstStatuses', () => {
    it('a revised probe keeps the status first predicted for its id; a new probe keeps its own', () => {
        const first = [planned('/server/ping')];
        const revised = [planned('/api/server/ping', { assertions: { kind: 'http', status: 401 } }), { ...planned('/api/other'), probe: { ...planned('/api/other').probe, id: 'q' }, assertions: { kind: 'http' as const, status: 204 } }];
        expect(keepFirstStatuses(revised, first).map((p) => p.assertions?.status)).toEqual([200, 204]);
    });
});

describe('reconOnBase', () => {
    const html = { 'content-type': 'text/html; charset=utf-8' };
    const recon = async (bodies: string[]) => {
        const left = [...bodies];
        const env = {
            probe: async (_claim: string, _probe: unknown, stepId: string) => ({ stepId, executor: 'observer' as const, imageId: 'img', transport: 'ok' as const, http: { status: 200, headers: html, body: left.shift() ?? '' } }),
        };
        const { answers } = await reconOnBase({ env: env as never, baseClaimId: 'c', probes: [planned('/')], entryPoints: [], stepIdOf: (i, n) => `s-${i}-${n}`, canaries: [] });
        return answers[0];
    };
    const page = (text: string, requestId: string) => `<!DOCTYPE html><html><body><p>${text}</p><script>self.__next_r="${requestId}"</script></body></html>`;

    it('an HTML page whose bytes differ per request only in an inline script does not vary: its text and markup are what the gate compares', async () => {
        expect((await recon([page('Orders', '109JB9rHd'), page('Orders', 'sX4lSiNKM')])).varies).toBe(false);
    });

    it('an HTML page whose text differs between two requests varies', async () => {
        const a = await recon([page('12:00:01', 'x'), page('12:00:02', 'x')]);
        expect(a.varies).toBe(true);
        expect(a.doubts).toEqual(expect.arrayContaining([expect.stringContaining('different text or markup')]));
    });
});

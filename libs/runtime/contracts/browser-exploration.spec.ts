import { BrowserExploreRequestSchema, BrowserExploreResultSchema } from './browser-exploration';
import { RunPlanRequestSchema, RunPlanResponseSchema } from './run-plan';

const request = { steps: [{ goto: '/' }, { fill: ['#name', '--config evil'] }], viewport: { width: 800, height: 600 }, timeoutMs: 30_000 };
const result = { status: 'observed', snapshot: 'textbox name [ref=e1]', candidates: [{ ref: 'e1', selector: '[id="name"]' }], actionsCompleted: 2, durationMs: 40, cliCalls: 4, truncated: false };

describe('local browser exploration boundary', () => {
    it('keeps option-like form values as data', () => {
        expect(BrowserExploreRequestSchema.parse(request)).toEqual(request);
    });
    it.each([
        { ...request, provider: 'browserbase' }, { ...request, cdp: 'ws://outside.test' },
        { ...request, timeoutMs: 30_001 }, { ...request, steps: [{ goto: '/' }, { evaluate: 'window.test=true' }] },
        { ...request, steps: [{ goto: '/' }, { click: 'internal:role=button' }] },
    ])('refuses unowned configuration, open commands and limits', (bad) => {
        expect(BrowserExploreRequestSchema.safeParse(bad).success).toBe(false);
    });
    it.each([
        { ...result, verdict: 'finding' }, { ...result, snapshot: 'x'.repeat(8_001) },
        { ...result, candidates: Array.from({ length: 33 }, () => result.candidates[0]) },
        { ...result, candidates: [{ ref: 'e1', selector: '@e1' }] }, { ...result, cliCalls: 201 },
    ])('refuses result authority and unbounded observations', (bad) => {
        expect(BrowserExploreResultSchema.safeParse(bad).success).toBe(false);
    });
    it('keeps exploration separate from submitted probes and negotiates optional requests', () => {
        const base = { runId: '11111111-1111-4111-8111-111111111111', round: 0, entryPoints: [], changedPaths: [], diff: '', targets: [], execLeft: 5, observations: [] };
        expect(RunPlanRequestSchema.parse(base)).toEqual(base);
        expect(RunPlanRequestSchema.parse({ ...base, browserExploration: { v: 1, left: 2 }, browserObservations: [{ request, result }] })).toMatchObject({ browserExploration: { v: 1, left: 2 } });
        const explore = { status: 'explore_browser', request, usage: { inputTokens: 0, outputTokens: 0 }, steps: 1 };
        expect(RunPlanResponseSchema.parse(explore)).toEqual(explore);
        expect(RunPlanResponseSchema.safeParse({ ...explore, plan: { probes: [] } }).success).toBe(false);
    });
});

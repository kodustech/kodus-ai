/**
 * The report decides what reaches Discord and whether the notification is red.
 * The old suite reported "infra" as a warning and passed, which is how the PR
 * finder gate stayed green for weeks while measuring nothing. These pin that a
 * night or a Friday that did not measure is never reported as healthy.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { nightlyReport, tier0Report } = require('./ci-report');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyFailure } = require('./tier0-smoke');

function nightlyResult(overrides: Record<string, unknown> = {}) {
    return {
        model: 'deepseek-v4-flash@fireworks',
        cases: 30,
        infraFailures: 0,
        metrics: { recall_mean: 0.45, precision_mean: 0.5 },
        rows: [],
        gate: {
            status: 'pass',
            checks: [{ name: 'recall_mean', actual: 0.45, floor: 0.38, pass: true }],
            observed: { recall_mean: 0.46 },
        },
        ...overrides,
    };
}

describe('nightly report', () => {
    it('is green only when every PR was measured and the gate passed', () => {
        const report = nightlyReport(nightlyResult());
        expect(report.status).toBe('success');
        expect(report.description).toContain('recall 45% (floor 38%, calibrated 46%)');
    });

    it('is red and names the check when quality dropped below the floor', () => {
        const report = nightlyReport(
            nightlyResult({ gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: 0.3, floor: 0.38, pass: false }] } }),
        );
        expect(report.status).toBe('failure');
        expect(report.title).toContain('dropped below the floor');
        expect(report.description).toContain('recall_mean 0.30 < 0.38');
    });

    it('is red when any PR went unmeasured, and says why', () => {
        const report = nightlyReport(
            nightlyResult({ infraFailures: 2, rows: [{ caseId: 'a', status: 'infra', reason: 'judge HTTP 401 invalid x-api-key' }] }),
        );
        expect(report.status).toBe('failure');
        expect(report.title).toContain('2/30 PRs not measured');
        expect(report.description).toContain('judge HTTP 401');
    });

    it('is red when the gate did not run — no floor is not a pass', () => {
        const report = nightlyReport(nightlyResult({ gate: { status: 'skipped', reason: 'no target for model x on set light' } }));
        expect(report.status).toBe('failure');
        expect(report.title).toContain('not gated');
    });

    it('is red when the run never wrote a result', () => {
        expect(nightlyReport(null).status).toBe('failure');
    });

    it('links the engine changes it measured', () => {
        const env = { EVAL_BASE_SHA: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40), GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'kodustech/kodus-ai' };
        expect(nightlyReport(nightlyResult(), env).description).toContain('/compare/aaaaaaaaaaaa...bbbbbbbbbbbb');
    });
});

describe('tier-0 report', () => {
    const pass = (model: string) => ({ model, status: 'pass', toolCalls: 30, findings: 5, seconds: 100, prSummary: { status: 'pass' } });
    const read = (results: Record<string, unknown>) => (model: string) => results[model] || null;

    it('is green when every requested model reviews and summarises', () => {
        const report = tier0Report(['a', 'b'], read({ a: pass('a'), b: pass('b') }));
        expect(report.status).toBe('success');
    });

    it('names the model that no longer reviews', () => {
        const report = tier0Report(['a', 'b'], read({ a: pass('a'), b: { ...pass('b'), status: 'broken', reason: 'no finding parsed' } }));
        expect(report.status).toBe('failure');
        expect(report.title).toContain('b no longer reviews');
    });

    it('treats a broken PR summary as a broken model', () => {
        const report = tier0Report(['a'], read({ a: { ...pass('a'), prSummary: { status: 'broken', reason: 'GATE FAILED' } } }));
        expect(report.status).toBe('failure');
    });

    it('tells key/quota problems apart from a model that broke', () => {
        const report = tier0Report(['a'], read({ a: { ...pass('a'), status: 'infra', reason: 'insufficient balance' } }));
        expect(report.status).toBe('failure');
        expect(report.title).toContain('could not reach a');
    });

    it('reports a model whose job left no result as missing, not as fine', () => {
        const report = tier0Report(['a', 'b'], read({ a: pass('a') }));
        expect(report.status).toBe('failure');
        expect(report.description).toContain('b — review missing');
    });
});

describe('tier-0 failure classification', () => {
    it.each([
        'Incorrect API key provided: sk-...',
        'Your account org-1 is suspended due to insufficient balance',
        'AI_APICallError: Cannot connect to API: connect ECONNREFUSED',
        '429 Too Many Requests',
    ])('provider refusal is infra: %s', (reason) => {
        expect(classifyFailure(reason)).toBe('infra');
    });

    it.each([
        'FindingsOutput failed Zod validation',
        "tool_choice 'required' is incompatible with thinking",
        'agent loop produced zero steps and zero tokens',
    ])('an engine failure on the model is broken: %s', (reason) => {
        expect(classifyFailure(reason)).toBe('broken');
    });
});

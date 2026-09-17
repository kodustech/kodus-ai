/**
 * The report decides what reaches Discord and whether the notification is red.
 * The old suite reported "infra" as a warning and passed, which is how the PR
 * finder gate stayed green for weeks while measuring nothing. These pin that a
 * night or a Friday that did not measure is never reported as healthy, and that
 * the message says what moved and what to do.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { nightlyReport, tier0Report } = require('./ci-report');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyFailure } = require('./tier0-smoke');

const row = (caseId: string, recall: number, found: string[] = [], missed: string[] = []) => ({
    caseId,
    status: 'pass',
    metadata: {
        recall,
        precision: 0.5,
        tpFindings: 1,
        fpFindings: 1,
        totalCalls: 30,
        goldenResults: [...found.map((golden) => ({ golden, found: true })), ...missed.map((golden) => ({ golden, found: false }))],
    },
});

function night(overrides: Record<string, unknown> = {}) {
    return {
        model: 'deepseek-v4-flash@fireworks',
        cases: 2,
        infraFailures: 0,
        startedAt: '2026-09-17T05:00:00Z',
        finishedAt: '2026-09-17T05:21:00Z',
        tokens: { prompt: 1_000_000, completion: 100_000 },
        metrics: { recall_mean: 0.45, precision_mean: 0.5 },
        rows: [row('pr-a', 0.5, ['null deref'], ['race']), row('pr-b', 0.4, ['sql injection'])],
        gate: { status: 'pass', checks: [{ name: 'recall_mean', actual: 0.45, floor: 0.26, pass: true }] },
        ...overrides,
    };
}

const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'kodustech/kodus-ai', GITHUB_RUN_ID: '42' };
const targets = { sets: { light: { models: { 'deepseek-v4-flash@fireworks': { observed: { sdPerPrRunDiff: 0.3, runs: [0.38, 0.35] } } } } } };

describe('nightly report', () => {
    it('is green and short when quality holds', () => {
        const report = nightlyReport(night(), env, { lastGreen: night(), targets });
        expect(report.status).toBe('success');
        expect(report.title).toBe('✅ Evals noturnos: qualidade estável');
        expect(report.description).toContain('Recall **45%** (última noite verde 45% · piso 26%)');
        expect(report.description).not.toContain('Onde mais mudou');
    });

    it('on a drop says how much, where, which known bugs were lost and what to do', () => {
        const lastGreen = night({ rows: [row('pr-a', 1, ['null deref', 'race']), row('pr-b', 0.4, ['sql injection'])], metrics: { recall_mean: 0.7, precision_mean: 0.5 } });
        const tonight = night({ gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: 0.45, floor: 0.5, pass: false }] } });
        const report = nightlyReport(tonight, env, { lastGreen, targets, commits: [{ sha: 'abc1234', subject: 'fix(code-review): x', author: 'dev' }] });
        expect(report.status).toBe('failure');
        expect(report.title).toBe('❌ Evals noturnos: recall caiu 25 pontos, abaixo do piso');
        expect(report.description).toContain('• pr-a 100% → 50%: deixou de achar "race"');
        expect(report.description).toContain('Bugs perdidos: 1 · novos achados: 0');
        expect(report.description).toContain('`abc1234` fix(code-review): x (dev)');
        expect(report.description).toContain('**Próximo passo:** rodar `pnpm eval:nightly`');
    });

    it('names an engine collapse instead of a recall wobble', () => {
        const tonight = night({ gate: { status: 'fail', checks: [{ name: 'mean_findings', actual: 0, floor: 1.3, pass: false }] } });
        expect(nightlyReport(tonight, env, {}).title).toBe('❌ Evals noturnos: o finder parou de produzir findings');
    });

    it("shows the Claude reading as an unverified hypothesis, only on a red night", () => {
        const tonight = night({ gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: 0.2, floor: 0.26, pass: false }] } });
        const investigation = { verdict: 'noise', confidence: 'alta', summary: 'Dentro do ruído.', suspects: [], confirm: 'rodar de novo' };
        expect(nightlyReport(tonight, env, { investigation }).description).toContain('**🤖 Leitura do Claude: provavelmente ruído** (confiança alta, não verificada)');
        expect(nightlyReport(night(), env, { investigation }).description).not.toContain('Leitura do Claude');
    });

    it('is not a quality result when PRs went unmeasured, and says why without blaming the floor', () => {
        const tonight = night({ infraFailures: 2, rows: [{ caseId: 'pr-a', status: 'infra', reason: 'judge HTTP 401 invalid key' }, { caseId: 'pr-b', status: 'infra', reason: 'judge HTTP 401 invalid key' }], gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: null, floor: 0.26, pass: false }] } });
        const report = nightlyReport(tonight, env, {});
        expect(report.status).toBe('failure');
        expect(report.title).toBe('⚠️ Evals noturnos: 2 de 2 PRs não medidos');
        expect(report.description).toContain('Motivo: judge HTTP 401 invalid key');
        expect(report.description).not.toContain('Recall **');
    });

    it('says which key is missing when the run stopped before measuring', () => {
        const report = nightlyReport({ model: 'deepseek-v4-flash@fireworks', error: 'Missing judge key for gpt-5.4-mini (openai): set JUDGE_API_KEY.' }, env, {});
        expect(report.title).toBe('⚠️ Evals noturnos: não mediu');
        expect(report.description).toContain('set JUDGE_API_KEY');
    });

    it('is red when the run never wrote a result or was not gated', () => {
        expect(nightlyReport(null, env, {}).status).toBe('failure');
        expect(nightlyReport(night({ gate: { status: 'skipped', reason: 'judge mismatch' } }), env, {}).title).toBe('⚠️ Evals noturnos: não comparou com o piso');
    });

    it('calls out a rise beyond noise so the floor can be raised', () => {
        const lastGreen = night({ rows: [row('pr-a', 0.1), row('pr-b', 0.1)] });
        expect(nightlyReport(night(), env, { lastGreen, targets }).title).toBe('📈 Evals noturnos: recall subiu 35 pontos');
    });
});

describe('tier-0 report', () => {
    const pass = (model: string) => ({ model, status: 'pass', toolCalls: 30, findings: 5, seconds: 100, prSummary: { status: 'pass' } });
    const read = (results: Record<string, unknown>) => (model: string) => results[model] || null;

    it('is green when every requested model reviews and summarises', () => {
        const report = tier0Report(['a', 'b'], read({ a: pass('a'), b: pass('b') }));
        expect(report.status).toBe('success');
        expect(report.title).toBe('✅ Tier-0: os 2 modelos revisam');
    });

    it('names the model that no longer reviews, apart from one that left no result', () => {
        const report = tier0Report(['a', 'b', 'c'], read({ a: pass('a'), b: { ...pass('b'), status: 'broken', reason: 'no finding parsed' } }));
        expect(report.status).toBe('failure');
        expect(report.title).toBe('❌ Tier-0: 1/3 ok · b não revisa mais · c sem resultado');
    });

    it('treats a broken PR summary as a broken model', () => {
        expect(tier0Report(['a'], read({ a: { ...pass('a'), prSummary: { status: 'broken', reason: 'GATE FAILED' } } })).status).toBe('failure');
    });

    it('tells key/quota problems apart and marks a failure that repeats last week', () => {
        const refused = { ...pass('a'), status: 'infra', reason: 'insufficient balance' };
        const report = tier0Report(['a'], read({ a: refused }), env, read({ a: refused }));
        expect(report.title).toBe('⚠️ Tier-0: 0/1 ok · sem acesso a a');
        expect(report.description).toContain('_(igual à semana passada)_');
    });
});

describe('tier-0 failure classification', () => {
    it.each([
        'Incorrect API key provided: sk-...',
        'agent loop finished with error: API key is invalid. (finishReason=error, steps=0, tokens=0)',
        'no API key for claude-sonnet-4-6 — set one of API_ANTHROPIC_API_KEY/ANTHROPIC_API_KEY/BYOK_ANTHROPIC_API_KEY',
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

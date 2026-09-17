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
        expect(report.title).toBe('✅ Evals · recall 45% · holding');
        expect(report.description).toContain('**Recall** 45% (green: 45%) · **precision** 50% (50%) · floor 26%');
        expect(report.description).not.toContain('Bugs lost');
        expect(report.markdown).toContain('Recall **45%** (last green night 45% · floor 26%)');
        expect(report.markdown).not.toContain('Where it moved most');
    });

    it('on a drop says how much, where, which known bugs were lost and what to do', () => {
        const lastGreen = night({ rows: [row('pr-a', 1, ['null deref', 'race']), row('pr-b', 0.4, ['sql injection'])], metrics: { recall_mean: 0.7, precision_mean: 0.5 } });
        const tonight = night({ gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: 0.45, floor: 0.5, pass: false }] } });
        const report = nightlyReport(tonight, env, { lastGreen, targets, commits: [{ sha: 'abc1234', subject: 'fix(code-review): x', author: 'dev' }] });
        expect(report.status).toBe('failure');
        expect(report.title).toBe('❌ Evals · recall 45% (−25 pts) · floor 50%');
        expect(report.description).toContain('**Bugs lost (1)**\n• pr-a 100→50%: "race"');
        expect(report.description).toContain('**Commits (1)**\n• `abc1234` fix(code-review): x — dev');
        expect(report.markdown).toContain('• pr-a 100% → 50%: no longer finds "race"');
        expect(report.markdown).toContain('`abc1234` fix(code-review): x (dev)');
        expect(report.markdown).toContain('**Next step:** run `pnpm eval:nightly`');
    });

    it('names an engine collapse instead of a recall wobble', () => {
        const tonight = night({ gate: { status: 'fail', checks: [{ name: 'mean_findings', actual: 0, floor: 1.3, pass: false }] } });
        expect(nightlyReport(tonight, env, {}).title).toBe('❌ Evals · finder stopped producing findings');
    });

    it("shows the Claude reading as an unverified hypothesis, only on a red night", () => {
        const tonight = night({ gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: 0.2, floor: 0.26, pass: false }] } });
        const investigation = { verdict: 'noise', confidence: 'high', summary: 'Within the noise.', suspects: [], confirm: 'run it again' };
        expect(nightlyReport(tonight, env, { investigation }).description).toContain('**🤖 Claude** · likely noise · confidence high\nWithin the noise.');
        expect(nightlyReport(tonight, env, { investigation }).markdown).toContain("**🤖 Claude's reading: likely noise** (confidence high, unverified)");
        expect(nightlyReport(night(), env, { investigation }).description).not.toContain('🤖');
    });

    it('is not a quality result when PRs went unmeasured, and says why without blaming the floor', () => {
        const tonight = night({ infraFailures: 2, rows: [{ caseId: 'pr-a', status: 'infra', reason: 'judge HTTP 401 invalid key' }, { caseId: 'pr-b', status: 'infra', reason: 'judge HTTP 401 invalid key' }], gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: null, floor: 0.26, pass: false }] } });
        const report = nightlyReport(tonight, env, {});
        expect(report.status).toBe('failure');
        expect(report.title).toBe('⚠️ Evals · did not measure · judge: invalid key');
        expect(report.markdown).toContain('Reason: judge HTTP 401 invalid key');
        expect(report.markdown).not.toContain('Recall **');
    });

    it('sends credit problems to the provider account, not to the secret', () => {
        const tonight = night({ infraFailures: 2, rows: [{ caseId: 'pr-a', status: 'infra', reason: 'HTTP 402 insufficient balance' }] });
        expect(nightlyReport(tonight, env, {}).description).toContain('**Next step:** top up the Fireworks account.');
    });

    it('says which key is missing when the run stopped before measuring', () => {
        const report = nightlyReport({ model: 'deepseek-v4-flash@fireworks', error: 'Missing judge key for gpt-5.4-mini (openai): set JUDGE_API_KEY.' }, env, {});
        expect(report.title).toBe('⚠️ Evals · did not measure · judge: no key');
        expect(report.markdown).toContain('set JUDGE_API_KEY');
    });

    it('is red when the run never wrote a result or was not gated', () => {
        expect(nightlyReport(null, env, {}).status).toBe('failure');
        expect(nightlyReport(night({ gate: { status: 'skipped', reason: 'judge mismatch' } }), env, {}).title).toBe('⚠️ Evals · not compared with the floor');
    });

    it('calls out a rise beyond noise so the floor can be raised', () => {
        const lastGreen = night({ rows: [row('pr-a', 0.1), row('pr-b', 0.1)] });
        expect(nightlyReport(night(), env, { lastGreen, targets }).title).toBe('📈 Evals · recall 45% (+35 pts)');
    });
});

describe('Discord messages stay scannable', () => {
    it('label every block and bound each line, while keeping the bugs, commits and lead', () => {
        const lastGreen = night({ rows: [row('pr-a', 1, ['null deref', 'race']), row('pr-b', 0.9, ['sql injection'])] });
        const tonight = night({ rows: [row('pr-a', 0.5, ['null deref'], ['race']), row('pr-b', 0.4, [], ['sql injection'])], gate: { status: 'fail', checks: [{ name: 'recall_mean', actual: 0.2, floor: 0.5, pass: false }], confirmation: { runs: [0.2, 0.2] } } });
        const investigation = { verdict: 'regression', confidence: 'medium', summary: 'x'.repeat(400), suspects: [{ commit: 'c1', file: 'libs/a/b/c/finder.agent.ts:190', why: 'y' }], confirm: 'z'.repeat(300) };
        const commits = Array.from({ length: 12 }, (_, i) => ({ sha: `c${i}`, subject: 'x'.repeat(200), author: 'dev' }));
        const { description, title } = nightlyReport(tonight, env, { lastGreen, targets, investigation, commits });
        const lines = description.split('\n');
        expect(title.length).toBeLessThan(60);
        expect(lines.length).toBeLessThanOrEqual(18);
        for (const line of lines.filter((l) => !l.startsWith('['))) expect(line.length).toBeLessThanOrEqual(200);
        expect(description).toContain('"race"');
        expect(description).toContain('• `c0`');
        expect(description).toContain('• +9 in the diff');
        expect(description).toContain('`finder.agent.ts:190`');
        expect(description).not.toMatch(/evals\/investigation\/targets\.json/);
    });
});

describe('tier-0 report', () => {
    const pass = (model: string) => ({ model, status: 'pass', toolCalls: 30, findings: 5, seconds: 100, prSummary: { status: 'pass' } });
    const read = (results: Record<string, unknown>) => (model: string) => results[model] || null;

    it('is green when every requested model reviews and summarises', () => {
        const report = tier0Report(['a', 'b'], read({ a: pass('a'), b: pass('b') }));
        expect(report.status).toBe('success');
        expect(report.title).toBe('✅ Tier-0 · 2/2 models ok');
        expect(report.description).toBe('✅ a · b');
    });

    it('names the model that no longer reviews, apart from one that left no result', () => {
        const report = tier0Report(['a', 'b', 'c'], read({ a: pass('a'), b: { ...pass('b'), status: 'broken', reason: 'no finding parsed' } }));
        expect(report.status).toBe('failure');
        expect(report.title).toBe('❌ Tier-0 · 1/3 models ok');
        expect(report.description).toContain('✅ a\n❌ **b** · review: no findings\n   `no finding parsed` → customers on this model are affected\n❓ **c** · no result, the job crashed');
    });

    it('treats a broken PR summary as a broken model', () => {
        expect(tier0Report(['a'], read({ a: { ...pass('a'), prSummary: { status: 'broken', reason: 'GATE FAILED' } } })).status).toBe('failure');
    });

    it('tells key/quota problems apart and marks a failure that repeats last week', () => {
        const refused = { ...pass('a'), status: 'infra', reason: 'insufficient balance' };
        const report = tier0Report(['a'], read({ a: refused }), env, read({ a: refused }));
        expect(report.title).toBe('⚠️ Tier-0 · 0/1 model ok');
        expect(report.description).toContain('⚠️ **a** · review: no credit (same as last week)');
        expect(report.markdown).toContain('_(same as last week)_');
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

describe('nightly alerting without false positives', () => {
    const targets = { sets: { light: { models: { 'deepseek-v4-flash@fireworks': { observed: { sdPerPrRunDiff: 0.318, runs: [0.384, 0.352] } } } } } };
    const measured = (recall: number, gate: Record<string, unknown>) => ({
        model: 'deepseek-v4-flash@fireworks',
        cases: 1,
        infraFailures: 0,
        metrics: { recall_mean: recall, precision_mean: 0.5 },
        rows: [{ caseId: 'a', status: 'pass', metadata: { recall, precision: 0.5, tpFindings: 1, fpFindings: 0, totalCalls: 20 } }],
        gate,
    });
    const confirmedFail = (recall: number) => ({ status: 'fail', checks: [{ name: 'recall_mean', actual: recall, floor: 0.26, pass: false }], confirmation: { runs: [recall, recall] } });

    it('a first run below the floor that the confirmation does not hold is green and pings nobody', () => {
        const report = nightlyReport(measured(0.3, { status: 'pass', checks: [], confirmation: { runs: [0.24, 0.36] } }), {}, { targets });
        expect(report.verdict).toBe('oscillation');
        expect(report.status).toBe('success');
        expect(report.mention).toBe(false);
        expect(report.title).toBe('⚠️ Evals · dipped, the repeat passed');
        expect(report.markdown).toContain('Two runs on the same commit: 24% and 36%');
    });

    it('a confirmed new drop pings and starts a streak', () => {
        const report = nightlyReport(measured(0.2, confirmedFail(0.2)), {}, { targets, today: '2026-09-18' });
        expect(report).toMatchObject({ verdict: 'regression', mention: true, state: { verdict: 'regression', streak: 1, since: '2026-09-18' } });
    });

    it('the same drop the next night stays red without pinging', () => {
        const previousState = { verdict: 'regression', recall: 0.2, streak: 1, since: '2026-09-18' };
        const report = nightlyReport(measured(0.19, confirmedFail(0.19)), {}, { targets, previousState, today: '2026-09-19' });
        expect(report.title).toBe('❌ Evals · still below the floor · day 2');
        expect(report).toMatchObject({ verdict: 'still-red', mention: false, state: { streak: 2, since: '2026-09-18' } });
    });

    it('a drop that gets worse beyond noise pings again', () => {
        const previousState = { verdict: 'still-red', recall: 0.2, streak: 2, since: '2026-09-18' };
        const report = nightlyReport(measured(0.1, confirmedFail(0.1)), {}, { targets, previousState, today: '2026-09-20' });
        expect(report).toMatchObject({ verdict: 'regression', mention: true, state: { streak: 3, since: '2026-09-18' } });
        expect(report.title).toBe('❌ Evals · worse · recall 10% · day 3');
    });

    it('a confirmation that could not measure confirms nothing and pings nobody', () => {
        const report = nightlyReport({ ...measured(0.2, { status: 'fail', checks: [] }), confirmationError: 'judge HTTP 429' }, {}, { targets });
        expect(report).toMatchObject({ verdict: 'infra', mention: false, state: { streak: 0 } });
    });

    it('a finder that collapses during a red streak still pings, once', () => {
        const collapsed = (recall: number) => ({ status: 'fail', checks: [{ name: 'recall_mean', actual: recall, floor: 0.26, pass: false }, { name: 'mean_tool_calls', actual: 2, floor: 20, pass: false }] });
        const previousState = { verdict: 'regression', recall: 0.2, streak: 1, since: '2026-09-18', failed: ['recall_mean'] };
        const report = nightlyReport(measured(0.19, collapsed(0.19)), {}, { targets, previousState, today: '2026-09-19' });
        expect(report).toMatchObject({ verdict: 'regression', mention: true, state: { streak: 2, failed: ['recall_mean', 'mean_tool_calls'] } });
        expect(report.title).toBe('❌ Evals · finder stopped using tools · day 2');
        const next = nightlyReport(measured(0.19, collapsed(0.19)), {}, { targets, previousState: report.state, today: '2026-09-20' });
        expect(next).toMatchObject({ verdict: 'still-red', mention: false });
    });

    it("never lowers an alert because of the agent's reading", () => {
        const investigation = { verdict: 'noise', confidence: 'high', summary: 'Noise.', suspects: [], confirm: '' };
        const report = nightlyReport(measured(0.2, confirmedFail(0.2)), {}, { targets, investigation });
        expect(report).toMatchObject({ verdict: 'regression', status: 'failure', mention: true });
    });
});

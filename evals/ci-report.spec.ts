/**
 * The report decides what reaches Discord and whether the notification is red.
 * The old suite reported "infra" as a warning and passed, which is how the PR
 * finder gate stayed green for weeks while measuring nothing. These pin that a
 * night or a Friday that did not measure is never reported as healthy, and that
 * the message says what moved and what to do.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { nightlyReport, tier0Report } = require('./ci-report');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyFailure, runFewCases, tier0Signal } = require('./tier0-smoke');

const row = (caseId: string, recall: number, found: string[] = [], missed: string[] = []) => ({
    caseId,
    status: 'pass',
    metadata: {
        recall,
        precision: 0.5,
        tpFindings: 1,
        fpFindings: 1,
        toolCalls: 30,
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
    const pass = (model: string) => ({ model, status: 'pass', toolCalls: 30, findings: 5, seconds: 100, evals: [{ stage: 'pr-summary', key: 'pr_summary', status: 'pass' }] });
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

    it('names a stage that no longer runs on the model, after a review that passed', () => {
        const stages = [
            { key: 'pr_summary', stage: 'pr-summary', status: 'pass', reason: null },
            { key: 'kody_rules', stage: 'kody-rules', status: 'broken', reason: 'measured 4 cases and got nothing right' },
            { key: 'reply_addressing', stage: 'reply-addressing', status: 'pass', reason: null },
        ];
        const report = tier0Report(['a'], read({ a: { ...pass('a'), evals: stages } }));
        expect(report.status).toBe('failure');
        expect(report.description).toContain('❌ **a** · kody-rules: measured 4 cases and got nothing right');
        expect(report.description).toContain('measured 4 cases and got nothing right\n   customers on this model are affected');
        expect(report.markdown).toContain('❌ **a**: review ok (30 tool calls, 5 findings, 100s) · pr-summary ok · kody-rules broken · reply-addressing ok');
    });

    it('treats a broken PR summary as a broken model', () => {
        expect(tier0Report(['a'], read({ a: { ...pass('a'), evals: [{ stage: 'pr-summary', key: 'pr_summary', status: 'broken', reason: 'GATE FAILED' }] } })).status).toBe('failure');
    });

    it('tells key/quota problems apart and marks a failure that repeats last week', () => {
        const refused = { ...pass('a'), status: 'infra', reason: 'insufficient balance' };
        const report = tier0Report(['a'], read({ a: refused }), env, read({ a: refused }));
        expect(report.title).toBe('⚠️ Tier-0 · 0/1 model ok');
        expect(report.description).toContain('⚠️ **a** · review: no credit (same as last week)');
        expect(report.markdown).toContain('_(same as last week)_');
    });
});

describe('tier-0 stages on a few cases', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier0-few-'));
    // A stand-in eval: writes the shared result its data file holds, prints its
    // stdout and stderr, and exits with `exit` (0 with a result, else 1).
    const runner = path.join(dir, 'fake-eval.js');
    fs.writeFileSync(
        runner,
        [
            "const fs = require('fs');",
            "const arg = (k) => (process.argv.find((a) => a.startsWith('--' + k + '=')) || '').slice(k.length + 3);",
            "const data = JSON.parse(fs.readFileSync(arg('data'), 'utf8'));",
            "if (data.result) fs.writeFileSync(arg('output'), JSON.stringify(data.result));",
            'console.log(data.stdout);',
            'console.error(data.stderr);',
            'process.exit(data.exit ?? (data.result ? 0 : 1));',
        ].join('\n'),
    );
    const fake = (name: string, result: unknown, stderr = '', stdout = '', exit?: number) => {
        const data = path.join(dir, `${name}.json`);
        fs.writeFileSync(data, JSON.stringify({ result, stderr, stdout, exit }));
        return { key: name, stage: name, run: [runner, `--data=${data}`] };
    };
    const shared = (hits: number, errored = 0, total = 10) => ({ cases: [{ id: 'c1', checks: 'Checks c1', hits, total: 2 }], infra: { errored, total } });

    it('runs when it measured and got something right; is broken when it got nothing right', () => {
        expect(runFewCases('m', fake('ok', shared(1)), dir)).toMatchObject({ status: 'pass', hits: 1, total: 2 });
        expect(runFewCases('m', fake('none', shared(0)), dir)).toMatchObject({ status: 'broken', reason: 'measured 1 cases and got nothing right' });
    });

    it('tells a provider refusal from a stage that fails on the model when calls failed', () => {
        expect(runFewCases('m', fake('refused', shared(1, 5), '429 Too Many Requests'), dir)).toMatchObject({ status: 'infra' });
        expect(runFewCases('m', fake('noverdict', shared(1, 5), 'Reply classifier returned no verdict'), dir)).toMatchObject({ status: 'broken', reason: '5 of 10 calls failed: Reply classifier returned no verdict' });
        expect(runFewCases('m', fake('crash', null, 'TypeError: x is not a function'), dir)).toMatchObject({ status: 'broken', reason: 'TypeError: x is not a function' });
    });

    // Kody Rules says only that its rule checks failed to run; the engine's own
    // [LLM-ERROR] log line says why.
    it('reads a provider refusal from the engine\'s LLM error log when the eval hides it', () => {
        const hidden = '[case a run 0] Kody Rules could not be evaluated: all 4 rule check(s) failed to run.\n[case b run 0] Kody Rules could not be evaluated: all 4 rule check(s) failed to run.';
        const credit = 'WARN: [LLM-ERROR] kodus-rules-review-agent.shard: "managed-default" failed (QUOTA_EXCEEDED) — Your credit balance is too low';
        // One refused call per failed one, as the engine logs them.
        const each = (line: string) => Array.from({ length: 10 }, () => line).join('\n');
        expect(runFewCases('m', fake('credit', shared(0, 10), hidden, each(`\x1b[33m${credit}\x1b[39m`)), dir)).toMatchObject({ status: 'infra', reason: '10 of 10 calls failed: Your credit balance is too low' });
        const ciLine = JSON.stringify({ level: 'warn', context: 'runWithModelFailover', msg: '[LLM-ERROR] code-review: "managed-default" failed (QUOTA_EXCEEDED) — Your credit balance is too low' });
        expect(runFewCases('m', fake('credit-json', shared(0, 10), hidden, each(ciLine)), dir)).toMatchObject({ status: 'infra', reason: '10 of 10 calls failed: Your credit balance is too low' });
        const unsupported = 'WARN: [LLM-ERROR] kodus-rules-review-agent.shard: "managed-default" failed (UNKNOWN) — Function tools with reasoning_effort are not supported';
        expect(runFewCases('m', fake('unsupported', shared(0, 10), hidden, unsupported), dir)).toMatchObject({ status: 'broken' });
        // One rate-limited call among calls that failed for another reason: broken.
        const oneRateLimit = 'WARN: [LLM-ERROR] classifyImplicitReply: "managed-default" failed (RATE_LIMIT) — 429 Too Many Requests';
        const noVerdict = Array.from({ length: 9 }, (_, i) => `c${i}#0: Reply classifier returned no verdict`).join('\n');
        expect(runFewCases('m', fake('mixed', shared(0, 10), noVerdict, oneRateLimit, 2), dir)).toMatchObject({ status: 'broken', reason: '10 of 10 calls failed: Reply classifier returned no verdict' });
    });

    // Each eval holds its own budget: it exits 2 above it. Kody Rules exits 2 only
    // under --gate, so at least half the calls must have run.
    it('takes the eval\'s own word on whether it measured', () => {
        expect(runFewCases('m', fake('one-of-four', shared(1, 1, 4)), dir)).toMatchObject({ status: 'pass' });
        expect(runFewCases('m', fake('half', shared(1, 2, 4), '[case a run 0] Kody Rules could not be evaluated'), dir)).toMatchObject({ status: 'broken' });
        const oneRefused = 'reply-addressing: 16 cases\nc1#0: 429 Too Many Requests\n❌ INFRA ERROR: 1/16 calls failed (budget 0)';
        expect(runFewCases('m', fake('one-refused', shared(1, 1, 16), oneRefused, '', 2), dir)).toMatchObject({ status: 'infra', reason: '1 of 16 calls failed: 429 Too Many Requests' });
    });

    it('names the error most calls failed with, not the eval\'s summary line', () => {
        const noVerdict = 'reply-addressing: 2 cases\nc1#0: Reply classifier returned no verdict\nc2#0: Reply classifier returned no verdict\n❌ INFRA ERROR: 2/2 calls failed (budget 0)';
        expect(runFewCases('m', fake('noverdict2', shared(0, 10), noVerdict), dir)).toMatchObject({ status: 'broken', reason: '10 of 10 calls failed: Reply classifier returned no verdict' });
        const refused = '[case a run 0] 429 Too Many Requests\n[case b run 0] 429 Too Many Requests\n❌ INFRA ERROR: 2/2 calls failed';
        expect(runFewCases('m', fake('refused2', shared(0, 10), refused), dir)).toMatchObject({ status: 'infra', reason: '10 of 10 calls failed: 429 Too Many Requests' });
    });
});

describe('tier-0 signal', () => {
    const result = (review: string, ...parts: string[]) => ({ status: review, seconds: 12, evals: parts.map((status, i) => ({ key: `p${i}`, status })) });

    // The panel's row for the model: the worst part decides, the review included.
    it('is red when any part is broken, infra when one was not reached, green only when all ran', () => {
        expect(tier0Signal(result('pass', 'pass', 'pass', 'pass'))).toMatchObject({ status: 'green', value: '12000', meta: { review: 'pass', p0: 'pass', p1: 'pass', p2: 'pass' } });
        expect(tier0Signal(result('broken', 'pass', 'infra', 'pass')).status).toBe('red');
        expect(tier0Signal(result('pass', 'pass', 'broken', 'infra')).status).toBe('red');
        expect(tier0Signal(result('pass', 'infra', 'pass', 'pass')).status).toBe('infra');
        expect(tier0Signal(result('infra', 'pass', 'pass', 'pass')).status).toBe('infra');
        expect(tier0Signal(result('pass')).status).toBe('green');
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
        'This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 470.',
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
        rows: [{ caseId: 'a', status: 'pass', metadata: { recall, precision: 0.5, tpFindings: 1, fpFindings: 0, toolCalls: 20 } }],
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

    it('a slide in noise-sized steps still pings, measured from where the streak started', () => {
        const first = nightlyReport(measured(0.2, confirmedFail(0.2)), {}, { targets, today: '2026-09-18' });
        expect(first).toMatchObject({ mention: true, state: { alertedRecall: 0.2 } });
        // One step below the noise: the same drop, no second ping.
        const second = nightlyReport(measured(0.16, confirmedFail(0.16)), {}, { targets, previousState: first.state, today: '2026-09-19' });
        expect(second).toMatchObject({ verdict: 'still-red', mention: false, state: { alertedRecall: 0.2, recall: 0.16 } });
        // Two steps: noise-sized against last night, a real slide against the alert.
        const third = nightlyReport(measured(0.12, confirmedFail(0.12)), {}, { targets, previousState: second.state, today: '2026-09-20' });
        expect(third).toMatchObject({ verdict: 'regression', mention: true, state: { alertedRecall: 0.12 } });
        // The ping moved the anchor: the same recall is the same drop, not a new one.
        const fourth = nightlyReport(measured(0.12, confirmedFail(0.12)), {}, { targets, previousState: third.state, today: '2026-09-21' });
        expect(fourth).toMatchObject({ verdict: 'still-red', mention: false, state: { alertedRecall: 0.12 } });
    });

    it('counts a PR whose output did not parse as unmeasured, not as a score', () => {
        const scored = (caseId: string, recall: number) => ({ caseId, status: 'pass', metadata: { recall, precision: 0.5, tpFindings: 1, fpFindings: 0, toolCalls: 20 } });
        const night = {
            model: 'deepseek-v4-flash@fireworks',
            cases: 3,
            infraFailures: 0,
            infraBudget: 1,
            metrics: { recall_mean: 0.4, precision_mean: 0.5 },
            // 'c' failed to parse: status 'fail', empty metadata, never infra.
            rows: [scored('a', 0.4), scored('b', 0.4), { caseId: 'c', status: 'fail', metadata: {} }],
            gate: { status: 'pass', checks: [{ name: 'recall_mean', actual: 0.4, floor: 0.26, pass: true }] },
        };
        const report = nightlyReport(night, {}, { targets });
        expect(report.description).toContain('2/3 PRs (1 not measured)');
        // One more than the budget and the night is not a quality result.
        const worse = { ...night, cases: 3, infraBudget: 0 };
        expect(nightlyReport(worse, {}, { targets }).verdict).toBe('infra');
    });

    it('keeps the night when a couple of PRs go unmeasured, and says so', () => {
        const withInfra = (infraFailures: number, infraBudget: number) => ({
            ...measured(0.4, { status: 'pass', checks: [{ name: 'recall_mean', actual: 0.4, floor: 0.26, pass: true }] }),
            cases: 30,
            infraFailures,
            infraBudget,
        });
        const inside = nightlyReport(withInfra(2, 2), {}, { targets });
        expect(inside.verdict).toBe('pass');
        expect(inside.description).toContain('28/30 PRs (2 not measured)');
        expect(nightlyReport(withInfra(3, 2), {}, { targets }).verdict).toBe('infra');
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

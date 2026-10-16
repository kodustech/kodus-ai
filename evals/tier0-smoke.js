#!/usr/bin/env node
// Tier-0 smoke — one real review per model, no judge. Runs Friday with the
// release train, so a model that stopped working is known before the 10h call.
//
// Quality is measured nightly on ONE model (DeepSeek, 30 PRs): an engine
// regression shows on any model, so measuring all of them nightly bought
// nothing but cost. What does differ per model is whether the agent loop still
// WORKS on it — tool calling, structured output, the done tool, reasoning
// params — and the contract tests only make single-step calls with no tools.
// This covers that gap: the real finder on one replayed PR with known bugs.
//
//   node evals/tier0-smoke.js --model=gpt-5.4 [--case=<caseId>]
//
// Passes when the loop finishes, engages the tools and returns at least one
// parsed finding. It does not ask whether the findings are right.
//
// Then every other stage the nightly measures, each on a few of its cases
// (FEW_CASES): the nightly asks whether a change broke it on one model, this
// asks whether it still runs on each. Its outcome goes under the stage's
// `friday` key (evals/stages.js). The PR summary is one of them, gated on its
// whole contract: summaries died in prod once for a single model while reviews
// kept working.
//
// Exit: 0 pass / 1 the model no longer runs one of them / 2 infra (key, quota,
// rate limit, network — the provider refused, not the engine).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { STAGES } = require('./stages');
const { NIGHTLY_EVALS } = require('./nightly-evals');

const DEFAULT_CASE = 'add-guest-management-functionality-to-existing-bookings-cal-com';
// Every tier-0 model made 28+ tool calls on average on this set
// (targets.json observed.meanToolCalls); fewer than this means tools are dead.
const MIN_TOOL_CALLS = 3;
const MIN_FINDINGS = 1;
const RETRY_DELAY_MS = 60 * 1000;
const INFRA = /\b(401|403|429|402)\b|unauthori[sz]ed|no api key|(invalid|incorrect|missing|expired).{0,20}(api.?key|x-api-key|token|credential)|(api.?key|x-api-key|token|credential).{0,20}(invalid|incorrect|expired|revoked)|suspended|permission.?denied|quota|rate.?limit|insufficient|billing|credit balance|exceeded your|more credits|can only afford|cannot connect|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|overloaded|\b50[234]\b/i;
const ROOT = path.join(__dirname, '..');

// The stages the nightly measures beyond the review, each cut to a few cases.
// Kody Rules keeps its own nightly job; the rest come from evals/nightly-evals.js.
const FEW_CASES = [
    { stage: 'kody-rules', run: ['evals/kody-rules/real-agent.js', '--dataset=github-cases', '--runs=1', '--limit=4'] },
    ...NIGHTLY_EVALS.map((e) => ({ stage: e.stage, run: [...e.run, ...e.friday] })),
].map((e) => ({ ...e, key: (STAGES.find((s) => s.id === e.stage) || {}).friday }));

// The keys this check writes, one per stage it covers.
const fridayKeys = () => ['review', ...FEW_CASES.map((e) => e.key)];

function parseArgs(argv) {
    return Object.fromEntries(
        argv.slice(2).map((a) => {
            const m = a.match(/^--([^=]+)(?:=(.*))?$/);
            return m ? [m[1], m[2] ?? true] : [a, true];
        }),
    );
}

function loadCase(caseId) {
    const dir = path.join(__dirname, 'investigation', 'datasets');
    // Datasets are named after their case id; scan the rest only if that misses.
    const named = `${caseId}.json`;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const file of [named, ...files.filter((f) => f !== named)].filter((f) => files.includes(f))) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            const c = Array.isArray(raw) ? raw[0] : raw;
            if (c?.vars?.caseId === caseId) return c.vars;
        } catch {
            /* unreadable dataset — not the one we want */
        }
    }
    return null;
}

// A dataset with unparseable goldens must not replace the real failure reason.
function knownBugs(vars) {
    try {
        const goldens = typeof vars.goldenComments === 'string' ? JSON.parse(vars.goldenComments) : vars.goldenComments;
        return Array.isArray(goldens) ? goldens.length : '?';
    } catch {
        return '?';
    }
}

// The provider refused (key, quota, network) → infra; anything else means the
// engine could not run the review on this model → broken.
function classifyFailure(reason) {
    return INFRA.test(String(reason || '')) ? 'infra' : 'broken';
}

// The error a failed eval run stands for: among the lines its calls printed
// (`id#0: …`, `[case … run 0] …`), the one most of them failed with; the eval's
// own summary ("1/16 calls failed") never names the cause. Without such lines,
// the first line naming an error.
const CALL_PREFIX = /^(\[[^\]]*\]|\S+#\d+:)\s*/;
function errorLine(lines) {
    const calls = lines.filter((l) => CALL_PREFIX.test(l)).map((l) => l.replace(CALL_PREFIX, ''));
    if (calls.length) {
        const counts = new Map();
        for (const c of calls) counts.set(c, (counts.get(c) || 0) + 1);
        return [...counts].sort((a, b) => b[1] - a[1])[0][0];
    }
    return lines.find((l) => /error|failed|refused/i.test(l)) || lines[lines.length - 1] || '';
}

// The engine logs every failed LLM call as `[LLM-ERROR] <run>: "<model>" failed
// (<CATEGORY>) — <message>` (libs/llm/model-failover.ts). A provider refusal
// there is infra even when the eval's own error hides it: Kody Rules reports
// only that its rule checks "failed to run".
const PROVIDER_REFUSAL = /\[LLM-ERROR\].* failed \((AUTH_INVALID|QUOTA_EXCEEDED|RATE_LIMIT|TRANSIENT|MODEL_ACCESS_DENIED)\) — (.*)$/;

// The log line's message: pino writes JSON under CI and colored text on a terminal.
function logMessage(line) {
    // eslint-disable-next-line no-control-regex
    const text = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!text.startsWith('{')) return text;
    try {
        const entry = JSON.parse(text);
        return String(entry.msg ?? entry.message ?? '');
    } catch {
        return text;
    }
}

function providerRefusals(stdout) {
    return String(stdout || '')
        .split('\n')
        .map((line) => logMessage(line).match(PROVIDER_REFUSAL))
        .filter(Boolean)
        .map((m) => m[2]);
}

// The evals.tier0.<model> signal for one model's result: red when any part is
// broken (the review included), infra when one was not reached, else green.
// Its meta carries each part's outcome under its `friday` key, which the panel
// reads per stage.
function tier0Signal(r) {
    const parts = Object.fromEntries((r.evals || []).map((e) => [e.key, e.status]));
    const all = [r.status, ...Object.values(parts)];
    const status = all.includes('broken') ? 'red' : all.includes('infra') || r.status !== 'pass' ? 'infra' : 'green';
    return {
        status,
        value: r.seconds == null ? '' : String(Math.round(r.seconds * 1000)),
        meta: { review: r.status, ...parts, reason: r.reason || null, findings: r.findings, tool_calls: r.toolCalls, retried: !!r.retried },
    };
}

// One stage's eval on a few cases: it runs on this model when the eval says it
// measured (exit 0; each eval holds its own budget of failed calls, exit 2
// above it, evals/AGENTS.md), at least half its calls ran (Kody Rules exits 2
// only under --gate; its nightly verdict reads the same half), and it got at
// least one item right. The number is reported, never compared with a floor:
// floors are calibrated on the full set.
function runFewCases(model, part, outDir = path.join(__dirname, 'investigation', 'results')) {
    fs.mkdirSync(outDir, { recursive: true });
    const output = path.join(outDir, `tier0-part-${part.key}-${model.replace(/[^\w.-]+/g, '-')}.json`);
    fs.rmSync(output, { force: true });
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.resolve(ROOT, part.run[0]), ...part.run.slice(1), `--model=${model}`, `--output=${output}`], {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
        timeout: 30 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    let result = null;
    try {
        result = JSON.parse(fs.readFileSync(output, 'utf8'));
    } catch {
        /* no result: the run crashed before writing it */
    }
    const cases = Array.isArray(result?.cases) ? result.cases : [];
    const hits = cases.reduce((n, c) => n + (c.hits || 0), 0);
    const total = cases.reduce((n, c) => n + (c.total || 0), 0);
    const base = { key: part.key, stage: part.stage, seconds, hits, total };
    const { errored = 0, total: calls = 0 } = result?.infra || {};
    if (!result || r.status !== 0 || !calls || errored / calls >= 0.5) {
        // Only stderr: stdout echoes case ids and texts, which can look like a provider error.
        const printed = errorLine(String(r.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean));
        // Refusals explain the run only when there are as many as failed calls:
        // one 429 among calls that failed for another reason is not the cause.
        const refusals = classifyFailure(printed) === 'infra' ? [] : providerRefusals(r.stdout);
        const refusal = refusals.length && refusals.length >= errored ? refusals[0] : null;
        const error = refusal || printed;
        const reason = result ? `${errored} of ${calls} calls failed: ${error || 'no error printed'}` : error || `exit ${r.status}${r.signal ? ` (${r.signal})` : ''}`;
        return { ...base, status: refusal ? 'infra' : classifyFailure(printed), reason };
    }
    if (!hits) return { ...base, status: 'broken', reason: `measured ${cases.length} cases and got nothing right` };
    return { ...base, status: 'pass', reason: null };
}

async function main() {
    const args = parseArgs(process.argv);
    const model = args.model;
    const caseId = args.case || DEFAULT_CASE;
    if (!model || model === true) {
        console.error('usage: node evals/tier0-smoke.js --model=<tier-0 id> [--case=<caseId>]');
        return 2;
    }

    const vars = loadCase(caseId);
    if (!vars) {
        console.error(`case not found in evals/investigation/datasets: ${caseId}`);
        return 2;
    }

    process.env.RECALL_MODEL = model;
    const InvestigationAgentProvider = require('./investigation/agent-provider');
    const provider = new InvestigationAgentProvider({
        config: { label: `${model}-tier0-smoke`, provider: 'tier0', model },
    });

    const started = Date.now();
    let result = await provider.callApi(JSON.stringify(vars), { vars }, {});
    // One retry when the provider refused: Moonshot and Z.ai answer "engine
    // overloaded" in bursts, and a Friday alarm for a busy minute helps nobody.
    // A refusal that survives the retry is reported.
    let retried = false;
    if (!result.output && classifyFailure(result.error) === 'infra') {
        console.log(`⚠️ ${model} review refused (${String(result.error).slice(0, 160)}) — retrying once in ${RETRY_DELAY_MS / 1000}s`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        result = await provider.callApi(JSON.stringify(vars), { vars }, {});
        retried = true;
    }
    const seconds = Math.round((Date.now() - started) / 1000);

    const summary = { model, caseId, seconds, retried, status: 'pass', reason: null, findings: null, toolCalls: null, tokens: result.tokenUsage || null };
    if (!result.output) {
        const reason = String(result.error || 'provider returned no output');
        summary.status = classifyFailure(reason);
        summary.reason = `${reason} (stage=${result.metadata?.stage || 'unknown'})`;
    } else {
        const output = JSON.parse(result.output);
        summary.findings = Array.isArray(output.findings) ? output.findings.length : 0;
        // The tool calls the agent loops made on the sandbox (agent-provider trace).
        summary.toolCalls = Array.isArray(output.trace?.toolCalls) ? output.trace.toolCalls.length : 0;
        if (summary.toolCalls < MIN_TOOL_CALLS) {
            summary.status = 'broken';
            summary.reason = `only ${summary.toolCalls} tool call(s) — the loop is not using its tools`;
        } else if (summary.findings < MIN_FINDINGS) {
            summary.status = 'broken';
            summary.reason = `no finding parsed on a PR with ${knownBugs(vars)} known bugs (finishReason=${output.trace?.finishReason})`;
        }
    }

    const icon = { pass: '✅', broken: '❌', infra: '⚠️' };
    console.log(
        `${icon[summary.status]} ${model} review: ${summary.status} in ${seconds}s · tool calls=${summary.toolCalls ?? 'n/a'} · findings=${summary.findings ?? 'n/a'}${summary.reason ? ` — ${summary.reason}` : ''}`,
    );

    summary.evals = [];
    for (const part of FEW_CASES) {
        let outcome = runFewCases(model, part);
        // The same one retry as the review, for the same bursts.
        if (outcome.status === 'infra') {
            console.log(`⚠️ ${model} ${part.key} refused (${String(outcome.reason).slice(0, 160)}) — retrying once in ${RETRY_DELAY_MS / 1000}s`);
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            outcome = { ...runFewCases(model, part), retried: true };
        }
        summary.evals.push(outcome);
        console.log(`${icon[outcome.status]} ${model} ${part.key}: ${outcome.status} in ${outcome.seconds}s · ${outcome.hits}/${outcome.total} right${outcome.reason ? ` — ${outcome.reason}` : ''}`);
    }

    const outDir = path.join(__dirname, 'investigation', 'results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `tier0-smoke-${model.replace(/[^\w.-]+/g, '-')}.json`), JSON.stringify(summary, null, 2));

    // A model that cannot review is worse news than one we could not reach.
    const outcomes = [summary.status, ...summary.evals.map((e) => e.status)];
    if (outcomes.includes('broken')) return 1;
    if (outcomes.includes('infra')) return 2;
    return 0;
}

module.exports = { classifyFailure, fridayKeys, runFewCases, tier0Signal, FEW_CASES };

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

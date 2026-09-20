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
// parsed finding. It does not ask whether the findings are right. It also runs
// the PR-summary eval on the model (one call per case): summaries died in prod
// once for a single model while reviews kept working.
//
// Exit: 0 pass / 1 the model no longer runs the review or the summary / 2 infra
// (key, quota, rate limit, network — the provider refused, not the engine).
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_CASE = 'add-guest-management-functionality-to-existing-bookings-cal-com';
// Every tier-0 model made 28+ tool calls on average on this set
// (targets.json observed.meanToolCalls); fewer than this means tools are dead.
const MIN_TOOL_CALLS = 3;
const MIN_FINDINGS = 1;
const RETRY_DELAY_MS = 60 * 1000;
const INFRA = /\b(401|403|429|402)\b|unauthori[sz]ed|no api key|(invalid|incorrect|missing|expired).{0,20}(api.?key|x-api-key|token|credential)|(api.?key|x-api-key|token|credential).{0,20}(invalid|incorrect|expired|revoked)|suspended|permission.?denied|quota|rate.?limit|insufficient|billing|credit balance|exceeded your|cannot connect|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|overloaded|\b50[234]\b/i;

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

// pr-summary/run.js already separates its outcomes: 0 pass / 1 gate / 2 infra.
function runPrSummary(model) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'pr-summary', 'run.js'), `--model=${model}`, '--gate'], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        encoding: 'utf8',
        timeout: 15 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const status = r.status === 0 ? 'pass' : r.status === 2 ? 'infra' : 'broken';
    const detail = out.split('\n').filter((l) => /cases:|GATE FAILED|infra/i.test(l)).map((l) => l.trim()).slice(-2).join(' · ');
    return { status, reason: status === 'pass' ? null : detail || `exit ${r.status}` };
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
        summary.toolCalls = output.trace?.replayCalls ?? 0;
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

    summary.prSummary = args['no-pr-summary'] ? { status: 'skipped', reason: null } : runPrSummary(model);
    if (summary.prSummary.status !== 'skipped') {
        console.log(`${icon[summary.prSummary.status]} ${model} pr-summary: ${summary.prSummary.status}${summary.prSummary.reason ? ` — ${summary.prSummary.reason}` : ''}`);
    }

    const outDir = path.join(__dirname, 'investigation', 'results');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `tier0-smoke-${model.replace(/[^\w.-]+/g, '-')}.json`), JSON.stringify(summary, null, 2));

    // A model that cannot review is worse news than one we could not reach.
    const outcomes = [summary.status, summary.prSummary.status];
    if (outcomes.includes('broken')) return 1;
    if (outcomes.includes('infra')) return 2;
    return 0;
}

module.exports = { classifyFailure };

if (require.main === module) {
    main()
        .then((code) => process.exit(code))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
}

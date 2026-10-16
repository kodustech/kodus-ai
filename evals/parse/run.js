#!/usr/bin/env node
// parse: replays how the finder's runs ended, as models sent it, through the
// engine's own parse — `extractFindingsWithRecovery` (structured submitResult,
// then JSON in the run's text, then the prose recovery call) and
// `mapAgentFindings` — and counts the written findings that come out right.
// The run ends are recorded model output (capture.js); the shapes production
// lost (#2112, shapes.js) are applied to one of them. Only prose recovery calls
// the model: the rest is deterministic.
//
//   node evals/parse/run.js [--model=<id>] [--gate] [--output=<result.json>] [--prose] [--limit=N] [--concurrency=N]
//
// --model        the model the prose recovery runs on (the nightly model by default)
// --prose        only the cases that reach prose recovery (the Friday cut)
// --concurrency  cases run at once (8): recovery calls take seconds each
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { applyModelEnv } = require('../shared/tier0-models');
const { countTokens, tokensUsed, withCallErrors } = require('../shared/eval-kit');
const { evalQuestion, resultProblems } = require('../shared/eval-result');
const { SHAPES } = require('./shapes');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const MODEL = args.model || 'deepseek-v4-flash@fireworks';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
const cases = require('./cases.json')
    .filter((c) => !args.prose || c.prose)
    .slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
applyModelEnv(MODEL);
countTokens();
const { extractFindingsWithRecovery, recoverFindingsFromProse } = require('../../libs/code-review/infrastructure/agents/core/finder.agent.ts');
const { mapAgentFindings } = require('../../libs/code-review/infrastructure/agents/collaborators/finding-mapper.ts');
const { classifyLLMError, LlmErrorCategory } = require('../../libs/llm/error-classifier.ts');

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const norm = (f) => text(f).replace(/\\/g, '/').replace(/^\.?\/+/, '');

// What the runner stores as the artifact: a string input is parsed, as
// `parseArtifactInput` does (libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts).
function asArtifact(input) {
    if (typeof input !== 'string') return input;
    try {
        return JSON.parse(input);
    } catch {
        return input;
    }
}

// The object a model wrote as its answer text, fenced or not.
function fromText(answer) {
    const fenced = String(answer || '').match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : String(answer || '');
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(body.slice(start, end + 1));
    } catch {
        return null;
    }
}

// The findings the model wrote, whatever their shape on the wire.
function written(payload) {
    let items = payload?.suggestions;
    if (typeof items === 'string') {
        try {
            items = JSON.parse(items);
        } catch {
            items = [];
        }
    }
    return Array.isArray(items) ? items.filter((s) => s && typeof s === 'object' && !('$text' in s)) : [];
}

// The object a run end carries: its submitResult, or the JSON it answered in text.
const payloadOf = (end) => (end.submitResult === undefined ? fromText(end.text) : asArtifact(end.submitResult));

// The prose recovery as production wires it (core-agent-loop.adapter.ts), on
// the eval's model. It swallows a failed call and returns []. When the provider
// refused (key, quota, rate, outage) the case did not measure; an answer that
// did not fit the schema is the recovery losing the findings, as in production.
const REFUSED = new Set(['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED', 'TRANSIENT'].map((c) => LlmErrorCategory[c]));
async function recover(reasoning) {
    const { result: out, errors } = await withCallErrors(() => recoverFindingsFromProse(reasoning, undefined, 'parse-eval', 'parse-eval'));
    // An answer that came back but did not fit is never a refusal; the
    // classifier reads the whole error text, which then holds the model's answer.
    const answered = (e) => e?.name === 'AI_NoObjectGeneratedError' || /^No object generated/.test(String(e?.message));
    const refusal = errors.find((e) => !answered(e) && REFUSED.has(classifyLLMError(e).category));
    if (!out.length && refusal) throw new Error(`prose recovery call refused: ${String(refusal?.message || refusal).slice(0, 200)}`);
    return out;
}

// The PR's changed files, as the review passes them to the mapper.
function prFiles(caseId) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const raw = require(path.join(__dirname, '..', 'investigation', 'datasets', `${caseId}.json`));
    const vars = (Array.isArray(raw) ? raw[0] : raw).vars;
    const files = typeof vars.changedFiles === 'string' ? JSON.parse(vars.changedFiles) : vars.changedFiles;
    return (files || []).map((f) => (typeof f === 'string' ? f : f.filename)).filter(Boolean);
}

// The PR file a written path names: itself, or the one PR file it is the tail
// of (`client.go` when the PR changes a single `.../client.go`). A path that
// names no PR file cannot be commented on, so its finding cannot be posted.
function resolver(files) {
    return (file) => {
        const f = norm(file);
        if (!f) return null;
        if (files.some((x) => norm(x) === f)) return f;
        const tails = files.filter((x) => norm(x).endsWith(`/${f}`));
        return tails.length === 1 ? norm(tails[0]) : null;
    };
}

// Hand-written findings for run ends that carry them only as prose (labels.json).
const LABELS = require('./labels.json');

// One run end through the engine's parse: each written finding and whether it
// came out right. A finding the model wrote with a description and a file of
// the PR must come out; any other must not. A run end whose findings list is
// empty (the model said it had nothing to add) is right when nothing comes out.
async function replay(payload, answer, items, { expect }, files, wroteNone = false) {
    const state = {
        artifacts: payload === undefined ? [] : [{ type: 'submitResult', payload }],
        steps: [{ index: 0, message: { role: 'assistant', content: answer || '', toolCalls: [] } }],
    };
    const found = await extractFindingsWithRecovery(state, recover, { organizationId: 'parse-eval' });
    const { suggestions } = mapAgentFindings({ findings: found }, {
        changedFiles: files.map((filename) => ({ filename })),
        kodyRules: [],
        prNumber: 1,
        isKodyRules: false,
        identityName: 'parse-eval',
        // The generalist's policy: it labels each finding itself.
        labelPolicy: { categoryLabel: 'generalist', allowedLabels: ['bug', 'security', 'performance'], supportsMixed: true },
    });
    // A finding that came through comes out with its own text. Prose recovery
    // rewrites it: what reaches the review is then a comment on the same file
    // and lines, matched only after every finding that kept its text.
    const resolve = resolver(files);
    const postable = (s) => !!text(s.suggestionContent) && !!resolve(s.relevantFile);
    const sameText = (a, b) => resolve(a.relevantFile) === norm(b.relevantFile) && text(a.suggestionContent).slice(0, 80) === text(b.suggestionContent).slice(0, 80);
    const spotOf = (a, b) =>
        resolve(a.relevantFile) === norm(b.relevantFile) &&
        (a.relevantLinesStart == null || b.relevantLinesStart == null || Math.abs(Number(a.relevantLinesStart) - Number(b.relevantLinesStart)) <= 3);
    // A labelled finding the prose ties to two places may come out at either.
    const sameSpot = (a, b) => [a, ...(a.alsoAt || [])].some((at) => spotOf(at, b));
    const pool = [...suggestions];
    const take = (s, same) => {
        const at = pool.findIndex((k) => same(s, k));
        if (at >= 0) pool.splice(at, 1);
        return at >= 0;
    };
    const wanted = items
        .map((s, i) => {
            const want = expect(s, i);
            return { s, want: want === 'keep' && !postable(s) ? 'drop' : want };
        })
        .filter((x) => x.want !== 'either');
    for (const x of wanted) x.kept = take(x.s, sameText);
    for (const x of wanted) if (!x.kept && x.want === 'keep') x.kept = take(x.s, sameSpot);
    const out = wanted.map(({ s, want, kept }) => {
        const what = `${text(s.relevantFile) || '(no file)'}: ${text(s.oneSentenceSummary) || text(s.suggestionContent).slice(0, 60) || '(no description)'}`;
        return want === 'keep' ? { what, ok: kept } : { what: `dropped: ${what}`, ok: !kept };
    });
    if (wroteNone) {
        const added = suggestions.map((k) => `${text(k.relevantFile)}: ${text(k.oneSentenceSummary) || text(k.suggestionContent).slice(0, 60)}`);
        out.push({ what: added.length ? `added to a run that wrote no finding: ${added.slice(0, 2).join('; ')}` : 'added nothing to a run that wrote no finding', ok: !added.length });
    }
    return out;
}

async function runCase(c) {
    // `require`, so the wiring smoke's trace lists the payload and the nightly
    // measures again when one is recorded anew.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const recorded = require(path.join(__dirname, c.payload));
    const files = prFiles(recorded.caseId);
    const detail = [];
    if (c.shape === 'as-sent') {
        for (const [i, end] of recorded.ends.entries()) {
            const payload = end.submitResult === undefined ? undefined : asArtifact(end.submitResult);
            const label = LABELS[`${c.payload}#${i}`];
            const list = payloadOf(end)?.suggestions;
            const wroteNone = label ? !label.findings.length : Array.isArray(list) && !list.length;
            // The run end in each item: the nightly pools two runs item by item.
            const items = await replay(payload, end.text, label ? label.findings : written(payloadOf(end)), SHAPES['as-sent'], files, wroteNone);
            detail.push(...items.map((d) => ({ ...d, what: `run end ${i}: ${d.what}` })));
        }
    } else {
        const base = payloadOf(recorded.ends[c.end]);
        const items = written(base);
        // The shape is applied to the findings as the model wrote them; the
        // run's own text is left out, so only the shaped call is parsed.
        detail.push(...(await replay(SHAPES[c.shape].apply({ ...base, suggestions: items }), '', items, SHAPES[c.shape], files)));
    }
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

async function main() {
    const results = new Array(cases.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            try {
                results[i] = { id: c.id, checks: c.checks, ...(await runCase(c)) };
            } catch (error) {
                errored += 1;
                console.error(`  ${c.id}: ${String(error.message || error).slice(0, 200)}`);
                results[i] = { id: c.id, checks: c.checks, hits: 0, total: 0, unmeasured: true };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(args.concurrency) || 8) }, worker));
    const hits = results.reduce((n, r) => n + r.hits, 0);
    const total = results.reduce((n, r) => n + r.total, 0);
    const result = {
        eval: 'parse',
        question: evalQuestion('evals/parse'),
        model: MODEL,
        runs: 1,
        metric: { name: 'of written findings handled right by the parse', value: total ? hits / total : null, floor: TARGET.floor ?? null, baseline: TARGET.observed ?? null },
        cases: results,
        tokens: tokensUsed(),
        infra: { errored, total: cases.length },
    };
    if (args.output) {
        fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
        fs.writeFileSync(args.output, `${JSON.stringify(result, null, 2)}\n`);
    }
    // One line per shape over every model, then each recorded run that lost something.
    const byShape = new Map();
    cases.forEach((c, i) => {
        if (c.shape === 'as-sent') return;
        const t = byShape.get(c.shape) || { hits: 0, total: 0 };
        t.hits += results[i].hits;
        t.total += results[i].total;
        byShape.set(c.shape, t);
    });
    for (const [shape, t] of byShape) console.log(`  ${shape.padEnd(28)} ${t.hits}/${t.total}`);
    for (const r of results.filter((x, i) => cases[i].shape === 'as-sent' && x.hits < x.total)) {
        console.log(`  ${r.id}: ${r.hits}/${r.total} — ${r.detail.filter((d) => !d.ok).map((d) => d.what.slice(0, 120)).slice(0, 3).join('; ')}`);
    }
    console.log(`parse: ${hits}/${total} written findings handled right · ${errored} of ${cases.length} cases did not measure`);
    if (errored > cases.length * 0.05) {
        console.error(`not measured: ${errored} of ${cases.length} cases failed to run (see above)`);
        return 2;
    }
    const problems = resultProblems(result);
    if (problems.length) {
        console.error(`not measured: the result breaks the shared shape — ${problems.join('; ')}`);
        return 2;
    }
    if (args.gate && result.metric.floor === null) {
        console.error(`GATE NOT EVALUATED: no floor for ${MODEL} in evals/parse/targets.json`);
        return 0;
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% below the floor in evals/parse/targets.json`);
        return 1;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((error) => {
        console.error(error);
        process.exit(2);
    });

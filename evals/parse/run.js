#!/usr/bin/env node
// parse: replays how the finder's runs ended, as models sent it, through the
// engine's own parse, and counts the written findings that come out right.
// Each recorded run end becomes the run's state as production's runner holds it
// (`eventToMessage` over the AI SDK's step, `materializeArtifacts`), then goes
// through `extractFindingsWithRecovery` (structured submitResult, then JSON in
// the run's text, then the prose recovery call on the slot the run ended on)
// and the generalist's own `mapFindings`, over the PR's files as the platform
// lists them. The run ends are recorded model output (capture.js); the shapes
// production lost (#2112, shapes.js) are applied to one of them. Only prose
// recovery calls the model: the rest is deterministic.
//
//   node evals/parse/run.js [--model=<id>] [--gate] [--output=<result.json>] [--prose] [--limit=N] [--concurrency=N]
//
// --model        the runs recorded on this model, whose prose recovery runs on
//                its slot (the nightly model by default). eval-fake replays
//                every recorded run, each recovery on the scripted model.
// --prose        only the cases that reach prose recovery (the Friday cut)
// --concurrency  cases run at once (8): recovery calls take seconds each
//
// Exit: 0 pass, 1 below the floor (--gate), 2 did not measure (evals/AGENTS.md).
const fs = require('fs');
const path = require('path');
const { resolveRoute, evalPermissionService, EVAL_ORG } = require('../shared/model-route');
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
const FAKE = MODEL === 'eval-fake';
const TARGET = (require('./targets.json').models || {})[MODEL] || {};
// The model a case's runs were recorded on: its payload directory (capture.js).
const recordedOn = (c) => c.payload.split('/')[1];
const cases = require('./cases.json')
    .filter((c) => FAKE || recordedOn(c) === MODEL.replace(/[^\w.@-]+/g, '-'))
    .filter((c) => !args.prose || c.prose)
    .slice(0, args.limit ? Number(args.limit) : undefined);

// libs/common/utils/crypto.ts reads API_CRYPTO_KEY at import time; CI has no .env.
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);
countTokens();
const { extractFindingsWithRecovery, recoverFindingsFromProse, FINDER_DONE_TOOL } = require('../../libs/code-review/infrastructure/agents/core/finder.agent.ts');
const { eventToMessage, materializeArtifacts } = require('../../libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner.ts');
const { GeneralistAgentProvider } = require('../../libs/code-review/infrastructure/agents/providers/generalist-agent.provider.ts');
const { routeCodeReviewModel } = require('../../libs/code-review/pipeline/stages/route-code-review-model.ts');
const { classifyLLMError, LlmErrorCategory } = require('../../libs/llm/error-classifier.ts');
// The JSON parser the AI SDK reads a tool call's arguments with (parseToolCall).
// eslint-disable-next-line import/no-dynamic-require
const { safeParseJSON } = require(require.resolve('@ai-sdk/provider-utils', { paths: [path.dirname(require.resolve('ai'))] }));

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const norm = (f) => text(f).replace(/\\/g, '/').replace(/^\.?\/+/, '');

// The slot the recorded runs ended on: their model, reached the way capture.js
// reached it (evals/shared/model-route.js: the env/managed route, or a stored
// BYOK config with RECALL_REASONING_EFFORT) and routed as ValidateConfigStage
// routes the codeReview task. Production's adapter hands that slot
// (secrets.byokConfig, none on the managed route) to the prose recovery
// (core-agent-loop.adapter.ts).
function slotOf(modelId) {
    const route = resolveRoute({ provider: 'tier0', model: modelId });
    return routeCodeReviewModel(route.storedConfig, {}).resolvedModelSlot;
}

// The submitResult input as the AI SDK hands it to the runner (parseToolCall,
// ai@7): the provider's arguments text parsed as JSON (the runner's tool schema
// has no validator), empty text read as {}. Anthropic's tool_use input reaches
// it as its JSON text. Arguments that are not JSON would first go to the loop's
// repairToolCall (libs/llm/repair-tool-call.ts), a model call this replay does
// not make; every recorded one parses, and a shape keeps what it was given.
async function toolInput(sent) {
    const raw = typeof sent === 'string' ? sent : JSON.stringify(sent);
    if (raw.trim() === '') return {};
    const parsed = await safeParseJSON({ text: raw });
    return parsed.success ? parsed.value : raw;
}

// A run that ended on this response, as production's runner holds it: the step
// eventToMessage builds from the AI SDK's step, and the artifacts
// materializeArtifacts reads off the steps (the last submitResult wins).
// capture.js records each run's last response only: the steps before it, and
// the text they carried, are not in the state.
function runState(answer, input) {
    const toolCalls = input === undefined ? [] : [{ toolCallId: 'run-end', toolName: FINDER_DONE_TOOL, input }];
    const steps = [{ index: 0, message: eventToMessage({ text: answer || '', toolCalls }) }];
    return { steps, artifacts: materializeArtifacts(steps, FINDER_DONE_TOOL, 'result') };
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
// A payload's findings list as the model sent it, a JSON string parsed.
function listOf(payload) {
    const items = payload?.suggestions;
    if (typeof items !== 'string') return items;
    try {
        return JSON.parse(items);
    } catch {
        return undefined;
    }
}

function written(payload) {
    const items = listOf(payload);
    return Array.isArray(items) ? items.filter((s) => s && typeof s === 'object' && !('$text' in s)) : [];
}

// The object a run end carries: its submitResult, or the JSON it answered in text.
const payloadOf = async (end) => (end.submitResult === undefined ? fromText(end.text) : toolInput(end.submitResult));

// The prose recovery as production wires it (core-agent-loop.adapter.ts), on
// the slot the run ended on. It swallows a failed call and returns []. When the
// provider refused (key, quota, rate, outage) the case did not measure; an
// answer that did not fit the schema is the recovery losing the findings, as
// in production.
const REFUSED = new Set(['AUTH_INVALID', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'MODEL_NOT_FOUND', 'MODEL_ACCESS_DENIED', 'TRANSIENT'].map((c) => LlmErrorCategory[c]));
async function recover(reasoning, slot) {
    const { result: out, errors } = await withCallErrors(() => recoverFindingsFromProse(reasoning, slot, EVAL_ORG.organizationId, 'parse-eval'));
    // An answer that came back but did not fit is never a refusal; the
    // classifier reads the whole error text, which then holds the model's answer.
    const answered = (e) => e?.name === 'AI_NoObjectGeneratedError' || /^No object generated/.test(String(e?.message));
    const refusal = errors.find((e) => !answered(e) && REFUSED.has(classifyLLMError(e).category));
    if (!out.length && refusal) throw new Error(`prose recovery call refused: ${String(refusal?.message || refusal).slice(0, 200)}`);
    return out;
}

// The PR: its number and its changed files as the platform lists them
// (fetch-pr-data.js recorded them), which the review hands the mapper.
function prOf(caseId) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const raw = require(path.join(__dirname, '..', 'investigation', 'datasets', `${caseId}.json`));
    const vars = (Array.isArray(raw) ? raw[0] : raw).vars;
    if (!Array.isArray(vars.prFiles) || !vars.prFiles.length) throw new Error(`case data: ${caseId} has no prFiles`);
    return { number: vars.prNumber, files: vars.prFiles };
}

// The agent whose runs these are: production's generalist, mapping findings
// under its own label policy (BaseCodeReviewAgentProvider.mapFindings).
const generalist = new GeneralistAgentProvider(evalPermissionService(null), {}, undefined, undefined);

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
async function replay(input, answer, items, { expect }, pr, slot, wroteNone = false) {
    const state = runState(answer, input);
    const found = await extractFindingsWithRecovery(state, (reasoning) => recover(reasoning, slot), { organizationId: EVAL_ORG.organizationId });
    const { suggestions } = generalist.mapFindings({ findings: found }, { changedFiles: pr.files, kodyRules: [], prNumber: pr.number });
    // A finding that came through comes out with its own text. Prose recovery
    // rewrites it: what reaches the review is then a comment on the same file
    // and lines, matched only after every finding that kept its text.
    const resolve = resolver(pr.files.map((f) => f.filename));
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

async function runCase(c, slot) {
    // `require`, so the wiring smoke's trace lists the payload and the nightly
    // measures again when one is recorded anew.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const recorded = require(path.join(__dirname, c.payload));
    const pr = prOf(recorded.caseId);
    const detail = [];
    if (c.shape === 'as-sent') {
        for (const [i, end] of recorded.ends.entries()) {
            const input = end.submitResult === undefined ? undefined : await toolInput(end.submitResult);
            const label = LABELS[`${c.payload}#${i}`];
            const sent = await payloadOf(end);
            const list = listOf(sent);
            // An end with no call and no text wrote nothing either.
            const empty = end.submitResult === undefined && !String(end.text || '').trim();
            const wroteNone = label ? !label.findings.length : (Array.isArray(list) && !list.length) || empty;
            // The run end in each item: the nightly pools two runs item by item.
            const items = await replay(input, end.text, label ? label.findings : written(sent), SHAPES['as-sent'], pr, slot, wroteNone);
            detail.push(...items.map((d) => ({ ...d, what: `run end ${i}: ${d.what}` })));
        }
    } else {
        const base = await payloadOf(recorded.ends[c.end]);
        const items = written(base);
        // The shape is applied to the findings as the model wrote them; the
        // run's own text is left out, so only the shaped call is parsed.
        detail.push(...(await replay(SHAPES[c.shape].apply({ ...base, suggestions: items }), '', items, SHAPES[c.shape], pr, slot)));
    }
    return { hits: detail.filter((d) => d.ok).length, total: detail.length, detail };
}

async function main() {
    if (!cases.length) {
        console.error(`not measured: no run recorded on ${MODEL} (evals/parse/capture.js --model=${MODEL}, then build-cases.js)`);
        return 2;
    }
    let slot;
    try {
        slot = slotOf(MODEL);
    } catch (error) {
        console.error(`not measured: ${error.message}`);
        return 2;
    }
    const results = new Array(cases.length);
    let errored = 0;
    let next = 0;
    const worker = async () => {
        while (next < cases.length) {
            const i = next++;
            const c = cases[i];
            try {
                results[i] = { id: c.id, checks: c.checks, ...(await runCase(c, slot)) };
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

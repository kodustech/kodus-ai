// Verifier-verdict delivery eval (issue #1937) — does a verdict the model
// DELIVERED actually reach the gate?
//
//   node evals/verifier-verdict/run.js               # print the ledger
//   node evals/verifier-verdict/run.js --gate        # exit 1 on a lost verdict
//   node evals/verifier-verdict/run.js --corpus PATH # a live corpus (capture.js)
//
// Exit: 0 pass / 1 gate (a delivered verdict was lost) / 2 infra.
//
// WHAT this proves — and what it does NOT.
//  - PROVES: for every way a real model DELIVERS its verdict — the submitVerdict
//    tool, or a JSON object in its final text (fenced, after quoted code, under a
//    renamed key, after an example object) — the PRODUCTION extractVerdict reads
//    it and the `keep` decision survives. It requires the real functions from
//    verifier.agent.ts and llm-verdict.ts, not a stand-in, so deleting the text
//    path turns this red. That is the regression gate: 28% of production verdicts
//    arrive as text, and before the fix ALL of them were discarded and the
//    candidate published with rationale "no parseable verdict — kept by default".
//  - PROVES (fail-open is intact): a run that delivered NOTHING — cut off
//    mid-investigation with a tool_call-only last message (39 of 247 production
//    runs), or pure prose — must still keep the candidate. A parser that starts
//    inventing verdicts from prose is a worse bug than the one this fixes.
//  - Does NOT measure review QUALITY. Whether dropping these refutations raises
//    precision/recall is the golden benchmark's job, not this one. This eval
//    answers exactly one question: was a verdict the model gave us thrown away?
//  - Does NOT measure how OFTEN each shape occurs. That is capture.js against
//    Langfuse; this file is the deterministic, no-key CI floor.
//
// SECTION 2 — the finalize ledger. A verdict can only be read if the model got a
// step to write one. 20% of production verify runs (154 sampled, 2026-09-19)
// ended with NO verdict, 16 of 24 sampled dying on the final step still calling
// tools, and the gate then fails open and keeps the candidate unverified. So this
// also walks the REAL verifier spec step by step and asserts that every one of
// the last steps carries either budget guidance or a finalize nudge — and that
// the nudge does NOT restrict the tools, because this agent's contract is TEXT
// (its prompt asks for a JSON verdict and never names the done tool, and
// constraining the output is measured harm — model-strictness.ts). Swap in a
// tool-forcing policy and this section goes red on purpose.
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');

const GATE = process.argv.includes('--gate');
const arg = (n, d) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
};

let extractVerdict,
    VERIFY_DONE_TOOL,
    genericExtractVerdict,
    buildVerifierAgentSpec;
try {
    ({
        extractVerdict,
        VERIFY_DONE_TOOL,
        buildVerifierAgentSpec,
    } = require('../../libs/code-review/infrastructure/agents/core/verifier.agent.ts'));
    ({
        extractVerdict: genericExtractVerdict,
    } = require('../../libs/agent-harness/infrastructure/verify/llm-verdict.ts'));
} catch (e) {
    console.error(
        `INFRA: cannot load the production extractors — ${e.message}`,
    );
    process.exit(2);
}

/** A RunState as the runner builds it: the final step carries the model's text,
 *  the verdict tool (when called) is materialized into artifacts. */
function runStateFor(row) {
    const steps = [];
    // Investigation steps come first; every verifier run makes tool calls.
    steps.push({
        index: 0,
        message: {
            role: 'assistant',
            content: '',
            toolCalls: [
                {
                    id: 't1',
                    name: 'readFile',
                    input: { path: 'src/x.ts' },
                    output: '...',
                },
            ],
        },
    });
    steps.push({
        index: 1,
        message: { role: 'assistant', content: row.text ?? '', toolCalls: [] },
    });
    return {
        runId: row.id,
        agentId: 'verifier',
        status: 'completed',
        steps,
        artifacts: row.calledVerdictTool
            ? [{ type: VERIFY_DONE_TOOL, payload: row.toolPayload }]
            : [],
        usage: {},
        trace: [],
    };
}

function loadRows() {
    const corpus = arg('corpus');
    if (corpus) {
        const raw = JSON.parse(fs.readFileSync(corpus, 'utf8'));
        const rows = Array.isArray(raw) ? raw : raw.rows || [];
        // A captured row has no `expect`: its expectation IS its own text — a
        // keep:false written down must come back as keep:false.
        return rows.map((r) => ({ ...r, captured: !r.expect }));
    }
    return JSON.parse(
        fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'),
    ).rows;
}

/** What the model wrote as a verdict in its text, read the way the PARSER reads
 *  it: a real JSON boolean. Matching a looser shape here would report a LOSS the
 *  parser was never contracted to prevent — see writtenKeepLoose. */
function writtenKeep(text) {
    const m = String(text || '').match(
        /"(?:keep|shouldKeep|should_keep|decision|verdict)"\s*:\s*(false|true)\b/gi,
    );
    if (!m || !m.length) return undefined;
    return !m[m.length - 1].toLowerCase().includes('false');
}

/** The same read, but also accepting the quoted forms a model sometimes emits
 *  (`"keep": "false"`, `"decision": "no"`). The parser does NOT read these: the
 *  boolean-as-string / boolean-as-yes-no shapes are pinned as known degradations
 *  in verifier.agent.contract.spec.ts (`row21`..`row23`, it.failing) for the
 *  artifact path, and the text path inherits that contract deliberately. Counted
 *  and reported, never gated — turning it into a failure here would claim a bug
 *  the code does not have, and fixing it is a separate decision that would flip
 *  those pinned rows. */
function writtenKeepLoose(text) {
    const m = String(text || '').match(
        /"(?:keep|shouldKeep|should_keep|decision|verdict)"\s*:\s*(false|true|"no"|"yes"|"false"|"true")/gi,
    );
    if (!m || !m.length) return undefined;
    const last = m[m.length - 1].toLowerCase();
    return !(last.includes('false') || last.includes('"no"'));
}

const rows = loadRows();
if (!rows.length) {
    console.error('INFRA: no rows to run');
    process.exit(2);
}

const results = [];
const unjudgeable = [];
for (const row of rows) {
    // A captured tool row whose payload was not saved carries no expectation we
    // can check. Counting it as a failure would be a fabricated number.
    if (row.captured && row.calledVerdictTool && row.toolPayload == null) {
        unjudgeable.push(row);
        continue;
    }
    const state = runStateFor(row);
    let got, gotGeneric, err;
    try {
        got = extractVerdict(state);
        gotGeneric = genericExtractVerdict(state);
    } catch (e) {
        err = e.message;
    }
    // A captured row's expectation is what the model DELIVERED, read in the order
    // production reads it: the verdict tool's payload first, its final text only
    // when the payload carries no boolean `keep`. Deriving a tool row's
    // expectation from its text instead scored a healthy `{keep:false}` payload
    // as `want=true, got=false` and reported FAIL against a pipeline that had
    // behaved correctly. When the model delivered nothing, fail-open (keep=true)
    // is the right answer, not an absent expectation.
    const toolKeep =
        row.calledVerdictTool && typeof row.toolPayload?.keep === 'boolean'
            ? row.toolPayload.keep
            : undefined;
    const written = row.expect ? undefined : writtenKeep(row.text);
    const delivered = toolKeep ?? written;
    const want = row.expect ?? {
        keep: delivered === undefined ? true : delivered,
        parseMode:
            toolKeep !== undefined
                ? 'tool'
                : written === undefined
                  ? 'default-keep'
                  : 'text',
    };
    // Delivered in a shape the parser does not read (quoted boolean / yes-no).
    const unreadShape =
        !row.expect &&
        toolKeep === undefined &&
        written === undefined &&
        writtenKeepLoose(row.text) !== undefined;
    const keepOk = err ? false : got.keep === want.keep;
    const modeOk = err ? false : got.parseMode === want.parseMode;
    // The loss this issue is about: the model wrote a refutation and the gate kept it.
    const lostRefutation = !err && want.keep === false && got.keep === true;
    // Both extractors must agree — the bug lived in two places.
    const agree = err ? false : got.keep === gotGeneric.keep;
    results.push({
        unreadShape,
        row,
        got,
        gotGeneric,
        want,
        keepOk,
        modeOk,
        lostRefutation,
        agree,
        err,
    });
}

const W = 38;
console.log('\nVerifier-verdict delivery — production extractVerdict\n');
console.log(
    'id'.padEnd(W),
    'model'.padEnd(22),
    'want      got       mode          ok',
);
console.log('-'.repeat(104));
for (const r of results) {
    const mark = r.err
        ? 'ERR'
        : r.lostRefutation
          ? 'LOST'
          : r.keepOk && r.modeOk && r.agree
            ? 'ok'
            : r.keepOk && r.agree
              ? 'mode?'
              : 'FAIL';
    console.log(
        String(r.row.id).slice(0, W).padEnd(W),
        String(r.row.model || '-')
            .slice(0, 22)
            .padEnd(22),
        `keep=${r.want.keep}`.padEnd(10),
        r.err ? 'throw'.padEnd(10) : `keep=${r.got.keep}`.padEnd(10),
        String(r.err ? '-' : r.got.parseMode).padEnd(14),
        mark,
    );
}

const lost = results.filter((r) => r.lostRefutation);
const failed = results.filter(
    (r) => !r.lostRefutation && (r.err || !r.keepOk || !r.agree),
);
const modeDrift = results.filter(
    (r) => !r.err && r.keepOk && r.agree && !r.modeOk,
);
const byMode = {};
for (const r of results)
    if (!r.err) byMode[r.got.parseMode] = (byMode[r.got.parseMode] || 0) + 1;

console.log('-'.repeat(104));
if (unjudgeable.length) {
    console.log(
        `skipped ${unjudgeable.length} captured tool row(s): verdict payload not in the corpus (re-capture to judge them)`,
    );
}
console.log(
    `rows ${results.length} | parseMode read: ${
        Object.entries(byMode)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ') || '-'
    }`,
);
const unread = results.filter((r) => r.unreadShape);
console.log(
    `refutations delivered ${results.filter((r) => r.want.keep === false).length} | LOST ${lost.length} | other failures ${failed.length} | parseMode drift ${modeDrift.length}`,
);
if (unread.length) {
    // Reported, never gated: see writtenKeepLoose.
    console.log(
        `${unread.length} row(s) delivered a verdict as a quoted boolean or yes/no — a shape the parser does not read by design (verifier.agent.contract.spec.ts row21..row23, it.failing).`,
    );
}

if (lost.length) {
    console.log(
        '\nLOST — the model wrote keep:false and the gate kept the finding anyway:',
    );
    for (const r of lost) {
        console.log(
            `  ${r.row.id}  (${r.row.model})  rationale: "${r.got.rationale}"`,
        );
    }
}
for (const r of failed) {
    console.log(
        `\nFAIL ${r.row.id}: ${r.err ? `threw ${r.err}` : !r.agree ? `extractors disagree (code-review keep=${r.got.keep}, harness keep=${r.gotGeneric.keep})` : `want keep=${r.want.keep}, got keep=${r.got.keep}`}`,
    );
}
for (const r of modeDrift) {
    console.log(
        `\nMODE ${r.row.id}: want parseMode=${r.want.parseMode}, got ${r.got.parseMode} (the keep decision is right; the trace label is not)`,
    );
}

// ---- SECTION 2: the finalize ledger ------------------------------------
// Light depth is the DEFAULT path: LlmVerifier picks it when
// `(candidate.confidence ?? 5) < 5` is false, so a finding with no confidence
// lands here. It is also the depth where BudgetPolicy short-circuits
// (`maxSteps < 6`), which is why an unguided last step went unnoticed.
const DEPTHS = [
    { label: 'light (default, confidence >= 5)', maxSteps: 5 },
    { label: 'full (confidence < 5, evidence gate)', maxSteps: 10 },
];
const emptyTools = { get: () => undefined, list: () => [] };
const ledgerProblems = [];

console.log('\n\nFinalize ledger — the real verifier spec, step by step\n');
for (const depth of DEPTHS) {
    let spec;
    try {
        spec = buildVerifierAgentSpec({
            modelId: 'resolved',
            tools: emptyTools,
            maxSteps: depth.maxSteps,
        });
    } catch (e) {
        console.error(`INFRA: cannot build the verifier spec — ${e.message}`);
        process.exit(2);
    }
    console.log(
        `${depth.label}  maxSteps=${spec.maxSteps}  policies=[${spec.policies.map((p) => p.name).join(', ')}]`,
    );
    console.log('  step   budget-note  finalize-note  tools-restricted');
    for (let stepNumber = 1; stepNumber <= spec.maxSteps; stepNumber++) {
        const view = {
            runId: 'r',
            agentId: 'verifier',
            stepNumber,
            maxSteps: spec.maxSteps,
            steps: [],
            messages: [],
            activeTools: ['readFile', 'grep', VERIFY_DONE_TOOL],
        };
        let budgetNote = false;
        let finalizeNote = false;
        let restricted;
        for (const p of spec.policies) {
            const d = (p.prepareStep ? p.prepareStep(view) : {}) || {};
            if (d.injectNote) {
                if (p.name === 'budget') budgetNote = true;
                else finalizeNote = true;
            }
            if (d.activeTools) restricted = d.activeTools;
        }
        const isLastStretch = stepNumber >= spec.maxSteps - 2;
        const guided = budgetNote || finalizeNote;
        if (isLastStretch && !guided) {
            ledgerProblems.push(
                `${depth.label}: step ${stepNumber}/${spec.maxSteps} has NO budget note and NO finalize nudge — the run can end here with no verdict`,
            );
        }
        if (restricted) {
            ledgerProblems.push(
                `${depth.label}: step ${stepNumber}/${spec.maxSteps} restricts tools to [${restricted.join(', ')}] — this agent answers in TEXT; forcing the done tool contradicts its prompt`,
            );
        }
        console.log(
            `  ${String(stepNumber).padEnd(6)} ${(budgetNote ? 'yes' : '-').padEnd(12)} ${(finalizeNote ? 'yes' : '-').padEnd(14)} ${restricted ? restricted.join(',') : '-'}`,
        );
    }
    console.log('');
}
if (ledgerProblems.length) {
    console.log('LEDGER problems:');
    for (const m of ledgerProblems) console.log(`  ${m}`);
} else {
    console.log('LEDGER ok — no unguided final step, tools never restricted.');
}

const bad = lost.length + failed.length + ledgerProblems.length;
console.log(
    bad
        ? `\nRESULT: RED — ${lost.length} lost verdict(s), ${failed.length} parse failure(s), ${ledgerProblems.length} ledger problem(s)`
        : `\nRESULT: GREEN — every delivered verdict reached the gate, and every final step can deliver one`,
);
process.exit(GATE && bad ? 1 : 0);

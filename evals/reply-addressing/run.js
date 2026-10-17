/**
 * REPLY-ADDRESSING eval: is an unmentioned reply in a Kody thread directed at
 * Kody? (#1946)
 *
 * Runs what ChatWithKodyFromGitUseCase runs on an unmentioned reply
 * (reply-thread.ts): the reply's thread rebuilt from the PR's comments as
 * GitHub returns them, the free gate (`implicitReplyGate`), then the classifier
 * on the model the org routes the conversation task to (production's
 * PermissionValidationService over the org's stored model config,
 * evals/shared/model-route.js: none on the managed default, a BYOK config for
 * any other model). Cases: `cases.json`, the 64 boundary
 * conversations from the TypeSafe experiment plus threads where two people talk
 * and one of them addresses Kody. A reply the gate silences counts as not
 * answered, as in production.
 *
 *   node evals/reply-addressing/run.js --model=gpt-5.4-mini [--repeats=3]
 *                                      [--dataset=cases|repo-cases]
 *                                      [--concurrency=6] [--output=<file>] [--gate]
 *
 * Reports precision (answered replies that were for Kody), recall, and the
 * same two numbers on multi-human threads alone. The headline metric is the
 * share of replies handled right (answered when meant for Kody, quiet when
 * not), gated with --gate on the model's floor in targets.json. --output writes
 * the shared result (evals/shared/eval-result.js), one case per conversation.
 *
 * EXIT CODES: 0 = measured, 1 = below the floor (--gate), 2 = infra
 *   (unroutable model, or more than 5% of calls failed; those are listed with
 *   their reason).
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts',
        format: 'cjs',
        target: 'es2021',
        sourcefile: filename,
        tsconfigRaw: {
            compilerOptions: {
                experimentalDecorators: true,
                useDefineForClassFields: false,
            },
        },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({
    path: path.join(__dirname, '../../.env.local'),
    override: true,
});
if (process.env.HOME) {
    dotenv.config({
        path: path.join(process.env.HOME, '.kodus-dev/config'),
        override: true,
    });
}
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
const MODEL = args.model || 'gpt-5.4-mini';
const REPEATS = Number(args.repeats || 1);
const CONCURRENCY = Number(args.concurrency || 6);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DATASET = String(args.dataset || 'cases').replace(/\.json$/, '');
const INFRA_BUDGET = 0.05;

function infra(msg) {
    console.error(`\n❌ INFRA ERROR: ${msg}`);
    process.exit(2);
}

const { countTokens, tokensUsed } = require('../shared/eval-kit');
const { evalQuestion } = require('../shared/eval-result');
// Floors per dataset and model: `models` holds cases.json's (the nightly and every
// model's weekly run), `datasets.<name>.models` any other's (repo-cases: DeepSeek's
// weekly full set).
const TARGETS = require('./targets.json');
const TARGET = ((DATASET === 'cases' ? TARGETS.models : TARGETS.datasets?.[DATASET]?.models) || {})[MODEL] || {};
const { resolveRoute, EVAL_ORG, evalPermissionService } = require('../shared/model-route');
let ROUTE;
try {
    ROUTE = resolveRoute({ provider: 'tier0', model: MODEL });
} catch (e) {
    infra(`cannot route model '${MODEL}': ${e.message}`);
}

const { implicitReplyGate } = require('../../libs/platform/application/use-cases/codeManagement/implicit-reply.ts');
const { buildReplyThread, classifyImplicitReply } = require('../../libs/platform/application/use-cases/codeManagement/reply-thread.ts');
const { PlatformType } = require('../../libs/core/domain/enums/platform-type.enum.ts');
// The org's stored model config: production's routing sends the conversation
// task to its model.
const permissionValidationService = evalPermissionService(ROUTE.storedConfig);

// cases: boundary conversations. repo-cases: real replies in Kody threads on
// kodustech/kodus-ai, labeled by hand (see README).
const cases = JSON.parse(
    fs.readFileSync(path.join(__dirname, `${DATASET}.json`), 'utf8'),
).slice(0, LIMIT);

const isMultiHuman = (c) =>
    new Set(
        c.messages
            .filter((m) => m.author !== 'Kody' && !m.bot)
            .map((m) => m.author),
    ).size > 1;

// The thread as GitHub returns it: Kody's comments from its app (its bot login
// and the marker every Kody comment carries), other bots by their [bot] login,
// every reply pointing at the thread's first comment. The case's last message
// is the reply being routed. Production reads it from here
// (chatWithKodyFromGit.use-case.ts → reply-thread.ts).
const KODY_LOGIN = 'kody-ai[bot]';
function asGitHubComments(c) {
    return c.messages.map((m, i) => {
        const kody = m.author === 'Kody';
        const login = kody ? KODY_LOGIN : m.bot ? `${m.author}[bot]` : m.author;
        return {
            id: i + 1,
            body: kody ? `${m.text}\n\n<!-- kody-codereview -->` : m.text,
            user: { login, type: kody || m.bot ? 'Bot' : 'User' },
            ...(i > 0 ? { in_reply_to_id: 1 } : {}),
            created_at: new Date(Date.UTC(2026, 9, 16, 10, i)).toISOString(),
        };
    });
}

// What production does with an unmentioned reply: rebuild its thread, the free
// gate, then the classifier on the org's conversation route.
async function answers(c) {
    const comments = asGitHubComments(c);
    const thread = buildReplyThread(comments[comments.length - 1], comments, PlatformType.GITHUB);
    if (implicitReplyGate(thread)) return false;
    return classifyImplicitReply({
        thread,
        permissionValidationService,
        organizationAndTeamData: EVAL_ORG,
        prNumber: 1,
        platformType: PlatformType.GITHUB,
    });
}

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, worker),
    );
    return out;
}

function score(rows) {
    const measured = rows.filter((r) => !r.error);
    const tp = measured.filter(
        (r) => r.expected === 'respond' && r.answered,
    ).length;
    const fp = measured.filter(
        (r) => r.expected === 'quiet' && r.answered,
    ).length;
    const fn = measured.filter(
        (r) => r.expected === 'respond' && !r.answered,
    ).length;
    const tn = measured.filter(
        (r) => r.expected === 'quiet' && !r.answered,
    ).length;
    const ratio = (a, b) => (b ? Number((a / b).toFixed(3)) : null);
    return {
        measured: measured.length,
        precision: ratio(tp, tp + fp),
        recall: ratio(tp, tp + fn),
        specificity: ratio(tn, tn + fp),
        falseAnswers: fp,
        missed: fn,
    };
}

// One conversation in the shared result: what it checks, and the repeats it
// got right out of those that measured.
function caseResults(rows) {
    return cases.map((c) => {
        const mine = rows.filter((r) => r.id === c.id && !r.error);
        const right = mine.filter((r) => r.answered === (r.expected === 'respond')).length;
        const who = isMultiHuman(c) ? ', two people talking' : '';
        const checks = `${c.expected === 'respond' ? 'Answers' : 'Stays quiet on'} the reply in "${c.id}" (${c.category}${who})`;
        return { id: c.id, checks: checks.length > 160 ? `${checks.slice(0, 159)}…` : checks, hits: right, total: mine.length, ...(mine.length ? {} : { unmeasured: true }) };
    });
}

async function main() {
    countTokens();
    const jobs = cases.flatMap((c) =>
        Array.from({ length: REPEATS }, (_, repeat) => ({ c, repeat })),
    );
    console.error(
        `reply-addressing: ${cases.length} cases x ${REPEATS} repeats on ${MODEL}`,
    );

    const rows = await mapLimit(jobs, CONCURRENCY, async ({ c, repeat }) => {
        const row = {
            id: c.id,
            repeat,
            expected: c.expected,
            category: c.category,
            multiHuman: isMultiHuman(c),
        };
        try {
            row.answered = await answers(c);
        } catch (e) {
            row.error = String(e?.message || e).slice(0, 200);
        }
        return row;
    });

    const failed = rows.filter((r) => r.error);
    const perCase = caseResults(rows);
    const hits = perCase.reduce((n, c) => n + c.hits, 0);
    const total = perCase.reduce((n, c) => n + c.total, 0);
    const result = {
        eval: 'reply-addressing',
        question: evalQuestion('evals/reply-addressing'),
        metric: {
            name: 'of replies handled right',
            value: total ? hits / total : null,
            floor: TARGET.floor ?? null,
            baseline: TARGET.observed ?? null,
        },
        runs: REPEATS,
        tokens: tokensUsed(),
        infra: { errored: failed.length, total: rows.length },
        model: MODEL,
        dataset: DATASET,
        repeats: REPEATS,
        cases: cases.length,
        infraBudget: {
            failed: failed.length,
            allowed: Math.floor(rows.length * INFRA_BUDGET),
        },
        overall: score(rows),
        multiHuman: score(rows.filter((r) => r.multiHuman)),
        wrong: rows
            .filter(
                (r) => !r.error && r.answered !== (r.expected === 'respond'),
            )
            .map((r) => `${r.id}#${r.repeat} expected ${r.expected}`),
        rows,
        cases: perCase,
    };

    const output = args.output ? String(args.output) : null;
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2));

    console.log(JSON.stringify({ ...result, rows: undefined, cases: undefined }, null, 2));

    if (failed.length > result.infraBudget.allowed) {
        for (const r of failed.slice(0, 5))
            console.error(`  ${r.id}#${r.repeat}: ${r.error}`);
        infra(
            `${failed.length}/${rows.length} calls failed (budget ${result.infraBudget.allowed})`,
        );
    }
    if (args.gate && result.metric.floor === null) {
        console.error(`\n⚠️ GATE NOT EVALUATED: no floor for ${MODEL} in evals/reply-addressing/targets.json`);
        process.exit(2);
    }
    if (args.gate && result.metric.value < result.metric.floor) {
        console.error(`\n❌ GATE FAILED: ${(result.metric.value * 100).toFixed(1)}% of replies handled right < floor ${(result.metric.floor * 100).toFixed(1)}%`);
        process.exit(1);
    }
    process.exit(0);
}

main().catch((e) => infra(e?.stack || String(e)));

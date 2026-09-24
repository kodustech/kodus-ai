/**
 * REPLY-ADDRESSING eval: is an unmentioned reply in a Kody thread directed at
 * Kody? (#1946)
 *
 * Drives the production classifier (`classifyReplyAddressedToKody`, the one
 * `LLM.run` call ChatWithKodyFromGitUseCase makes) on `cases.json`: the 64
 * boundary conversations from the TypeSafe experiment plus threads where two
 * people talk and one of them addresses Kody. The model is routed like the
 * self-hosted managed slot (`applyModelEnv`), the same path an org without
 * BYOK takes.
 *
 *   node evals/reply-addressing/run.js --model=gpt-5.4-mini [--repeats=3]
 *                                      [--dataset=cases|repo-cases]
 *                                      [--concurrency=6] [--output=<file>]
 *
 * Reports precision (answered replies that were for Kody), recall, and the
 * same two numbers on multi-human threads alone. No floor yet: the issue
 * leaves the ship bar to be set from the first runs.
 *
 * EXIT CODES: 0 = measured, 2 = infra (unroutable model, or more than 5% of
 *   calls failed; those are listed with their reason).
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

const { applyModelEnv } = require('../shared/tier0-models');
try {
    applyModelEnv(MODEL);
} catch (e) {
    infra(`cannot route model '${MODEL}': ${e.message}`);
}

const {
    classifyReplyAddressedToKody,
} = require('../../libs/platform/application/use-cases/codeManagement/implicit-reply.ts');

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

function toThread(c) {
    return c.messages.map((m, i) => ({
        id: i + 1,
        author: m.author,
        isKody: m.author === 'Kody',
        isBot: !!m.bot,
        body: m.text,
    }));
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

async function main() {
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
            row.answered = await classifyReplyAddressedToKody({
                thread: toThread(c),
                organizationAndTeamData: {
                    organizationId: 'eval',
                    teamId: 'eval',
                },
            });
        } catch (e) {
            row.error = String(e?.message || e).slice(0, 200);
        }
        return row;
    });

    const failed = rows.filter((r) => r.error);
    const result = {
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
    };

    const output = args.output ? String(args.output) : null;
    if (output) fs.writeFileSync(output, JSON.stringify(result, null, 2));

    console.log(JSON.stringify({ ...result, rows: undefined }, null, 2));

    if (failed.length > result.infraBudget.allowed) {
        for (const r of failed.slice(0, 5))
            console.error(`  ${r.id}#${r.repeat}: ${r.error}`);
        infra(
            `${failed.length}/${rows.length} calls failed (budget ${result.infraBudget.allowed})`,
        );
    }
    process.exit(0);
}

main().catch((e) => infra(e?.stack || String(e)));

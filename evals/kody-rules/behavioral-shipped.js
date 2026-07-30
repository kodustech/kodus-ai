/**
 * BEHAVIORAL test of the SHIPPED sharded kody-rules path (#1449).
 *
 * Unlike sharded-experiment.js (which used a standalone prompt), this drives
 * the ACTUAL `judgeKodyRulesSharded` + its real SHARD prompts from the shipped
 * collaborator, against real PR diffs and real rules, with a real model. The
 * runJudge closure receives the exact {system, user} the production provider
 * builds and just forwards it to the model — so a green number here means the
 * code we are shipping actually flags the violations.
 *
 * Answers "did we break rule detection?" — not just "does the wiring run".
 *
 *   node evals/kody-rules/behavioral-shipped.js [--model=gpt-5.4-mini] [--conc=4] [--temp=0]
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
require.extensions['.ts'] = function (module, filename) {
    const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
        loader: 'ts', format: 'cjs', target: 'es2021', sourcefile: filename,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    });
    module._compile(code, filename);
};
require('tsconfig-paths/register');

const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../../.env') });
dotenv.config({ path: path.join(__dirname, '../../.env.local'), override: true });
if (process.env.HOME) {
    dotenv.config({ path: path.join(process.env.HOME, '.kodus-dev/config'), override: true });
}
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const [k, v] = a.replace(/^--/, '').split('=');
        return [k, v ?? true];
    }),
);
const MODELKEY = args.model || 'gpt-5.4-mini';
const CONC = Number(args.conc || 4);
const TEMP = args.temp === 'none' ? undefined : Number(args.temp ?? 0);
const LINE_TOL = 2;
// Optional floor: fail (exit 1) if occurrence-recall < this. Advisory when unset.
const GATE = args.gate !== undefined ? Number(args.gate) : null;
const DATASET = String(args.dataset || 'github-cases').replace(/\.json$/, '');

const cases = require(`./${DATASET}.json`);
const { judgeKodyRulesSharded } = require(
    '../../libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge.ts',
);
// Pure parse+score core, unit-tested in behavioral-scoring.spec.ts.
const { parseViolations, scoreCase, normalizePath } = require('./behavioral-scoring.ts');

async function main() {
    const { applyModelEnv } = require('../shared/tier0-models');
    const { byokToVercelModel } = require('../../libs/llm/byok-to-vercel.ts');
    applyModelEnv(MODELKEY);
    const model = byokToVercelModel(undefined, 'main', {});
    const { generateText } = require('ai');

    let inTok = 0, outTok = 0, calls = 0, errored = 0;

    // The closure the shipped judge calls per shard. It receives the REAL
    // system+user prompts the production provider builds.
    const runJudge = async ({ system, user }) => {
        calls++;
        try {
            const res = await generateText({
                model,
                system,
                prompt: user,
                ...(TEMP === undefined ? {} : { temperature: TEMP }),
            });
            const u = res.usage || {};
            inTok += u.promptTokens ?? u.inputTokens ?? 0;
            outTok += u.completionTokens ?? u.outputTokens ?? 0;
            return parseViolations(res.text);
        } catch (e) {
            errored++;
            console.error(`  shard error: ${String(e.message).slice(0, 140)}`);
            return [];
        }
    };

    let occTotal = 0, occCaught = 0;
    let flaggedTotal = 0, onTargetTotal = 0;

    for (const c of cases) {
        const sites = Object.entries(c.groundTruth || {}).flatMap(([fn, hits]) =>
            hits.map((h) => ({ file: normalizePath(fn), line: h.line })),
        );

        // Drive the SHIPPED orchestration: it fans out per changed file and
        // builds the real prompts internally.
        const { violations } = await judgeKodyRulesSharded({
            changedFiles: c.realChangedFiles,
            rules: [c.rule],
            runJudge,
            concurrency: CONC,
        });
        const flags = violations.map((v) => ({
            file: normalizePath(v.relevantFile),
            line: v.relevantLinesStart,
        }));

        const { caught: covered, onTarget } = scoreCase(sites, flags, LINE_TOL);

        occTotal += sites.length;
        occCaught += covered;
        flaggedTotal += flags.length;
        onTargetTotal += onTarget;
        console.log(
            `${c.rule.uuid.padEnd(24)} sites=${String(sites.length).padStart(2)}  caught=${String(covered).padStart(2)}  flags=${flags.length}`,
        );
    }

    const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) : '—');
    console.log(
        `\n════ SHIPPED judgeKodyRulesSharded — behavioral (${MODELKEY}) ════`,
    );
    console.log(
        `OCCURRENCE recall: ${pct(occCaught, occTotal)}%  (${occCaught}/${occTotal} real in-diff sites flagged, ±${LINE_TOL} lines)`,
    );
    console.log(
        `line precision:    ${pct(onTargetTotal, flaggedTotal)}%  (${flaggedTotal - onTargetTotal}/${flaggedTotal} flags off any real site)`,
    );
    console.log(
        `LLM calls: ${calls} (${errored} errored) over ${cases.length} PRs · tokens in=${inTok} out=${outTok}`,
    );
    console.log(
        `\nBaseline for comparison (old agentic path, prior measured): gpt-5.4 ~40%, kimi ~58% occurrence-recall.`,
    );

    const recall = occTotal ? (100 * occCaught) / occTotal : 0;
    if (GATE !== null) {
        if (recall + 1e-9 < GATE) {
            console.error(
                `\n❌ GATE FAILED: occurrence-recall ${recall.toFixed(0)}% < floor ${GATE}% (${MODELKEY})`,
            );
            process.exit(1);
        }
        console.log(
            `\n✅ GATE PASSED: occurrence-recall ${recall.toFixed(0)}% ≥ floor ${GATE}% (${MODELKEY})`,
        );
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});

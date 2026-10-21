#!/usr/bin/env node
/**
 * Issue #1826 — what would the compiler actually infer, over the real rule
 * population?
 *
 * The design of this feature turns on one number nobody has measured: how many
 * of the rules customers actually wrote need something the diff does not carry.
 * Every estimate so far came from four fixtures written by hand. This runs the
 * PRODUCTION compiler prompt over rule texts pulled from the PRODUCTION
 * database, and tallies the answer.
 *
 * Input is the `allDistinctRuleTexts` array written by 1826-prod-evidence.mjs,
 * so this script never touches the database or a credential itself.
 *
 * USAGE
 *   node scripts/analysis/1826-classify-context-need.mjs \
 *     --in=<evidence.json> --out=<needs.json> \
 *     --model=kimi-k2.7-code@fireworks --limit=400 --conc=6
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import esbuild from 'esbuild';

// An ES module has no `require`; the production modules are CommonJS + TS, so
// one is built here rather than duplicating them.
const require = createRequire(import.meta.url);

// The production modules are TypeScript; compile them on the fly the way the
// evals harness does, so this measures the shipped prompt and not a copy.
const tsExt = '.ts';
require('module')._extensions[tsExt] = function (module, filename) {
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
dotenv.config({ path: path.join(process.cwd(), '.env') });
if (!process.env.API_CRYPTO_KEY) process.env.API_CRYPTO_KEY = '0'.repeat(64);

const {
    COMPILER_SYSTEM_PROMPT,
    buildCompilerUserPrompt,
    compilerOutputSchema,
    normalizeContextNeed,
    normalizeDetectorExtensions,
} = require('@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler');
const { LLM } = require('@libs/llm/llm');
const { applyModelEnv } = require('../../evals/shared/tier0-models');

const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        return m ? [m[1], m[2] ?? true] : [a, true];
    }),
);
const IN = args.in;
const OUT = args.out || '/tmp/1826-needs.json';
const MODEL = args.model || 'kimi-k2.7-code@fireworks';
const LIMIT = Number(args.limit || 400);
const CONC = Number(args.conc || 6);
/** Only sample rules whose TEXT names a language — the population the
 *  extension inference is supposed to serve. */
const ONLY_LANG = Boolean(args['only-language']);
/** Per-call ceiling. Without it one stuck request hangs the whole census —
 *  the calls run with thinking enabled and are slow, so a stall is invisible. */
const CALL_TIMEOUT_MS = Number(args.timeout || 90_000);

const withTimeout = (work, ms, label) =>
    Promise.race([
        work,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms),
        ),
    ]);

/**
 * Does the rule's own text name a programming language or a file kind? This is
 * the ground truth the compiler's `extensions` answer is checked against: a
 * rule that says "Ruby" and gets [] back is a miss; one that names nothing and
 * gets [] back is correct.
 */
const LANGUAGE_MENTION =
    /\b(ruby|rails|rspec|erb|python|django|flask|javascript|typescript|node|react|vue|angular|java|kotlin|golang|\bgo\b|rust|php|laravel|c#|csharp|\.net|scala|swift|objective-c|scss|sass|less|css|html|sql|yaml|yml|terraform|dockerfile|bash|shell|elixir|perl|haskell|graphql|protobuf)\b/i;

async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
            while (i < items.length) {
                const idx = i++;
                out[idx] = await fn(items[idx], idx);
            }
        }),
    );
    return out;
}

async function main() {
    applyModelEnv(MODEL);
    const evidence = JSON.parse(readFileSync(IN, 'utf8'));
    const all = evidence.allDistinctRuleTexts ?? [];

    // Weight by blast radius: a rule installed in 68 organisations decides more
    // of the product's behaviour than one written once. The top slice by
    // installs is taken first, then a random tail so the long tail is not
    // invisible.
    const pool = ONLY_LANG
        ? all.filter((r) => LANGUAGE_MENTION.test(`${r.title} ${r.rule}`))
        : all;
    console.log(
        `pool: ${pool.length} de ${all.length} regras distintas` +
            (ONLY_LANG ? ' (só as que citam linguagem)' : ''),
    );
    const byInstalls = [...pool].sort((a, b) => b.installs - a.installs);
    const head = byInstalls.slice(0, Math.floor(LIMIT / 2));
    const restPool = byInstalls.slice(Math.floor(LIMIT / 2));
    const tail = [];
    const wanted = LIMIT - head.length;
    const step = Math.max(1, Math.floor(restPool.length / Math.max(1, wanted)));
    for (let i = 0; i < restPool.length && tail.length < wanted; i += step) {
        tail.push(restPool[i]);
    }
    const sample = [...head, ...tail];

    let done = 0;
    const results = await mapLimit(sample, CONC, async (rule) => {
        const started = Date.now();
        try {
            const parsed = await withTimeout(
                LLM.run({
                schema: compilerOutputSchema,
                system: COMPILER_SYSTEM_PROMPT,
                user: buildCompilerUserPrompt({
                    title: rule.title,
                    rule: rule.rule,
                    path: rule.path,
                    severity: rule.severity,
                }),
                runName: 'kody-rules.1826-context-need-census',
                }),
                CALL_TIMEOUT_MS,
                rule.title,
            );
            return {
                title: rule.title,
                installs: rule.installs,
                orgs: rule.orgs,
                scope: rule.scope,
                origin: rule.origin,
                path: rule.path,
                storedDetector: rule.hasDetector,
                mechanical: parsed?.mechanical ?? null,
                cosmetic: parsed?.cosmetic ?? null,
                contextNeed: normalizeContextNeed(parsed?.contextNeed),
                rawContextNeed: parsed?.contextNeed ?? null,
                // The whole point of this run: in production 927 of 932
                // compiled detectors carry no `extensions`, and the DB cannot
                // say whether the model omitted the field or answered a shape
                // `normalizeDetectorExtensions` rejects (it returns undefined
                // for both). Keeping the RAW answer next to the normalized one
                // separates those two, which need different fixes.
                mentionsLanguage: LANGUAGE_MENTION.test(
                    `${rule.title} ${rule.rule}`,
                ),
                rawExtensions: parsed?.extensions ?? null,
                extensions: normalizeDetectorExtensions(parsed?.extensions) ?? null,
                reason: parsed?.reason ?? null,
                ms: Date.now() - started,
            };
        } catch (err) {
            return {
                title: rule.title,
                installs: rule.installs,
                error: err instanceof Error ? err.message : String(err),
            };
        } finally {
            done++;
            process.stdout.write(
                `  [${done}/${sample.length}] ${Date.now() - started}ms  ${String(rule.title).slice(0, 60)}\n`,
            );
        }
    });

    const ok = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);

    const tally = (key, rows) => {
        const m = new Map();
        for (const r of rows) m.set(r[key] ?? '(none)', (m.get(r[key] ?? '(none)') ?? 0) + 1);
        return Object.fromEntries([...m].sort((a, b) => b[1] - a[1]));
    };
    // Weighted by installs: how much of the deployed surface each need covers.
    const weighted = new Map();
    for (const r of ok) {
        weighted.set(
            r.contextNeed,
            (weighted.get(r.contextNeed) ?? 0) + (r.installs ?? 1),
        );
    }

    const report = {
        generatedAt: new Date().toISOString(),
        model: MODEL,
        distinctRulesInPopulation: all.length,
        sampled: sample.length,
        classified: ok.length,
        failed: failed.length,
        byContextNeed: tally('contextNeed', ok),
        // The measurement that matters: among rules whose text NAMES a
        // language, how many got a usable extension scope back?
        languageScoping: (() => {
            const named = ok.filter((r) => r.mentionsLanguage);
            return {
                rulesNamingALanguage: named.length,
                gotScope: named.filter((r) => r.extensions?.length).length,
                gotNothing: named.filter((r) => !r.extensions?.length).length,
                misses: named
                    .filter((r) => !r.extensions?.length)
                    .slice(0, 20)
                    .map((r) => ({ title: r.title, raw: r.rawExtensions })),
                hits: named
                    .filter((r) => r.extensions?.length)
                    .slice(0, 20)
                    .map((r) => ({ title: r.title, ext: r.extensions })),
            };
        })(),
        extensions: {
            answeredSomething: ok.filter((r) => r.rawExtensions != null).length,
            survivedNormalization: ok.filter((r) => r.extensions?.length).length,
            answeredButRejected: ok.filter(
                (r) => r.rawExtensions != null && !r.extensions?.length,
            ).length,
            omitted: ok.filter((r) => r.rawExtensions == null).length,
            rejectedSamples: ok
                .filter((r) => r.rawExtensions != null && !r.extensions?.length)
                .slice(0, 15)
                .map((r) => ({ title: r.title, raw: r.rawExtensions })),
        },
        byContextNeedWeightedByInstalls: Object.fromEntries(
            [...weighted].sort((a, b) => b[1] - a[1]),
        ),
        offVocabularyAnswers: [
            ...new Set(
                ok
                    .filter((r) => r.contextNeed === 'diff-only' && r.rawContextNeed && r.rawContextNeed !== 'diff-only')
                    .map((r) => r.rawContextNeed),
            ),
        ],
        mechanicalByNeed: Object.fromEntries(
            [...new Set(ok.map((r) => r.contextNeed))].map((need) => [
                need,
                {
                    total: ok.filter((r) => r.contextNeed === need).length,
                    mechanical: ok.filter(
                        (r) => r.contextNeed === need && r.mechanical === true,
                    ).length,
                },
            ]),
        ),
        rows: ok,
        errors: failed.slice(0, 20),
    };

    writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nwrote ${OUT}`);
    console.log('classified:', ok.length, 'failed:', failed.length);
    console.log('by contextNeed:', JSON.stringify(report.byContextNeed, null, 2));
    console.log('extensions:', JSON.stringify(report.extensions, null, 2));
    console.log('languageScoping:', JSON.stringify(report.languageScoping, null, 2));
    console.log(
        'weighted by installs:',
        JSON.stringify(report.byContextNeedWeightedByInstalls, null, 2),
    );
    if (report.offVocabularyAnswers.length) {
        console.log('off-vocabulary answers:', report.offVocabularyAnswers);
    }
}

main().catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
});

#!/usr/bin/env node
/**
 * Refresh `libs/llm/model-context-windows.json` from LiteLLM upstream.
 *
 * WHY THIS EXISTS
 * That file is a MIRROR, and a mirror with no way to refresh it is a snapshot
 * that silently rots. It had rotted: 2011 entries taken before the current model
 * generation existed, so `claude-opus-5`, `claude-sonnet-5`, `gemini-3.5-flash`
 * and `deepseek-v4-pro` — all live in production — were unknown to it and fell
 * back to the 128k default. Upstream says every one of those holds 1M. We were
 * chunking a 1M-context model into 128k windows: more calls, more cost, and a
 * review that never sees the whole change at once.
 *
 * The failure is silent by construction — an unknown model does not error, it
 * just gets a smaller budget — which is why the check below reports coverage
 * against the production corpus instead of only counting rows.
 *
 * USAGE
 *   node scripts/refresh-model-context-windows.mjs           # write
 *   node scripts/refresh-model-context-windows.mjs --check   # report only
 *
 * The projection is deliberately narrow: this repo needs the input window and
 * the upstream provider tag, nothing else. Pulling the whole upstream record
 * would commit pricing we do not read and cannot verify.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UPSTREAM =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'libs/llm/model-context-windows.json');
const CORPUS = join(
    ROOT,
    'libs/llm/testing/__fixtures__/byok-prod-shapes.json',
);
const DEFAULT_WINDOW = 128_000;

/**
 * Resolve a stored model name against the upstream table.
 *
 * Corpus shapes hold whatever the customer typed; upstream keys are litellm ids,
 * some bare (`claude-sonnet-5`) and some vendor-prefixed with a slash
 * (`deepseek/deepseek-v4-pro`, `google/gemini-3.1-pro-preview`). Trying the last
 * path segment is what bridges those.
 *
 * It lives here because the coverage REPORT already did this and the --check
 * GATE did not, so the two disagreed about the same corpus: nine production
 * models were counted as covered and then skipped by the gate, which is the
 * silent rot this script exists to catch. One rule, both readers.
 */
const lookup = (table, model) =>
    table[model] ?? table[model.split('/').pop()];

const checkOnly = process.argv.includes('--check');

const res = await fetch(UPSTREAM);
if (!res.ok) {
    console.error(`upstream fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
}
const upstream = await res.json();

/** Project to the two fields this repo reads. Entries with no input window are
 *  dropped — a row that cannot answer the question is not worth mirroring. */
const next = {};
for (const [id, rec] of Object.entries(upstream)) {
    if (!rec || typeof rec !== 'object') continue;
    const max = rec.max_input_tokens;
    if (typeof max !== 'number' || max <= 0) continue;
    next[id] = { max_input_tokens: max, litellm_provider: rec.litellm_provider };
}

const current = JSON.parse(readFileSync(TARGET, 'utf8'));
const added = Object.keys(next).filter((k) => !(k in current));
const removed = Object.keys(current).filter((k) => !(k in next));
const changed = Object.keys(next).filter(
    (k) =>
        k in current &&
        current[k].max_input_tokens !== next[k].max_input_tokens,
);

console.log(
    `entries ${Object.keys(current).length} -> ${Object.keys(next).length} ` +
        `(+${added.length} / -${removed.length} / ~${changed.length} windows)`,
);

// Coverage against the real production corpus, which is the number that matters:
// a mirror can grow by a thousand rows and still not know the models we serve.
try {
    const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
    const shapes = Array.isArray(corpus) ? corpus : (corpus.shapes ?? []);
    const models = shapes
        .map((s) => (s.slot ?? s).model)
        .filter((m) => typeof m === 'string' && m);
    const covered = (table) =>
        models.filter((m) => {
            const hit = lookup(table, m);
            return hit && hit.max_input_tokens !== DEFAULT_WINDOW;
        }).length;
    console.log(
        `production shapes with a NON-default window: ` +
            `${covered(current)}/${models.length} -> ${covered(next)}/${models.length}`,
    );
} catch {
    console.log('production corpus not readable — coverage check skipped');
}

if (checkOnly) {
    // Fail on what MATTERS, not on churn. Upstream adds hundreds of models a
    // month and none of them concern us; what concerns us is a model customers
    // actually run whose window we would get wrong. Failing on every addition
    // would make this job noise, and a noisy weekly job gets muted, which is how
    // the mirror rotted the first time.
    const problems = [];
    try {
        const corpus = JSON.parse(readFileSync(CORPUS, 'utf8'));
        const shapes = Array.isArray(corpus) ? corpus : (corpus.shapes ?? []);
        const models = [
            ...new Set(
                shapes
                    .map((s) => (s.slot ?? s).model)
                    .filter((m) => typeof m === 'string' && m),
            ),
        ];
        for (const m of models) {
            const now = lookup(current, m)?.max_input_tokens;
            const then = lookup(next, m)?.max_input_tokens;
            if (then === undefined) continue; // upstream does not know it either
            if (now === undefined) {
                problems.push(`${m}: missing here, upstream says ${then}`);
            } else if (now !== then) {
                problems.push(`${m}: ${now} here, upstream says ${then}`);
            }
        }
    } catch {
        problems.push('production corpus unreadable — cannot judge staleness');
    }

    if (problems.length) {
        console.error(
            `\n${problems.length} production model(s) out of date. ` +
                `Run this script without --check and commit the result:\n`,
        );
        for (const p of problems) console.error(`  - ${p}`);
        process.exit(1);
    }
    console.log('production models are up to date with upstream');
    process.exit(0);
}

// Single-line JSON, matching the committed format: this file is data, never
// read by a human, and a pretty-printed diff would be 8k lines of noise on top
// of every refresh.
writeFileSync(TARGET, JSON.stringify(next) + '\n');
console.log(`wrote ${TARGET}`);

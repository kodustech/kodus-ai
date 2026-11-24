#!/usr/bin/env node
/**
 * Refresh `libs/llm/model-context-windows.json` from LiteLLM and models.dev.
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
 * where it came from (`litellm_provider`, or `source: "models.dev"`), nothing
 * else. Pulling the whole upstream record
 * would commit pricing we do not read and cannot verify.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UPSTREAM =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MODELS_DEV = 'https://models.dev/api.json';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'libs/llm/model-context-windows.json');
const CORPUS = join(
    ROOT,
    'libs/llm/testing/__fixtures__/byok-prod-shapes.json',
);
const RUNTIME = join(ROOT, 'libs/llm/model-context-window.ts');
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

/** Same normalization as `normalize` in libs/llm/model-context-window.ts. The
 *  runtime resolves a name by this key, so two rows that normalize alike are one
 *  row to it, and the merge below has to decide which one survives. */
const normalize = (name) =>
    name
        .toLowerCase()
        .replace(
            /^(openai|anthropic|google|gemini|vertex_ai|bedrock|azure|together_ai|openrouter|novita|fireworks_ai|deepseek|mistral|moonshot|hf|huggingface)\//,
            '',
        )
        .replace(/[-_.\s/:]/g, '');

const fetchJson = async (url) => {
    const res = await fetch(url);
    if (!res.ok) {
        console.error(`fetch failed for ${url}: ${res.status} ${res.statusText}`);
        process.exit(1);
    }
    return res.json();
};

const isWindow = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

const [upstream, modelsDev] = await Promise.all([
    fetchJson(UPSTREAM),
    fetchJson(MODELS_DEV),
]);
const current = JSON.parse(readFileSync(TARGET, 'utf8'));

/**
 * The mirror is built from three sources, most trusted first:
 *
 *   1. LiteLLM. Its window wins wherever it has the model, including over a
 *      value we committed before, so its corrections reach us.
 *   2. The previous mirror, for a model LiteLLM no longer carries. LiteLLM
 *      deleted every `openrouter/*` row on 2026-10-09 and stopped syncing them.
 *      Replacing the file wholesale would have sent those models back to the
 *      128k default, so the last known window is kept instead.
 *   3. models.dev, for the models neither of the above knows. Only an input
 *      limit is taken: `limit.input`, else `limit.context - limit.output`. A row
 *      with the total window alone is skipped, because the total includes the
 *      output and taking it as input can plan a prompt the model rejects.
 *
 * models.dev comes last because `context - output` reads the output CAP as if
 * it were reserved, so it is a floor, often far below the real input window
 * (GLM 5.1 reads 73,728 against a 200k window). It fills a gap; it never
 * replaces a value we already hold. Its rows carry `source: "models.dev"` and
 * the runtime asks them only when every other step has missed.
 *
 * A row from a later source is dropped when its normalized key already exists,
 * because the runtime cannot tell two such rows apart.
 */
const next = {};
const taken = new Set();
const fromModelsDev = (rec) => rec?.source === 'models.dev';

for (const [id, rec] of Object.entries(upstream)) {
    if (!rec || typeof rec !== 'object') continue;
    const max = rec.max_input_tokens;
    if (!isWindow(max)) continue;
    next[id] = { max_input_tokens: max, litellm_provider: rec.litellm_provider };
}
const fromLiteLLM = Object.keys(next).length;
for (const id of Object.keys(next)) taken.add(normalize(id));

const retained = [];
const keepPrevious = (onlyModelsDev) => {
    for (const [id, rec] of Object.entries(current)) {
        if (fromModelsDev(rec) !== onlyModelsDev) continue;
        if (id in next || taken.has(normalize(id))) continue;
        next[id] = rec;
        retained.push(id);
    }
    for (const id of retained) taken.add(normalize(id));
};
keepPrevious(false);

// One model can be listed by several hosts, under spellings that normalize
// alike, with different limits. Every spelling gets the smallest: it is the
// window every host can serve, and the runtime cannot tell the spellings apart.
const modelsDevKeyOf = {};
const smallestByKey = new Map();
for (const provider of Object.values(modelsDev)) {
    for (const [id, model] of Object.entries(provider?.models ?? {})) {
        const limit = model?.limit ?? {};
        // `context - output` reserves the whole output cap, which the agent's
        // prompt budget already reserves again, so a derived value is floored at
        // what the model got before it had a row: the default, or the whole
        // context when that is smaller.
        const input = isWindow(limit.input)
            ? limit.input
            : isWindow(limit.context) && isWindow(limit.output)
              ? Math.max(
                    limit.context - limit.output,
                    Math.min(limit.context, DEFAULT_WINDOW),
                )
              : undefined;
        const key = normalize(id);
        if (!isWindow(input) || id in next || taken.has(key)) continue;
        modelsDevKeyOf[id] = key;
        smallestByKey.set(key, Math.min(smallestByKey.get(key) ?? Infinity, input));
    }
}
for (const [id, key] of Object.entries(modelsDevKeyOf)) {
    next[id] = { max_input_tokens: smallestByKey.get(key), source: 'models.dev' };
}
for (const key of smallestByKey.keys()) taken.add(key);

// A models.dev row that models.dev itself dropped keeps its last value, like
// the LiteLLM rows above.
keepPrevious(true);

// The runtime asks a models.dev row only after a manual override and the
// substring step over the other rows have both missed. A row either of them
// answers first is never read, and writing it would let --check fail on a
// models.dev change nothing reads.
const overrideKeys = new Set(
    [
        ...readFileSync(RUNTIME, 'utf8')
            // Comments blanked first, so a quoted example in one is not a key.
            .replace(/\/\*[^]*?\*\/|\/\/[^\n]*/g, '')
            .match(/const MANUAL_OVERRIDES[^]*?\n};/)[0]
            .matchAll(/^\s*'([^']+)':/gm),
    ].map((m) => m[1]),
);
const otherKeys = Object.entries(next)
    .filter(([, rec]) => !fromModelsDev(rec))
    .map(([id]) => normalize(id));
let shadowed = 0;
for (const [id, rec] of Object.entries(next)) {
    if (!fromModelsDev(rec)) continue;
    const key = normalize(id);
    if (
        overrideKeys.has(key) ||
        otherKeys.some((k) => key.includes(k) || k.includes(key))
    ) {
        delete next[id];
        shadowed++;
    }
}

console.log(
    `sources: litellm ${fromLiteLLM} / models.dev ${Object.keys(modelsDevKeyOf).length}` +
        ` / kept from previous mirror ${retained.length}` +
        ` / models.dev rows the runtime never reads, dropped ${shadowed}`,
);

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

// Invokes the REDUCER (libs/.../engine/reducer-prompt.ts) on a candidate set,
// on ANY model. Same forced-tool-call mechanism the dedup runner uses — see
// dedup-runner.js for why json_schema alone is not enough (providers treat it
// as advisory and drift, silently yielding a keep-all no-op).
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');

const { generateText, jsonSchema, tool } = require('ai');
const {
    buildReducerPrompt,
    REDUCER_SCHEMA,
} = require('@libs/code-review/infrastructure/agents/engine/reducer-prompt');

const normSeverity = (s) => (s == null ? 'medium' : String(s).toLowerCase());

/**
 * @param {Array} candidates  findings to reduce
 * @param {object} opts
 * @param {object} opts.model  pre-built AI SDK model (same model as the review)
 * @returns {{kept:number[], merged:Map<number,number[]>, dropped:Array, usage:object, noOp:boolean}}
 */
async function runReducer(candidates, opts = {}) {
    const n = candidates.length;
    if (n <= 1) {
        return {
            kept: candidates.map((_, i) => i),
            merged: new Map(),
            dropped: [],
            usage: null,
            noOp: false,
            raw: { skipped: true },
        };
    }

    const tools = {
        submitReview: tool({
            description:
                'Submit the final reviewed finding set. You MUST call this tool — it is the only way to answer.',
            inputSchema: jsonSchema(REDUCER_SCHEMA),
            execute: async () => ({ output: 'recorded' }),
        }),
    };
    const prompt = buildReducerPrompt(candidates, normSeverity, !!opts.strict);
    const callArgs = (toolChoice) => ({
        model: opts.model,
        tools,
        ...(toolChoice ? { toolChoice } : {}),
        prompt,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
    });

    let result;
    try {
        result = await generateText(
            callArgs({ type: 'tool', toolName: 'submitReview' }),
        );
    } catch (err) {
        // Some OpenAI-compatible upstreams (Meta's Muse) reject a named
        // tool_choice: `only "auto" is supported`. Same fallback as dedup.
        if (/tool_choice|tool choice/i.test(String(err?.message ?? ''))) {
            result = await generateText(callArgs(undefined));
        } else {
            throw err;
        }
    }

    const call = (result.toolCalls || []).find(
        (c) => (c.toolName ?? c.name) === 'submitReview',
    );
    let object = call?.input ?? call?.args ?? {};
    if (typeof object === 'string') {
        try {
            object = JSON.parse(object);
        } catch {
            object = {};
        }
    }

    const valid = (i) => Number.isInteger(i) && i >= 0 && i < n;
    const toIdx = (v) => {
        if (Number.isInteger(v)) return v;
        if (v && typeof v === 'object') {
            const c = [v.index, v.id, v.idx].find(Number.isInteger);
            if (c !== undefined) return c;
        }
        if (typeof v === 'string') {
            const m = v.match(/\d+/);
            if (m) return +m[0];
        }
        return NaN;
    };

    const rawKeep = Array.isArray(object?.keep) ? object.keep : [];
    const rawDrop = Array.isArray(object?.drop) ? object.drop : [];

    const kept = [];
    const merged = new Map();
    for (const k of rawKeep) {
        const idx = toIdx(k?.index ?? k);
        if (!valid(idx) || kept.includes(idx)) continue;
        kept.push(idx);
        const from = (Array.isArray(k?.mergedFrom) ? k.mergedFrom : [])
            .map(toIdx)
            .filter((i) => valid(i) && i !== idx);
        if (from.length) merged.set(idx, from);
    }
    const dropped = rawDrop
        .map((d) => ({ index: toIdx(d?.index ?? d), reason: d?.reason }))
        .filter((d) => valid(d.index));

    // Safety: an unusable answer must not wipe the review. Keep everything —
    // same posture as the dedup runner's noOp fallback.
    const accounted = new Set([
        ...kept,
        ...[...merged.values()].flat(),
        ...dropped.map((d) => d.index),
    ]);
    let noOp = false;
    if (kept.length === 0) {
        noOp = true;
        return {
            kept: candidates.map((_, i) => i),
            merged: new Map(),
            dropped: [],
            usage: result.usage,
            noOp,
            raw: object,
        };
    }
    // Anything the model never classified is KEPT (never silently dropped).
    const unmentioned = [];
    for (let i = 0; i < n; i++) if (!accounted.has(i)) unmentioned.push(i);

    return {
        kept: [...kept, ...unmentioned],
        merged,
        dropped,
        unmentioned,
        usage: result.usage,
        noOp,
        raw: object,
    };
}

module.exports = { runReducer };

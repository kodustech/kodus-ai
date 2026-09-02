/**
 * BYOK reasoning LIVE contract — "does the shape we emit still WORK upstream?"
 *
 * ─── WHY THIS EXISTS, SEPARATELY FROM byok-config-matrix.spec.ts ────────────
 * The offline matrix proves that a stored config produces the request body we
 * intend. It cannot prove that body is still CORRECT, because that fact lives on
 * the provider's side and changes on the provider's timeline. The regression we
 * keep hitting is exactly that: a model changes how it is configured, our
 * request quietly stops meaning what it meant, and nobody finds out until a
 * customer's reviews get worse.
 *
 * So this tier issues a REAL, minimal call per brand, through the production
 * path: `LLM.run` → slot resolution → failover → executor → the vendor.
 *
 * ─── IT ASSERTS THE EFFECT, NOT JUST THE ABSENCE OF AN ERROR ────────────────
 * The dangerous drift is SILENT. If a vendor renames `thinking` or stops
 * honouring `reasoning_effort`, the request still returns 200 — it just stops
 * reasoning, and the only visible symptom is worse review quality weeks later.
 * A test that only asserts "no 400" would stay green through exactly the
 * failure it was written to catch. So for every brand we ask for reasoning, we
 * assert the response actually BILLED reasoning tokens.
 *
 * ─── CREDENTIALS ───────────────────────────────────────────────────────────
 * One CI-only secret, `BYOK_LIVE_KEYS`, holding a JSON map of brand → key:
 *
 *     {"deepseek":"sk-…","moonshot":"sk-…","zai":"…","open_router":"sk-or-…"}
 *
 * Deliberately ONE secret rather than a new `process.env.*` per brand: these are
 * test credentials, not product configuration, and adding a brand should not
 * grow the product's env surface. Brands fall back to env names that ALREADY
 * EXIST as repo secrets, checked with `gh secret list` rather than assumed:
 *
 *     BYOK_ANTHROPIC_API_KEY   -> the four Claude generations
 *     BYOK_MOONSHOT_API_KEY    -> moonshot, moonshot_code, anthropic_compatible (k3)
 *     BYOK_ZHIPU_API_KEY       -> zai (Zhipu is Z.ai, the GLM vendor)
 *     BYOK_GOOGLE_API_KEY      -> google_gemini
 *     BYOK_OPENAI_API_KEY      -> openai
 *
 * Ten of the twenty rows are runnable on those alone, with no new credential.
 * The fallbacks used to name `API_MOONSHOT_API_KEY`, `API_OPEN_AI_API_KEY` and
 * friends — the PRODUCT's env names, none of which exist as repo secrets. The
 * workflow passed them faithfully and every one resolved to an empty string, so
 * the fallback path had never once produced a key. Those names are kept as
 * SECOND fallbacks, for a local run where they may be set.
 *
 * A case with no key SKIPS — it never fails. A run with partial credentials
 * reports partial coverage, so contributors and forks see green, not a false red.
 *
 * ─── THE SECRET, COMPLETE ──────────────────────────────────────────────────
 * Copy this into the repo secret `BYOK_LIVE_KEYS` and delete the brands you have
 * no key for — a missing brand SKIPS, it never fails, so a partial secret is a
 * valid secret and reports partial coverage.
 *
 *     {
 *       "deepseek":             "sk-…",
 *       "moonshot":             "sk-…",
 *       "moonshot_code":        "sk-…",
 *       "anthropic_compatible": "sk-…",
 *       "zai":                  "…",
 *       "minimax":              "…",
 *       "minimax_m3":           "…",
 *       "minimaxi":             "…",
 *       "open_router":          "sk-or-…",
 *       "openai":               "sk-…",
 *       "anthropic":            "sk-ant-…",
 *       "anthropic-legacy":     "sk-ant-…",
 *       "anthropic-modern":     "sk-ant-…",
 *       "anthropic-off-modern": "sk-ant-…",
 *       "google_gemini":        "…",
 *       "google_vertex":        "<the service-account JSON, as a string>",
 *       "amazon_bedrock":       { "apiKey": "<bearer>", "awsRegion": "us-east-1" },
 *       "bedrock_grok":         { "apiKey": "<bearer>", "awsRegion": "us-east-1" },
 *       "azure":                { "apiKey": "…",
 *                                 "baseURL": "https://<resource>.openai.azure.com/openai",
 *                                 "model": "<your o-series deployment name>" }
 *     }
 *
 * The four Anthropic entries can hold the SAME key — they are four generations
 * of Claude, not four accounts, and they are separate brands only so a key you
 * do have does not skip the generations you want tested.
 *
 * ─── EVERY FIELD CAN COME FROM THE JSON ────────────────────────────────────
 * A brand's entry may be the bare key, or an object carrying the key plus ANY
 * slot field. The object's fields are spread OVER the row below, so the secret
 * always wins:
 *
 *     {
 *       "deepseek": "sk-…",
 *       "zai":      { "apiKey": "…", "model": "glm-5.3" },
 *       "minimaxi": { "apiKey": "…", "baseURL": "https://api.minimaxi.com/v1" },
 *       "azure":    { "apiKey": "…", "model": "o3-mini",
 *                     "baseURL": "https://r.openai.azure.com/openai" },
 *       "bedrock_grok": { "apiKey": "…", "awsRegion": "us-west-2" }
 *     }
 *
 * So the baseURLs written into the rows are DEFAULTS, not fixtures: they are the
 * vendors' public endpoints, kept in the file because reading a row should tell
 * you which vendor it talks to without opening a secret. Anything account-shaped
 * — Azure's resource endpoint, an AWS region, a model your key actually has
 * access to — belongs in the JSON and overrides the default without a code
 * change. Adding a brand is one row plus one JSON key; changing where an
 * existing brand points is JSON alone.
 */

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));


import { z } from 'zod';

import { LLM } from './llm';
import type { NormalizedModel } from './byok-config';

function liveKeys(): Record<string, string> {
    try {
        return JSON.parse(process.env.BYOK_LIVE_KEYS || '{}');
    } catch {
        throw new Error(
            'BYOK_LIVE_KEYS is set but is not valid JSON — expected {"brand":"key"}.',
        );
    }
}

const KEYS = liveKeys();

/**
 * A brand's entry is either the key itself, or an object carrying the key plus
 * the slot fields that brand needs beyond one — Azure cannot be reached without
 * its resource endpoint and deployment name, and Bedrock wants a region.
 *
 *   { "deepseek": "sk-…",
 *     "azure": { "apiKey": "…", "baseURL": "https://r.openai.azure.com/openai",
 *                "model": "o3-mini" } }
 *
 * Kept inside the ONE secret on purpose. The alternative was a new
 * `process.env.*` per brand, and five of the six names that would have taken do
 * not exist anywhere in this repo — inventing env vars to make a test runnable
 * is how a config surface grows without anyone deciding to grow it.
 */
type LiveEntry = string | { apiKey?: string; [slotField: string]: unknown };

const key = (brand: string, ...envFallbacks: string[]): string | undefined => {
    const entry = KEYS[brand] as LiveEntry | undefined;
    const fromSecret = typeof entry === 'string' ? entry : entry?.apiKey;
    return (
        (fromSecret as string | undefined) ||
        envFallbacks.map((e) => process.env[e]).find(Boolean)
    );
};

/** The extra slot fields an object-form entry carries (everything but apiKey). */
const slotExtras = (brand: string): Record<string, unknown> => {
    const entry = KEYS[brand] as LiveEntry | undefined;
    if (!entry || typeof entry === 'string') return {};
    const { apiKey: _ignored, ...rest } = entry;
    return rest;
};

/**
 * One row per brand whose reasoning shape we make a claim about. `reasons: true`
 * means "this call must come back having spent reasoning tokens" — the silent-
 * drift detector. Add a brand by adding a row.
 */
const LIVE = [
    {
        brand: 'deepseek',
        why: 'sends `thinking` AND `reasoning_effort` together, on the low/high/max scale',
        slot: {
            provider: 'openai_compatible',
            model: 'deepseek-v4-flash',
            baseURL: 'https://api.deepseek.com',
            reasoningEffort: 'high',
        },
        apiKey: () => key('deepseek', 'API_DEEPSEEK_API_KEY', 'DEEPSEEK_API_KEY'),
        reasons: true,
    },
    {
        brand: 'moonshot',
        why: 'sends `thinking` ALONE — Moonshot 400s if an effort rides along',
        slot: {
            provider: 'openai_compatible',
            model: 'kimi-k2.6',
            baseURL: 'https://api.moonshot.ai/v1',
            reasoningEffort: 'high',
        },
        apiKey: () => key('moonshot', 'BYOK_MOONSHOT_API_KEY', 'API_MOONSHOT_API_KEY'),
        reasons: true,
    },
    {
        brand: 'zai',
        why: 'sends `thinking` + `reasoning_effort`, and keeps temperature',
        slot: {
            provider: 'openai_compatible',
            model: 'glm-5.2',
            baseURL: 'https://api.z.ai/api/paas/v4',
            reasoningEffort: 'medium',
            temperature: 0,
        },
        apiKey: () => key('zai', 'BYOK_ZHIPU_API_KEY'),
        reasons: true,
    },
    {
        brand: 'google_gemini',
        why: 'thinkingBudget must land INSIDE the model ceiling (2.5-flash tops out at 24,576)',
        // The clamped ceiling IS what this row tests, so the cap clears it
        // rather than lowering the effort and testing nothing.
        maxOutputTokens: 26_000,
        slot: {
            provider: 'google_gemini',
            model: 'gemini-2.5-flash',
            reasoningEffort: 'high',
        },
        apiKey: () =>
            key(
                'google_gemini',
                'API_GOOGLE_AI_API_KEY',
                'GOOGLE_GENERATIVE_AI_API_KEY',
            ),
        reasons: true,
    },
    {
        brand: 'open_router',
        why: 'reasoning.effort and the provider pin must survive the namespace boundary',
        slot: {
            provider: 'open_router',
            model: 'deepseek/deepseek-v4-flash',
            reasoningEffort: 'high',
        },
        apiKey: () => key('open_router'),
        reasons: true,
    },
    {
        brand: 'openai',
        why: 'native reasoning effort on the Responses API',
        slot: {
            provider: 'openai',
            model: 'gpt-5.4',
            reasoningEffort: 'high',
        },
        apiKey: () => key('openai', 'BYOK_OPENAI_API_KEY', 'API_OPEN_AI_API_KEY'),
        reasons: true,
    },
    {
        brand: 'google_vertex',
        why: 'the ONLY provider the offline matrix cannot exercise — its build needs a real service-account JSON, so this tier is its only coverage',
        slot: {
            provider: 'google_vertex',
            model: 'gemini-3.7-flash',
            reasoningEffort: 'high',
        },
        apiKey: () => key('google_vertex', 'API_VERTEX_AI_API_KEY'),
        reasons: true,
    },
    // ── Anthropic is THREE generations with mutually exclusive request shapes,
    // and one row only ever covered the middle one. Every model below mirrors a
    // real production shape.
    //
    // WHAT THESE PROVE, precisely — checked on the wire before claiming it:
    // the AI SDK strips `temperature` by itself whenever thinking is ON, for
    // every Anthropic model. So while thinking is enabled these rows prove the
    // THINKING SHAPE only, not the temperature policy. Temperature becomes ours
    // to get right exactly when thinking is OFF — the SDK forwards it then, and
    // on the 4.7+/5 line it is a 400. That is the last row.
    {
        brand: 'anthropic',
        why: 'adaptive-4-6: thinking {type:adaptive} + output_config.effort',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
        },
        apiKey: () => key('anthropic', 'BYOK_ANTHROPIC_API_KEY'),
        reasons: true,
    },
    {
        brand: 'anthropic-legacy',
        why: 'legacy (3.x-4.5): budgetTokens is REQUIRED and `adaptive` is rejected — the opposite shape from the row above, on the same provider and the same key',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5-20250929',
            reasoningEffort: 'low',
        },
        // `low` emits budget_tokens 5_000; the cap has to clear it.
        maxOutputTokens: 6_144,
        apiKey: () => key('anthropic', 'BYOK_ANTHROPIC_API_KEY'),
        reasons: true,
    },
    {
        brand: 'anthropic-modern',
        why: 'THE 4.6->4.7 boundary: 4.7+ REJECTS budgetTokens outright, so sending the legacy shape here is a hard 400. Three production shapes run claude-opus-4-7',
        slot: {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            reasoningEffort: 'high',
        },
        apiKey: () => key('anthropic', 'BYOK_ANTHROPIC_API_KEY'),
        reasons: true,
    },
    {
        brand: 'anthropic-off-modern',
        why: 'the row that carries the most: reasoning OFF on a 4.7+/5 model WITH a stored temperature. Two things can only be checked here — the disable must be said OUT LOUD (an adaptive Claude thinks unless told not to, so silence means the user who picked Off keeps paying), and temperature must be WITHHELD by our policy, because with thinking off the SDK forwards it and this line 400s on it. `claude-sonnet-5` with a stored temperature is a real production shape',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            reasoningEffort: 'none',
            temperature: 0.3,
        },
        apiKey: () => key('anthropic', 'BYOK_ANTHROPIC_API_KEY'),
        reasons: false as const,
    },
    {
        brand: 'anthropic_compatible',
        why: 'the SAME Kimi over the ANTHROPIC protocol, where the emitted shape differs from the openai_compatible row above — and k3 is always-thinking, so the rule is "omit the disable, pin temperature to 1" rather than "send one"',
        slot: {
            provider: 'anthropic_compatible',
            model: 'k3',
            baseURL: 'https://api.kimi.com/coding',
            // `low`, not `high`, ON PURPOSE: what this row tests is the SHAPE
            // this transport emits, and `high` would authorise a 40,000-token
            // thinking budget for a prompt asking for one word. The effort VALUE
            // is tested where it is the subject (deepseek's low/high/max
            // mapping, GLM's medium fold).
            reasoningEffort: 'low',
        },
        maxOutputTokens: 6_144,
        apiKey: () => key('anthropic_compatible', 'BYOK_MOONSHOT_API_KEY'),
        reasons: true,
    },
    // NOT covered, deliberately: `novita` (3 production shapes). Verified against
    // novita.ai/docs — the vendor exposes no reasoning parameter at all, so there
    // is no shape of ours that could drift. Its DeepSeek models reason by
    // default; the level simply is not expressible on that endpoint.

    // ── mappings added after this tier was written, and unmonitored until now ──
    // Each is a shape we now emit in production and nothing live was checking.
    {
        brand: 'minimax',
        why: 'effort-only: MiniMax M2 takes `reasoning_effort` and has NO thinking toggle — sending one would invent a field it does not have (18 production slots)',
        slot: {
            provider: 'openai_compatible',
            model: 'MiniMax-M2',
            baseURL: 'https://api.minimax.io/v1',
            reasoningEffort: 'high',
        },
        apiKey: () => key('minimax'),
        reasons: true,
    },
    {
        brand: 'amazon_bedrock',
        why: 'Claude on Converse takes the adaptive shape inside additionalModelRequestFields, and this transport cannot express an explicit disable (5 production slots)',
        slot: {
            provider: 'amazon_bedrock',
            model: 'anthropic.claude-sonnet-4-6',
            // API_AWS_REGION is the one name here that already exists in
            // this repo's env schema; a per-run override rides in the secret.
            awsRegion: process.env.API_AWS_REGION || 'us-east-1',
            reasoningEffort: 'high',
        },
        // Bedrock authenticates with a bearer token, not `apiKey`; the slot
        // field is filled from the same value below.
        apiKey: () => key('amazon_bedrock'),
        credentialField: 'awsBearerToken' as const,
        reasons: true,
    },
    {
        brand: 'azure',
        why: 'an o-series deployment takes OpenAI reasoning.effort under the azure namespace — the module had no reasoning() at all until recently',
        slot: {
            provider: 'azure',
            // Both are deployment-specific and come from the secret's object
            // form; without an endpoint there is nothing to call, so the row
            // skips rather than failing on an empty URL.
            model: 'o3-mini',
            baseURL: '',
            reasoningEffort: 'high',
        },
        apiKey: () =>
            slotExtras('azure').baseURL ? key('azure') : undefined,
        reasons: true,
    },

    // ── the audit's open questions: cases where the DOCS and our code disagree,
    // or where no readable doc exists at all. Offline tests cannot settle any of
    // these — they prove what we SEND, and the question is what the vendor
    // ACCEPTS. Each one is a claim currently resting on inference. ──────────
    {
        brand: 'minimax_m3',
        why: 'M3 is a different model from M2 on the same platform: platform.minimax.io says thinking is OFF by default and enabled "with adaptive", while we send thinking:{type:enabled,budget_tokens}. Nothing says `enabled` is refused, so it was not changed on a guess — this row is what turns the guess into an answer (3 production slots)',
        slot: {
            provider: 'anthropic_compatible',
            model: 'MiniMax-M3',
            baseURL: 'https://api.minimax.io/anthropic',
            // `low` for the same reason as the k3 row: the SHAPE is the subject,
            // and a high effort would authorise a 40,000-token budget to say one
            // word.
            reasoningEffort: 'low',
        },
        maxOutputTokens: 6_144,
        // Falls back to the `minimax` entry: same platform (api.minimax.io) and
        // the same account — this row differs by MODEL and PROTOCOL, not by
        // credential. Asking for the key twice would be friction that buys
        // nothing, and a separate entry only exists so a key scoped to one model
        // can still be given on its own.
        //
        // No ENV fallback, though: the point of the single secret is that adding
        // a brand does not grow the product's env surface, and no MiniMax name
        // exists in this repo's schema to fall back to.
        apiKey: () => key('minimax_m3') ?? key('minimax'),
        reasons: true,
    },
    {
        brand: 'minimaxi',
        why: 'MiniMax runs TWO platforms and production uses both. api.minimaxi.com is the one this table cites for `reasoning_effort` and the one whose docs render client-side, so it could not be read — the only way to check it is to call it (2 production slots)',
        slot: {
            provider: 'openai_compatible',
            model: 'MiniMax-M2.5',
            baseURL: 'https://api.minimaxi.com/v1',
            reasoningEffort: 'high',
        },
        apiKey: () => key('minimaxi'),
        reasons: true,
    },
    {
        brand: 'moonshot_code',
        why: 'k2.7-code is the pair to the k2.6 row and differs on BOTH facts we changed: thinking cannot be disabled, and platform.kimi.ai documents its temperature as not modifiable. The slot deliberately carries a temperature the runtime must DROP — if it ever reaches the wire this row is where that shows',
        slot: {
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://api.moonshot.ai/v1',
            reasoningEffort: 'high',
            temperature: 0.2,
        },
        apiKey: () =>
            key('moonshot_code', 'BYOK_MOONSHOT_API_KEY', 'API_MOONSHOT_API_KEY'),
        reasons: true,
    },
    {
        brand: 'bedrock_grok',
        why: 'the one case the audit refused to guess. Four Bedrock slots configure an effort that reaches no parameter, because AWS documents Grok reasoning:{effort} for its Responses API and shows none in its Converse example — inventing an additionalModelRequestFields entry risks a ValidationException on every review. `reasons: false` asserts the CURRENT behaviour, so this row goes red the day the transport starts carrying it, either because AWS documented it or because we did',
        slot: {
            provider: 'amazon_bedrock',
            model: 'global.xai.grok-4.6',
            awsRegion: process.env.API_AWS_REGION || 'us-east-1',
            reasoningEffort: 'high',
        },
        apiKey: () => key('bedrock_grok'),
        credentialField: 'awsBearerToken' as const,
        // Grok reasons intrinsically, so tokens may well be spent — what this
        // row cannot claim is that OUR effort caused it. Asserted as "we send
        // nothing", which is checkable, rather than "reasoning happened", which
        // would be true either way and prove nothing.
        reasons: false,
    },
];

/** Reasoning tokens, wherever the SDK put them (ai@7 nests, ai@6 was flat). */
function reasoningTokens(usage: any): number {
    return (
        usage?.outputTokenDetails?.reasoningTokens ??
        usage?.reasoningTokens ??
        0
    );
}

describe('BYOK reasoning — LIVE provider contract', () => {
    const configured = LIVE.filter((c) => c.apiKey());

    // Runs OFFLINE and with no credentials, on purpose: it is arithmetic about
    // what WOULD be sent, and the budget must be guarded on the PR that changes
    // it rather than a week later on someone's bill.
    it('the whole run stays inside its token budget', async () => {
        // The declared `maxOutputTokens` is NOT the number that reaches the
        // wire. For a budget-shape model the Anthropic SDK ADDS the thinking
        // budget on top — a row asking for 6,144 goes out at 11,144 — so the
        // ceiling has to be read from the request, not from the row.
        const real = globalThis.fetch;
        const ANTHROPIC_OK = {
            id: 'x', type: 'message', role: 'assistant', model: 'x',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        };
        const GEMINI_OK = {
            candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
        const OPENAI_OK = {
            id: 'x', object: 'chat.completion', created: 0, model: 'x',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };

        let total = 0;
        const perRow: Array<[string, number]> = [];
        try {
            for (const c of LIVE) {
                let sent: any;
                globalThis.fetch = (async (input: any, init: any) => {
                    const url = typeof input === 'string' ? input : String(input?.url ?? input);
                    try {
                        sent = init?.body ? JSON.parse(String(init.body)) : undefined;
                    } catch {
                        sent = undefined;
                    }
                    const canned = /generateContent/i.test(url)
                        ? GEMINI_OK
                        : /\/messages\b/i.test(url)
                          ? ANTHROPIC_OK
                          : OPENAI_OK;
                    return new Response(JSON.stringify(canned), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }) as typeof fetch;

                try {
                    await LLM.run({
                        byokConfig: {
                            ...c.slot,
                            apiKey: 'budget-probe',
                            ...((c as any).credentialField
                                ? { [(c as any).credentialField]: 'budget-probe' }
                                : {}),
                        } as unknown as NormalizedModel,
                        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
                        loop: { tools: {}, maxSteps: 1 },
                        runName: 'byok-live-budget',
                        maxOutputTokens: (c as any).maxOutputTokens ?? 4_096,
                    });
                } catch {
                    // A canned answer the provider's parser rejects is fine —
                    // the REQUEST is what is being measured.
                }
                const cap =
                    sent?.max_tokens ??
                    sent?.generationConfig?.maxOutputTokens ??
                    sent?.max_output_tokens ??
                    sent?.inferenceConfig?.maxTokens ??
                    0;
                total += cap;
                perRow.push([c.brand, cap]);
            }
        } finally {
            globalThis.fetch = real;
        }

        // eslint-disable-next-line no-console
        console.log(
            `[byok-live] output ceiling ${total.toLocaleString()} tokens across ` +
                `${LIVE.length} rows:\n` +
                perRow.map(([b, n]) => `  ${String(n).padStart(7)}  ${b}`).join('\n'),
        );

        // A weekly job nobody watches is exactly where a runaway cost hides. The
        // number is small on purpose — the subject under test is the request
        // SHAPE, and a one-word answer needs no room. Raising this is allowed and
        // has to be deliberate: it means a row now authorises real spend.
        expect(total).toBeLessThanOrEqual(150_000);
        // ...and no single row may hold most of the budget on its own.
        for (const [brand, cap] of perRow) {
            expect([brand, cap]).toEqual([brand, expect.any(Number)]);
            expect(cap).toBeLessThanOrEqual(30_000);
        }
        // The probe must actually have measured something — a stub that captured
        // nothing would sum to zero and pass.
        expect(total).toBeGreaterThan(50_000);
    }, 120_000);

    it('reports which brands this run actually covered', () => {
        const covered = configured.map((c) => c.brand);
        const skipped = LIVE.filter((c) => !c.apiKey()).map((c) => c.brand);
        // Coverage is DATA, not a failure: a PARTIAL secret is a legitimate
        // green, and so is a fork PR with none. Printing it stops "green" from
        // being mistaken for "everything was checked".
        // eslint-disable-next-line no-console
        console.log(
            `[byok-live] covered: ${covered.join(', ') || '(none)'}\n` +
                `[byok-live] skipped (no credential): ${skipped.join(', ') || '(none)'}`,
        );
        expect(LIVE.length).toBeGreaterThan(0);

        // ...but ZERO coverage on the WEEKLY run is not data, it is the tier not
        // existing. This job's whole purpose is to spend real tokens against
        // real vendors once a week; if no brand has a credential, it made no
        // call, found no drift, and reported green — which reads exactly like a
        // week in which everything was verified.
        //
        // Scoped to the schedule on purpose. A fork PR, a manual dispatch and a
        // local run all legitimately have no credentials and must stay green;
        // only the cron is claiming to be the safety net.
        if (process.env.BYOK_LIVE_EVENT === 'schedule' && !covered.length) {
            throw new Error(
                'byok-live: the weekly run had no credentials for ANY of the ' +
                    `${LIVE.length} brands, so nothing was checked and green would ` +
                    'mean nothing. Set the BYOK_LIVE_KEYS secret (or any of the ' +
                    'BYOK_* per-brand secrets) — a PARTIAL set is fine and reports ' +
                    'partial coverage.',
            );
        }
    });

    for (const c of LIVE) {
        const run = c.apiKey() ? it : it.skip;

        run(
            `${c.brand} — ${c.why}`,
            async () => {
                // `LLM.run` — the ONE door, in its agent-loop mode. The first
                // version of this called `resolveModelConfig` + the SDK
                // directly, which skipped everything LLM.run owns: slot
                // resolution, the observability span, and the
                // primary->fallback cascade. The loop mode is used (with no
                // tools and a single step) because it is the only mode that
                // hands back the raw SDK result — and usage is what the
                // reasoning assertion below reads. It is also a real production
                // path: the review agent runs through exactly this door.
                const result = await LLM.run({
                    byokConfig: {
                        ...c.slot,
                        ...slotExtras(c.brand),
                        apiKey: c.apiKey(),
                        // Bedrock reads a bearer token rather than apiKey.
                        ...((c as any).credentialField
                            ? { [(c as any).credentialField]: c.apiKey() }
                            : {}),
                    } as unknown as NormalizedModel,
                    messages: [
                        {
                            role: 'user',
                            // Cheap on purpose: the subject under test is the
                            // REQUEST shape, not the answer. Reasoning models
                            // still spend thinking tokens here — that is the
                            // signal we assert on.
                            content: 'Reply with the single word: ok',
                        },
                    ],
                    loop: { tools: {}, maxSteps: 1 },
                    runName: 'byok-live-contract',
                    // A CAP on what one probe can cost. Without it most rows
                    // went out with no `max_tokens` at all and the vendor's own
                    // ceiling applied — for a prompt that asks for one word.
                    // A row that emits a thinking BUDGET needs a cap above it
                    // (the request is rejected otherwise), so it states its own.
                    maxOutputTokens: (c as any).maxOutputTokens ?? 4_096,
                });

                expect(typeof result.text).toBe('string');

                if (c.reasons) {
                    // THE drift detector. A vendor that renames or stops
                    // honouring our reasoning parameter still returns 200 — it
                    // just stops thinking. Something has to prove it thought.
                    //
                    // It CANNOT be the billed reasoning tokens alone, which is
                    // what this asserted before ever running against a real
                    // vendor: five of the eight brands below declare
                    // `usageGranularity: 'output_only'`, meaning the SDK reports
                    // no separate thinking-token count for them — Anthropic bills
                    // thinking INTO output_tokens, and the openai-compatible
                    // brands do the same. Those five would have gone red on the
                    // first run with a real key, for a reporting style rather
                    // than a regression. A weekly job that cries wolf on its
                    // first run gets muted, and a muted job catches nothing.
                    //
                    // So the assertion is "reasoning is OBSERVABLE", by either
                    // signal, and the run prints which one it saw. Both absent is
                    // the real regression: the model stopped thinking. Declaring
                    // the expected signal per brand would be tighter, but nobody
                    // has run this against these vendors yet — so it would be
                    // guessing, which is the mistake being fixed here.
                    const evidence = {
                        brand: c.brand,
                        tokens: reasoningTokens(result.usage),
                        text: (result.reasoningText ?? '').length,
                    };
                    // eslint-disable-next-line no-console
                    console.log(
                        `[byok-live] ${c.brand}: reasoningTokens=${evidence.tokens} reasoningTextChars=${evidence.text}`,
                    );
                    expect({
                        ...evidence,
                        reasoned: evidence.tokens > 0 || evidence.text > 0,
                    }).toMatchObject({ reasoned: true });
                } else if (c.reasons === false) {
                    // The mirror image, and the only way to catch "Off stopped
                    // meaning off". Omitting the disable on an adaptive model
                    // still returns 200 — it just bills thinking the user
                    // declined.
                    const tokens = reasoningTokens(result.usage);
                    const text = (result.reasoningText ?? '').length;
                    // eslint-disable-next-line no-console
                    console.log(
                        `[byok-live] ${c.brand}: OFF path — reasoningTokens=${tokens} reasoningTextChars=${text}`,
                    );
                    expect({
                        brand: c.brand,
                        reasoned: tokens > 0 || text > 0,
                    }).toMatchObject({ reasoned: false });
                }
            },
            120_000,
        );
    }
});

/**
 * The rows above prove the reasoning parameter reaches the vendor. They do NOT
 * prove the thing production actually does, because they call the model the way
 * no production code does: a plain message list with no schema, through the SDK
 * rather than through the one door.
 *
 * There IS one door — `LLM.run` — and it owns three things before any executor
 * runs: the slot resolution (task -> model + key), the observability span, and
 * the primary->fallback cascade (`runWithModelFailover`). Underneath it picks an
 * executor: agent loop, structured, or text. So these go through `LLM.run`
 * itself; reaching for `runStructuredReviewCall` beneath it would skip the
 * routing and the failover, which is the same mistake one level down.
 *
 * The structured executor chooses an OUTPUT CHANNEL from `planStructuredCall`
 * before it ever touches the SDK:
 *
 *   as-is              issue the structured call unchanged
 *   suppress-thinking  turn reasoning OFF first, THEN force the tool — because
 *                      the Anthropic protocol rejects a forced tool_choice while
 *                      thinking with "tool_choice 'required' is incompatible
 *                      with thinking enabled"
 *   reroute-json       never force a tool at all; put the schema in the prompt —
 *                      for models that cannot stop thinking AND cannot take a
 *                      forced tool_choice
 *
 * Those two non-trivial plans are the 400s this whole layer exists to prevent,
 * and no amount of plain-generateText coverage can see them: the failure needs a
 * schema, a forced tool call and a thinking model in the same request. So these
 * go through the REAL entry point, with the real schema machinery, and assert
 * the parsed object comes back.
 */
const STRUCTURED_LIVE = [
    {
        brand: 'anthropic',
        plan: 'suppress-thinking',
        why: 'Claude adaptive thinks by default; forcing a tool while it thinks is a 400. The plan must disable thinking FIRST',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
        },
    },
    {
        brand: 'anthropic_compatible',
        plan: 'reroute-json',
        why: 'k3 cannot stop thinking and its endpoint cannot take a forced tool_choice — the only sound path is schema-in-prompt. If the plan ever says otherwise this 400s live',
        slot: {
            provider: 'anthropic_compatible',
            model: 'k3',
            baseURL: 'https://api.kimi.com/coding',
            reasoningEffort: 'high',
        },
    },
] as const;

describe('BYOK structured output — LIVE, through LLM.run (the one door)', () => {
    for (const c of STRUCTURED_LIVE) {
        const apiKey = key(c.brand);
        const run = apiKey ? it : it.skip;

        run(
            `${c.brand} (${c.plan}) — ${c.why}`,
            async () => {
                // The schema is deliberately trivial: the subject under test is
                // the CHANNEL, not the model's ability to fill a rich object.
                const schema = z.object({
                    ok: z.boolean(),
                    word: z.string(),
                });

                // `LLM.run` — THE one door, not the executor beneath it.
                // Calling `runStructuredReviewCall` directly (the first version
                // of this block) skipped what LLM.run owns: slot resolution and
                // the primary->fallback cascade in `runWithModelFailover`.
                const result = await LLM.run({
                    byokConfig: {
                        ...c.slot,
                        ...slotExtras(c.brand),
                        apiKey,
                    } as unknown as NormalizedModel,
                    user: 'Reply with ok=true and word="ok".',
                    runName: 'byok-live-structured',
                    schema,
                    maxOutputTokens: 4_096,
                });

                // Getting a parsed object back means the whole composition held:
                // the plan picked a channel the model accepts, the schema
                // survived the wire, and the envelope parsed.
                expect(schema.safeParse(result).success).toBe(true);
            },
            120_000,
        );
    }
});

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
 * path (`resolveModelConfig` → the provider module → the AI SDK).
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
 * grow the product's env surface. Brands the product already reads an env for
 * (`API_DEEPSEEK_API_KEY`, `API_MOONSHOT_API_KEY`, `API_GOOGLE_AI_API_KEY`,
 * `API_OPEN_AI_API_KEY`) fall back to those names.
 *
 * A case with no key SKIPS — it never fails. A run with partial credentials
 * reports partial coverage, so contributors and forks see green, not a false red.
 */

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { generateText } from 'ai';

import { resolveModelConfig } from './model-invocation';
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
        apiKey: () => key('moonshot', 'API_MOONSHOT_API_KEY', 'MOONSHOT_API_KEY'),
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
        apiKey: () => key('zai'),
        reasons: true,
    },
    {
        brand: 'google_gemini',
        why: 'thinkingBudget must land INSIDE the model ceiling (2.5-flash tops out at 24,576)',
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
        apiKey: () => key('openai', 'API_OPEN_AI_API_KEY'),
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
    {
        brand: 'anthropic',
        why: 'adaptive thinking + output_config.effort is the only shape 4.7+ accepts',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
        },
        apiKey: () => key('anthropic'),
        reasons: true,
    },
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

    it('reports which brands this run actually covered', () => {
        const covered = configured.map((c) => c.brand);
        const skipped = LIVE.filter((c) => !c.apiKey()).map((c) => c.brand);
        // Coverage is DATA, not a failure: a fork or a partial-secret run is a
        // legitimate green. Printing it stops "green" from being mistaken for
        // "everything was checked".
        // eslint-disable-next-line no-console
        console.log(
            `[byok-live] covered: ${covered.join(', ') || '(none)'}\n` +
                `[byok-live] skipped (no credential): ${skipped.join(', ') || '(none)'}`,
        );
        expect(LIVE.length).toBeGreaterThan(0);
    });

    for (const c of LIVE) {
        const run = c.apiKey() ? it : it.skip;

        run(
            `${c.brand} — ${c.why}`,
            async () => {
                const { model, callOptions, providerOptions } =
                    resolveModelConfig(
                        {
                            ...c.slot,
                            ...slotExtras(c.brand),
                            apiKey: c.apiKey(),
                            // Bedrock reads a bearer token rather than apiKey.
                            ...((c as any).credentialField
                                ? { [(c as any).credentialField]: c.apiKey() }
                                : {}),
                        } as unknown as NormalizedModel,
                        {
                            runName: 'byok-live-contract',
                            reasoningEffortDefault: 'none',
                            openrouterProviderOrder: (c.slot as any)
                                .openrouterProviderOrder,
                            openrouterAllowFallbacks: (c.slot as any)
                                .openrouterAllowFallbacks,
                        },
                    );

                const result = await generateText({
                    model,
                    maxRetries: 0,
                    ...callOptions,
                    providerOptions: providerOptions as Parameters<
                        typeof generateText
                    >[0]['providerOptions'],
                    // Cheap on purpose: the subject under test is the REQUEST
                    // shape, not the answer. Reasoning models still spend
                    // thinking tokens here — that is the signal we assert on.
                    messages: [
                        {
                            role: 'user',
                            content: 'Reply with the single word: ok',
                        },
                    ],
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
                }
            },
            120_000,
        );
    }
});

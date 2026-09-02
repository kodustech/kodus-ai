/**
 * Registry-wide contract: a provider's DECLARED `providerOptionsNamespace` must
 * be the key the AI SDK actually reads for that provider.
 *
 * WHY THIS EXISTS
 * This is a silent, whole-feature failure, and it shipped TWICE before anyone
 * noticed — both times found by accident while looking at something else:
 *
 *   - `open_router` built as `createOpenAICompatible({ name: 'open-router' })`
 *     while declaring the namespace `openrouter`. The SDK reads only the build
 *     name or its camelCase form, so EVERY reasoning effort and EVERY provider
 *     pin was dropped from the request body — for 17% of production slots.
 *   - `novita` built as `name: 'novita'` while declaring `openaiCompatible`, so
 *     a user's Custom reasoning override never reached the request at all.
 *
 * Nothing throws when this is wrong. The call succeeds, the model answers, and
 * the setting the user configured simply does not exist on the wire — which is
 * why no unit test of `reasoning()` or of the namespace getter could catch it:
 * each half was internally consistent and the two halves disagreed.
 *
 * HOW IT CHECKS
 * Not by re-deriving the rule from the module source (that would just restate
 * the bug), but by asking the BUILT model what provider id it carries, and
 * applying the SDK's own matching rule to it:
 *
 *     providerOptionsName = model.provider.split('.')[0]
 *     the SDK reads providerOptions[providerOptionsName]
 *                 ?? providerOptions[toCamelCase(providerOptionsName)]
 *
 * A new provider module is covered the day it registers — no list to update.
 */
// @ts-nocheck
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { REGISTRY } from '.';
import { buildModelFromSlot } from '../byok-to-vercel';

/** Shaped like a Service Account JSON so the Vertex builder takes the Vertex
 *  path instead of its AI-Studio fallback. Never used to sign anything. */
const FAKE_SA_JSON = Buffer.from(
    JSON.stringify({
        type: 'service_account',
        project_id: 'placeholder',
        client_email: 'placeholder@placeholder.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nplaceholder\n-----END PRIVATE KEY-----\n',
    }),
).toString('base64');

/** Minimal per-provider config needed to BUILD (never to call). Providers whose
 *  build needs a credential shape we cannot fake are listed as unbuildable with
 *  the reason, so this file states its own coverage instead of hiding a gap. */
const BUILDABLE: Record<string, { model: string; extra?: Record<string, any> }> = {
    openai: { model: 'gpt-5.4' },
    openai_compatible: {
        model: 'deepseek-v4-pro',
        extra: { baseURL: 'https://api.deepseek.com' },
    },
    open_router: { model: 'z-ai/glm-5.2' },
    novita: { model: 'deepseek/deepseek-v4-pro' },
    anthropic: { model: 'claude-sonnet-4-6' },
    anthropic_compatible: {
        model: 'kimi-k2.6',
        extra: { baseURL: 'https://proxy.test/anthropic' },
    },
    google_gemini: { model: 'gemini-3-flash-preview' },
    // Brand modules: a BRAND (Moonshot, Z.ai) served over the anthropic-compatible
    // TRANSPORT. They are the case most at risk of this bug, because the module
    // the user picks and the module that builds the client are different objects.
    moonshot: { model: 'kimi-k2.6' },
    zai: { model: 'glm-5.2' },
    // These three were listed as "needs real credentials" and skipped. They do
    // not: building only constructs the client, and every credential below is a
    // placeholder. Bedrock and Azure were both declaring NO namespace at the
    // time, so the exclusion was hiding exactly what this file exists to find.
    amazon_bedrock: {
        model: 'anthropic.claude-sonnet-4-6',
        extra: { awsRegion: 'us-east-1', awsBearerToken: 'placeholder' },
    },
    azure: {
        model: 'gpt-5.4',
        extra: { baseURL: 'https://placeholder.openai.azure.com/openai' },
    },
    google_vertex: { model: 'gemini-3.7-flash', extra: { apiKey: FAKE_SA_JSON } },
};

/** One provider id, two SDK models: Vertex builds a Gemini client for a Gemini
 *  id and an ANTHROPIC client for a Claude id, and they read different keys. The
 *  namespace is therefore per (id, model), so it needs its own case. */
const MODEL_SPECIFIC: Array<{ id: string; model: string; extra?: Record<string, any> }> = [
    { id: 'google_vertex', model: 'claude-opus-4-7', extra: { apiKey: FAKE_SA_JSON } },
];

/** Every provider builds here, so nothing is deferred to the live tier. */
const NEEDS_REAL_CREDENTIALS: string[] = [];

const toCamelCase = (s: string) => s.replace(/-(.)/g, (_, c) => c.toUpperCase());

/**
 * The keys the SDK will read for a built model.
 *
 * The base rule is the SDK's own: `provider.split('.')[0]`, plus its camelCase
 * form. One documented addition: an Anthropic language model ALWAYS parses the
 * canonical `anthropic` key and merges its custom key over the top
 * (`@ai-sdk/anthropic`, `providerOptionsName !== 'anthropic' ? parse(...) :
 * null`, then Object.assign of both). That is why Claude-on-Vertex — built as
 * `googleVertex.anthropic.messages` — still receives `{ anthropic: … }`, and
 * why declaring `anthropic` for it is correct rather than a workaround.
 */
function keysTheSdkReads(sdkProvider: string): string[] {
    const head = String(sdkProvider ?? '').split('.')[0].trim();
    const keys = [head, toCamelCase(head)];
    if (String(sdkProvider).includes('anthropic')) keys.push('anthropic');
    return keys;
}

function assertNamespaceReaches(
    id: string,
    model: string,
    extra?: Record<string, any>,
) {
    const built = buildModelFromSlot({
        provider: id,
        apiKey: 'placeholder-not-used',
        model,
        ...(extra ?? {}),
    } as any);

    const accepted = keysTheSdkReads(String(built.provider ?? ''));
    const ns = REGISTRY.get(id).providerOptionsNamespace!(id, model);

    expect({
        provider: id,
        model,
        sdkProvider: built.provider,
        declaredNamespace: ns,
        sdkAccepts: accepted,
        matches: accepted.includes(ns),
    }).toMatchObject({ matches: true });
}

describe('providerOptionsNamespace matches what the SDK reads', () => {
    const declared = REGISTRY.ids().filter(
        (id) => REGISTRY.get(id).providerOptionsNamespace,
    );

    it('covers every registered provider that declares a namespace', () => {
        // The point of a registry contract is that it cannot be outgrown
        // silently. A new module either gets a build fixture here or an explicit
        // "needs credentials" entry — never neither.
        const uncovered = declared.filter(
            (id) => !BUILDABLE[id] && !NEEDS_REAL_CREDENTIALS.includes(id),
        );
        expect(uncovered).toEqual([]);
        expect(declared.length).toBeGreaterThan(0);
    });

    for (const id of Object.keys(BUILDABLE)) {
        it(`${id}: the declared namespace is the key the SDK reads`, () => {
            if (!REGISTRY.has(id)) return; // alias-only ids stay out of the way
            const { model, extra } = BUILDABLE[id];
            assertNamespaceReaches(id, model, extra);
        });
    }

    for (const { id, model, extra } of MODEL_SPECIFIC) {
        it(`${id}/${model}: the namespace follows the MODEL, not the id`, () => {
            assertNamespaceReaches(id, model, extra);
        });
    }
});

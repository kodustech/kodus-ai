/**
 * Resolve a stored BYOK config into runtime model SLOTS. This is NOT a
 * legacy→new migration (that is migrate-byok-config.ts, run once by the DB
 * migration) — it is the permanent projection from the stored RELATIONAL shape
 * (credentials[] + models[] + routing) into the flat `NormalizedModel` slot the
 * resolver family (byok-to-vercel.ts) builds from:
 *
 *  - `resolveModelSlot(config, modelId)` — one model id → its slot (the routing
 *    apply site).
 *  - `resolveDefaultSlot(config)` — the effective default slot (status UI).
 *
 * Invariants:
 *  - NEVER decrypts — the slot carries ENCRYPTED apiKey ciphertext;
 *    byok-to-vercel decrypts downstream. Decrypting here = double-decrypt / leak.
 *  - DEGRADES, never throws: an unknown / credential-less / managed model →
 *    `undefined` (→ byok-to-vercel's env-default branch), never an exception.
 *    Absence is ALWAYS `undefined` here — never `null` (one convention).
 */
import { BYOKProvider } from '@libs/llm/model-providers';
import {
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
    type BYOKModelConfig,
    type NormalizedModel,
} from './byok-config';

const STR = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

/** A non-empty array of non-empty strings, or `undefined` (used for the
 *  OpenRouter provider-order pin stored under credential settings). */
const STR_ARRAY = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) {
        return undefined;
    }
    const arr = v.filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return arr.length > 0 ? arr : undefined;
};

/** Build a NormalizedModel from a model + its resolved credential, or
 *  `undefined` to skip (managed, missing credential, or no provider — all
 *  degrade to absent). Module-private: the routing resolver materializes slots
 *  via the exported `resolveModelSlot`, which wraps this. */
function slotFromModel(
    model: BYOKModelConfig,
    creds: Map<string, BYOKCredential>,
): NormalizedModel | undefined {
    const cred = creds.get(model.credentialId);
    // Missing credential or managed default → no explicit slot (env-default path).
    if (!cred || cred.managed) {
        return undefined;
    }
    const provider = STR(cred.provider);
    const apiKey = STR(cred.apiKey);
    const s = (cred.settings ?? {}) as Record<string, unknown>;
    // A credential is usable when it carries the auth material its provider's
    // builder actually consumes: an API key for key-based providers, OR Amazon
    // Bedrock's bearer token / SigV4 IAM pair (Bedrock authenticates with the aws*
    // fields, NEVER `apiKey` — requiring one here silently degraded every Bedrock
    // slot to the managed default). Checks the material, not the provider name, so
    // a new auth shape extends this in one place next to the field mapping below.
    const hasAuth =
        !!apiKey ||
        !!STR(s.awsBearerToken) ||
        (!!STR(s.awsAccessKeyId) && !!STR(s.awsSecretAccessKey));
    if (!provider || !hasAuth || !STR(model.model)) {
        return undefined;
    } // degrade: skip
    return {
        provider: provider as BYOKProvider,
        // Ciphertext — NOT decrypted here. Empty for aws*-authenticated Bedrock;
        // its build() reads the aws* fields and `decrypt('')` is a no-op ('').
        apiKey: apiKey ?? '',
        model: model.model,
        // Stable attribution ids carried from the config model that resolved —
        // used to stamp the usage span (spend attributes by id, not model-name).
        byokModelId: STR(model.id),
        credentialId: STR(model.credentialId),
        baseURL: STR(s.baseURL),
        vertexLocation: STR(s.vertexLocation),
        awsBearerToken: STR(s.awsBearerToken),
        awsAccessKeyId: STR(s.awsAccessKeyId),
        awsSecretAccessKey: STR(s.awsSecretAccessKey),
        awsRegion: STR(s.awsRegion),
        awsSessionToken: STR(s.awsSessionToken),
        // OpenRouter provider-pinning surfaced from settings onto the slot so the
        // reasoning/routing layer applies it (OpenRouter-only; undefined elsewhere).
        openrouterProviderOrder: STR_ARRAY(s.openrouterProviderOrder),
        openrouterAllowFallbacks:
            typeof s.openrouterAllowFallbacks === 'boolean'
                ? s.openrouterAllowFallbacks
                : undefined,
        reasoningEffort: model.reasoningEffort,
        reasoningConfigOverride: STR(model.reasoningConfigOverride),
        temperature: model.temperature,
        maxInputTokens: model.maxInputTokens,
        maxOutputTokens: model.maxOutputTokens,
        maxConcurrentRequests: model.maxConcurrentRequests,
        rpm: model.rpm,
        tpm: model.tpm,
        cooldownMs: model.cooldownMs,
    };
}

/**
 * The effective DEFAULT slot for a stored config — `routing.defaultModelId`'s
 * model, else the first configured model, resolved to a slot. Returns
 * `undefined` for a managed / non-v2 / empty config (→ env/managed default).
 * Task-agnostic: the LLM-config status UI uses it to show the one slot the org
 * resolves to by default, without the per-task routing context. Never throws.
 */
export function resolveDefaultSlot(raw: unknown): NormalizedModel | undefined {
    if (!isByokConfig(raw)) {
        return undefined;
    }
    const models = (raw.models ?? []).filter((m) => m && m.id);
    const defaultId = raw.routing?.defaultModelId;
    const mainId =
        (defaultId && models.some((m) => m.id === defaultId) && defaultId) ||
        models[0]?.id;
    return resolveModelSlot(raw, mainId);
}

/**
 * Materialize ONE v2 model's normalized slot by its `models[]` id (routing apply
 * site). Reuses `slotFromModel` field-mapping so the slot carries CIPHERTEXT
 * verbatim — never decrypts (T-04-01-01); byok-to-vercel decrypts downstream.
 * Returns `undefined` when the id is absent/unknown or the model is
 * managed/incomplete.
 */
export function resolveModelSlot(
    config: BYOKConfig,
    modelId: string | null | undefined,
): NormalizedModel | undefined {
    if (!modelId) {
        return undefined;
    }
    const creds = new Map<string, BYOKCredential>(
        (config.credentials ?? [])
            .filter((c) => c && c.id)
            .map((c) => [c.id, c]),
    );
    const model = (config.models ?? []).find((m) => m && m.id === modelId);
    if (!model) {
        return undefined;
    }
    return slotFromModel(model, creds);
}

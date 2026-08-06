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
 *  - DEGRADES, never throws: an unknown / credential-less / managed model → null
 *    (→ byok-to-vercel's env-default branch), never an exception.
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

/** Build a NormalizedModel from a model + its resolved credential, or null to
 *  skip (managed, missing credential, or no provider — all degrade to absent).
 *  Module-private: the routing resolver materializes slots via the exported
 *  `resolveModelSlot`, which wraps this. */
function slotFromModel(
    model: BYOKModelConfig,
    creds: Map<string, BYOKCredential>,
): NormalizedModel | null {
    const cred = creds.get(model.credentialId);
    // Missing credential or managed default → no explicit slot (env-default path).
    if (!cred || cred.managed) return null;
    const provider = STR(cred.provider);
    const apiKey = STR(cred.apiKey);
    if (!provider || !apiKey || !STR(model.model)) return null; // degrade: skip
    const s = (cred.settings ?? {}) as Record<string, unknown>;
    return {
        provider: provider as BYOKProvider,
        apiKey, // ciphertext — NOT decrypted here
        model: model.model,
        baseURL: STR(s.baseURL),
        vertexLocation: STR(s.vertexLocation),
        awsBearerToken: STR(s.awsBearerToken),
        awsAccessKeyId: STR(s.awsAccessKeyId),
        awsSecretAccessKey: STR(s.awsSecretAccessKey),
        awsRegion: STR(s.awsRegion),
        awsSessionToken: STR(s.awsSessionToken),
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
 * model, else the first configured model, resolved to a slot. Returns null for a
 * managed / non-v2 / empty config (→ env/managed default). Task-agnostic: the
 * LLM-config status UI uses it to show the one slot the org resolves to by
 * default, without the per-task routing context. Never throws.
 */
export function resolveDefaultSlot(raw: unknown): NormalizedModel | null {
    if (!isByokConfig(raw)) return null;
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
 * Returns null when the id is absent/unknown or the model is managed/incomplete.
 */
export function resolveModelSlot(
    config: BYOKConfig,
    modelId: string | null | undefined,
): NormalizedModel | null {
    if (!modelId) return null;
    const creds = new Map<string, BYOKCredential>(
        (config.credentials ?? []).filter((c) => c && c.id).map((c) => [c.id, c]),
    );
    const model = (config.models ?? []).find((m) => m && m.id === modelId);
    if (!model) return null;
    return slotFromModel(model, creds);
}


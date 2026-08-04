/**
 * The v2-only normalize adapter (Phase 2, plan 02-01; dual-read dropped 04b-06).
 *
 * Maps the shape to the internal `NormalizedByokConfig` the resolver family
 * (byok-to-vercel.ts) consumes. The legacy `{main,fallback}` stored shape is NO
 * LONGER read — a legacy blob normalizes to `{}` (env/managed default).
 *
 * Invariants:
 *  - NEVER decrypts — the internal shape carries ENCRYPTED apiKey ciphertext;
 *    byok-to-vercel decrypts downstream. Decrypting here = double-decrypt / leak.
 *  - DEGRADES, never throws: an unknown/credential-less model is skipped; a fully
 *    unusable config yields absent `main` (→ byok-to-vercel's env-default branch).
 *  - A `managed:true` credential → absent `main` (the env/managed default), with
 *    no call-site branch.
 */
import { BYOKProvider } from '@libs/llm/model-providers';
import {
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
    type BYOKModelConfig,
    type NormalizedByokConfig,
    type NormalizedModel,
} from './byok-config';

const STR = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

/** Build a NormalizedModel from a model + its resolved credential, or null to
 *  skip (managed, missing credential, or no provider — all degrade to absent).
 *  Module-private: the routing resolver materializes slots via the exported
 *  `resolveModelSlot`, which wraps this. */
function slotFromV2(
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

function normalizeConfig(cfg: BYOKConfig): NormalizedByokConfig {
    const creds = new Map<string, BYOKCredential>(
        (cfg.credentials ?? []).filter((c) => c && c.id).map((c) => [c.id, c]),
    );
    const models = (cfg.models ?? []).filter((m) => m && m.id);
    // main = routing.defaultModelId's model, else the first model. fallback = the
    // next distinct usable model (routing EXECUTION is Phase 4; this is the compat
    // main/fallback the resolver reads, matching the migration's ordering).
    const byId = new Map(models.map((m) => [m.id, m]));
    const mainModel =
        (cfg.routing?.defaultModelId && byId.get(cfg.routing.defaultModelId)) ||
        models[0];
    const main = mainModel ? slotFromV2(mainModel, creds) : null;
    const fallbackModel = models.find((m) => m !== mainModel);
    const fallback = fallbackModel ? slotFromV2(fallbackModel, creds) : null;
    return {
        ...(main ? { main } : {}),
        ...(fallback ? { fallback } : {}),
    };
}

/**
 * Materialize ONE v2 model's normalized slot by its `models[]` id (routing apply
 * site). Reuses `slotFromV2` field-mapping so the slot carries CIPHERTEXT
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
    return slotFromV2(model, creds);
}

/**
 * Normalize a stored BYOK config blob to the internal shape. The dual-read is
 * GONE (04b-06): ONLY the shape is read. A legacy `{main,fallback}` blob, an
 * undefined/primitive, or anything malformed all yield `{}` (absent main →
 * env/managed default downstream) — a legacy blob is NEVER read as a stored
 * shape. Never throws.
 */
export function normalizeByokConfig(raw: unknown): NormalizedByokConfig {
    try {
        if (isByokConfig(raw)) return normalizeConfig(raw);
        return {}; // non-v2 / legacy / undefined / malformed → env/managed default
    } catch {
        return {}; // any unexpected shape degrades to the managed default
    }
}

/**
 * The ONE dual-read adapter (Phase 2, plan 02-01).
 *
 * Maps BOTH the legacy `{main,fallback}` shape AND the v2 shape to the internal
 * `NormalizedByokConfig` the resolver family (byok-to-vercel.ts) consumes.
 *
 * Invariants:
 *  - NEVER decrypts — the internal shape carries ENCRYPTED apiKey ciphertext;
 *    byok-to-vercel decrypts downstream. Decrypting here = double-decrypt / leak.
 *  - DEGRADES, never throws: an unknown/credential-less model is skipped; a fully
 *    unusable config yields absent `main` (→ byok-to-vercel's env-default branch).
 *  - A `managed:true` credential → absent `main` (the env/managed default), with
 *    no call-site branch.
 */
import type { BYOKProvider } from '@kodus/kodus-common/llm';
import {
    isV2Config,
    type BYOKConfigV2,
    type BYOKCredential,
    type BYOKModelConfig,
    type NormalizedByokConfig,
    type NormalizedModel,
} from './byok-config';

/** Legacy `{main,fallback}` slot — a loose record parsed from the stored blob. */
type LegacySlot = Record<string, unknown>;
type LegacyConfig = { main?: unknown; fallback?: unknown };

const STR = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
const NUM = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined;

/** Build a NormalizedModel from a v2 model + its resolved credential, or null to
 *  skip (managed, missing credential, or no provider — all degrade to absent).
 *  Exported so an apply site (the routing resolver) can materialize the chosen
 *  model's full ciphertext-bearing slot via `resolveModelSlotFromV2`. */
export function slotFromV2(
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
    };
}

/** Carry a legacy slot through (already ciphertext); pick the known fields. */
function slotFromLegacy(raw: unknown): NormalizedModel | null {
    if (!raw || typeof raw !== 'object') return null;
    const slot = raw as LegacySlot;
    const provider = STR(slot.provider);
    const apiKey = STR(slot.apiKey);
    const model = STR(slot.model);
    if (!provider || !apiKey || !model) return null;
    return {
        provider: provider as BYOKProvider,
        apiKey, // ciphertext — NOT decrypted here
        model,
        baseURL: STR(slot.baseURL),
        disableReasoning:
            typeof slot.disableReasoning === 'boolean'
                ? slot.disableReasoning
                : undefined,
        reasoningEffort: slot.reasoningEffort as NormalizedModel['reasoningEffort'],
        reasoningConfigOverride: STR(slot.reasoningConfigOverride),
        temperature: NUM(slot.temperature),
        maxInputTokens: NUM(slot.maxInputTokens),
        maxConcurrentRequests: NUM(slot.maxConcurrentRequests),
        maxOutputTokens: NUM(slot.maxOutputTokens),
        vertexLocation: STR(slot.vertexLocation),
        awsBearerToken: STR(slot.awsBearerToken),
        awsAccessKeyId: STR(slot.awsAccessKeyId),
        awsSecretAccessKey: STR(slot.awsSecretAccessKey),
        awsRegion: STR(slot.awsRegion),
        awsSessionToken: STR(slot.awsSessionToken),
    };
}

function normalizeV2(cfg: BYOKConfigV2): NormalizedByokConfig {
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
export function resolveModelSlotFromV2(
    config: BYOKConfigV2,
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
 * Normalize any BYOK config blob (v2, legacy, undefined, or malformed) to the
 * internal shape. Returns `{}` (absent main → env/managed default) for anything
 * unusable — never throws.
 */
export function normalizeByokConfig(raw: unknown): NormalizedByokConfig {
    try {
        if (isV2Config(raw)) return normalizeV2(raw);
        if (raw && typeof raw === 'object') {
            const legacy = raw as LegacyConfig;
            const main = slotFromLegacy(legacy.main);
            const fallback = slotFromLegacy(legacy.fallback);
            return {
                ...(main ? { main } : {}),
                ...(fallback ? { fallback } : {}),
            };
        }
        return {}; // undefined / primitive → managed default
    } catch {
        return {}; // any unexpected shape degrades to the managed default
    }
}

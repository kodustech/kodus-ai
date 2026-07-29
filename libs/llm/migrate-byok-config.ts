/**
 * Pure legacy→v2 BYOK transform (Phase 04b, plan 04b-07).
 *
 * Converts a stored legacy `{main,fallback}` BYOK blob into the v2 shape
 * (`{version:2, credentials[], models[], routing}`) that the v2-only code
 * (04b-01..06) reads. It is DB-free and unit-testable; the TypeORM migration
 * (04b-07 Task 3) applies it per `organization_parameters` BYOK row.
 *
 * Hard invariants (secret hygiene is the #1 risk here):
 *  - Encrypted key material (apiKey + aws* secrets) is carried CIPHERTEXT
 *    VERBATIM — never re-encrypted, never rewritten.
 *  - The ONLY place a key is decrypted is the in-memory dedup equality compare
 *    (`plaintextEquals`), whose plaintext lives in local scope for exactly one
 *    `===` and is NEVER logged and NEVER placed in the returned blob.
 *  - `decrypt()` throwing (rotated / mismatched crypto key) DEGRADES to
 *    "treat the two slots as distinct" — it never aborts the transform (D-08).
 *  - Value-idempotent: an already-v2 blob is returned unchanged.
 *  - `routing.defaultModelId` = the first (migrated `main`) model, so the v2
 *    resolver picks the SAME model the legacy config resolved (no behavior
 *    change on the resolved model).
 *
 * Scope note: the per-repo `byokModel` NAME → `byokModelId` conversion (RFC §9)
 * lives in a DIFFERENT org parameter (the code-review config blob), not in the
 * BYOK_CONFIG blob this transform receives, so it is intentionally out of scope
 * here — see 04b-07-SUMMARY.md.
 */
import { decrypt } from '@libs/common/utils/crypto';
import {
    isV2Config,
    type BYOKConfigV2,
    type BYOKCredential,
    type BYOKModelConfig,
} from './byok-config';
import type { ReasoningEffort } from './providers/types';

// ─── Legacy stored shape (structural; the blob is untrusted jsonb) ────────────

interface LegacySlot {
    provider?: string;
    /** Encrypted apiKey ciphertext (never plaintext in a real stored blob). */
    apiKey?: string;
    model?: string;
    baseURL?: string;
    reasoningEffort?: ReasoningEffort;
    reasoningConfigOverride?: string;
    temperature?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxConcurrentRequests?: number;
    // Non-secret settings.
    vertexLocation?: string;
    awsRegion?: string;
    // Encrypted Bedrock auth secrets (ciphertext).
    awsBearerToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsSessionToken?: string;
}

interface LegacyConfig {
    main?: LegacySlot;
    fallback?: LegacySlot;
}

const STR = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;

/** A slot is usable only when it carries a real provider + encrypted key + model. */
function isUsableSlot(slot?: LegacySlot): boolean {
    return (
        !!slot &&
        typeof slot === 'object' &&
        !!STR(slot.provider) &&
        !!STR(slot.apiKey) &&
        !!STR(slot.model)
    );
}

/**
 * In-memory plaintext equality of two encrypted keys, used ONLY to decide dedup.
 * The decrypted values live in local scope for a single `===` and are never
 * logged or returned. A decrypt() throw (rotated / mismatched crypto key)
 * DEGRADES to `false` — the two slots are treated as distinct (D-08).
 */
function plaintextEquals(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    try {
        // Local-scope plaintext — compared, then discarded. NEVER logged.
        return decrypt(a) === decrypt(b);
    } catch {
        // Undecryptable ciphertext must not abort the migration; treat as distinct.
        return false;
    }
}

/** Build a v2 credential from a legacy slot, carrying all ciphertext VERBATIM. */
function credentialFromSlot(id: string, slot: LegacySlot): BYOKCredential {
    const settings: Record<string, unknown> = {};
    const put = (k: string, v: unknown) => {
        const s = STR(v);
        if (s !== undefined) settings[k] = s;
    };
    // Non-secret settings.
    put('baseURL', slot.baseURL);
    put('vertexLocation', slot.vertexLocation);
    put('awsRegion', slot.awsRegion);
    // Encrypted Bedrock secrets — carried verbatim (never re-encrypted).
    put('awsBearerToken', slot.awsBearerToken);
    put('awsAccessKeyId', slot.awsAccessKeyId);
    put('awsSecretAccessKey', slot.awsSecretAccessKey);
    put('awsSessionToken', slot.awsSessionToken);

    const cred: BYOKCredential = {
        id,
        provider: STR(slot.provider) as string,
    };
    // apiKey ciphertext carried verbatim — never re-encrypted.
    const apiKey = STR(slot.apiKey);
    if (apiKey !== undefined) cred.apiKey = apiKey;
    if (Object.keys(settings).length > 0) cred.settings = settings;
    return cred;
}

/** Build a v2 model referencing `credentialId`, carrying the tuning fields. */
function modelFromSlot(
    id: string,
    credentialId: string,
    slot: LegacySlot,
): BYOKModelConfig {
    const model: BYOKModelConfig = {
        id,
        credentialId,
        model: STR(slot.model) as string,
    };
    if (slot.reasoningEffort !== undefined)
        model.reasoningEffort = slot.reasoningEffort;
    const override = STR(slot.reasoningConfigOverride);
    if (override !== undefined) model.reasoningConfigOverride = override;
    if (typeof slot.temperature === 'number')
        model.temperature = slot.temperature;
    if (typeof slot.maxInputTokens === 'number')
        model.maxInputTokens = slot.maxInputTokens;
    if (typeof slot.maxOutputTokens === 'number')
        model.maxOutputTokens = slot.maxOutputTokens;
    if (typeof slot.maxConcurrentRequests === 'number')
        model.maxConcurrentRequests = slot.maxConcurrentRequests;
    return model;
}

/**
 * The v2 shape for a managed / env-default legacy config (no usable main). An
 * empty `credentials`/`models` v2 blob normalizes to `{}` — the SAME env/managed
 * default a managed:true credential resolves to (normalizeV2 → absent main), so
 * there is no behavior change. Kept empty (rather than a synthetic managed
 * credential) so the result is unambiguous and value-idempotent.
 */
function managedDefaultV2(): BYOKConfigV2 {
    return { version: 2, credentials: [], models: [] };
}

/**
 * Convert a legacy `{main,fallback}` BYOK blob to v2. Already-v2 blobs are
 * returned unchanged (value-idempotent). See the file header for the full
 * invariants (ciphertext verbatim, in-memory dedup compare, degrade on throw,
 * routing.defaultModelId = first model).
 */
export function migrateLegacyToV2(blob: unknown): BYOKConfigV2 {
    // Idempotent: an already-v2 blob is returned as-is (same reference).
    if (isV2Config(blob)) return blob;

    const legacy: LegacyConfig =
        blob && typeof blob === 'object' ? (blob as LegacyConfig) : {};
    const main = legacy.main;

    // No usable main → env/managed default (empty v2). Mirrors the resolved
    // behavior of a managed:true credential.
    if (!isUsableSlot(main)) return managedDefaultV2();

    const mainCredId = 'cred-main';
    const mainModelId = 'model-main';
    const credentials: BYOKCredential[] = [
        credentialFromSlot(mainCredId, main as LegacySlot),
    ];
    const models: BYOKModelConfig[] = [
        modelFromSlot(mainModelId, mainCredId, main as LegacySlot),
    ];

    const fallback = legacy.fallback;
    if (isUsableSlot(fallback)) {
        // Dedup: same underlying key as main → reuse the one credential.
        const sameKey = plaintextEquals(main!.apiKey, fallback!.apiKey);
        const fallbackCredId = sameKey ? mainCredId : 'cred-fallback';
        if (!sameKey) {
            credentials.push(
                credentialFromSlot(fallbackCredId, fallback as LegacySlot),
            );
        }
        models.push(
            modelFromSlot('model-fallback', fallbackCredId, fallback as LegacySlot),
        );
    }

    return {
        version: 2,
        credentials,
        models,
        // First model = migrated main → resolver picks the same main.
        routing: { defaultModelId: mainModelId },
    };
}

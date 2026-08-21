/**
 * Pure legacy→v2 BYOK transform (Phase 04b, plan 04b-07).
 *
 * Converts a stored legacy `{main,fallback}` BYOK blob into the shape
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
 *  - Value-idempotent: an already-config blob is returned unchanged.
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
    isByokConfig,
    type BYOKConfig,
    type BYOKCredential,
    type BYOKModelConfig,
} from './byok-config';
import type { ReasoningEffort } from './providers/kernel/types';

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

// Non-secret connection settings and encrypted Bedrock auth secrets — the two
// halves of what a credential carries BESIDES its apiKey. Two slots are only the
// SAME credential when these match too (see sameCredential).
const NONSECRET_SETTING_FIELDS = [
    'baseURL',
    'vertexLocation',
    'awsRegion',
] as const;
const SECRET_SETTING_FIELDS = [
    'awsBearerToken',
    'awsAccessKeyId',
    'awsSecretAccessKey',
    'awsSessionToken',
] as const;

/**
 * Whether two legacy slots resolve to the SAME credential — the guard for the
 * main↔fallback dedup. A credential is `{provider, apiKey, settings}`, so key
 * equality alone is not enough: same key + different `provider` or `baseURL`
 * (e.g. the same OpenAI key used directly vs. through an openai_compatible proxy)
 * are DISTINCT credentials, and folding them onto main would silently run the
 * fallback against main's endpoint. We require provider + plaintext key + every
 * setting to match. Erring toward "distinct" is safe (an extra credential
 * carrying the same verbatim ciphertext resolves identically); erring toward
 * "same" loses the fallback's connection settings, so we never do that.
 */
function sameCredential(a: LegacySlot, b: LegacySlot): boolean {
    if (STR(a.provider) !== STR(b.provider)) return false;
    if (!plaintextEquals(a.apiKey, b.apiKey)) return false;
    for (const f of NONSECRET_SETTING_FIELDS) {
        if (STR(a[f]) !== STR(b[f])) return false;
    }
    for (const f of SECRET_SETTING_FIELDS) {
        const av = STR(a[f]);
        const bv = STR(b[f]);
        if (!av && !bv) continue;
        // One present, one absent → distinct. Both present → plaintext-compare
        // (ciphertext bytes differ per-encryption even for the same secret).
        if (!av || !bv || !plaintextEquals(av, bv)) return false;
    }
    return true;
}

/** Build a credential from a legacy slot, carrying all ciphertext VERBATIM. */
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

/** Build a model referencing `credentialId`, carrying the tuning fields. */
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
 * empty `credentials`/`models` config blob normalizes to `{}` — the SAME env/managed
 * default a managed:true credential resolves to (normalizeConfig → absent main), so
 * there is no behavior change. Kept empty (rather than a synthetic managed
 * credential) so the result is unambiguous and value-idempotent.
 */
function managedDefaultV2(): BYOKConfig {
    return { version: 2, credentials: [], models: [] };
}

/**
 * Convert a legacy `{main,fallback}` BYOK blob to v2. Already-v2 blobs are
 * returned unchanged (value-idempotent). See the file header for the full
 * invariants (ciphertext verbatim, in-memory dedup compare, degrade on throw,
 * routing.defaultModelId = first model).
 */
export function migrateLegacyToV2(blob: unknown): BYOKConfig {
    // Idempotent: an already-config blob is returned as-is (same reference).
    if (isByokConfig(blob)) return blob;

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
        // Dedup: fold the fallback onto main's credential ONLY when it resolves
        // to the same credential (provider + key + settings), not merely the same
        // key — otherwise a distinct provider/baseURL on the fallback would be
        // lost (see sameCredential). The fallback MODEL is always emitted; only
        // the credential is shared.
        const same = sameCredential(main as LegacySlot, fallback as LegacySlot);
        const fallbackCredId = same ? mainCredId : 'cred-fallback';
        if (!same) {
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

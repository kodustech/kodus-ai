/**
 * BYOK config — the persisted shape + the internal normalized shape.
 *
 * `BYOKConfig` (credentials + models + routing) is the single stored format.
 * `resolveModelSlot` / `resolveTaskSlot` project it into a `NormalizedModel` —
 * the flat runtime slot the resolver family (byok-to-vercel.ts) builds from, with
 * the apiKey kept as ENCRYPTED ciphertext so decryption happens once, downstream.
 * Provider ids are plain strings matching BYOKProvider values.
 */
import type { BYOKProvider } from '@libs/llm/model-providers';
import type { ReasoningEffort } from './providers/kernel/types';
// The task taxonomy + inheritance map live in a zero-dependency leaf so the
// isolated apps/web build can bundle them without pulling in the rest of
// libs/llm. Re-exported here (unchanged public API) for the backend, which
// imports them from `@libs/llm/byok-config`.
import type { LlmTask } from './llm-tasks';
export { LLM_TASK, TASK_ROUTING_FALLBACK } from './llm-tasks';
export type { LlmTask } from './llm-tasks';

// ─── Persisted shape ─────────────────────────────────────────────────────────

/**
 * A connected provider credential. Connected once, referenced by many models via
 * `credentialId` — so rotating a key touches one place and budget scopes are
 * billing-accurate. Secret fields (apiKey, aws*) are stored as ciphertext.
 */
export interface BYOKCredential {
    id: string;
    /** Provider id (matches a BYOKProvider value). */
    provider: string;
    /** Encrypted key ciphertext. Absent for a managed credential. */
    apiKey?: string;
    /** Provider-specific settings (baseURL, vertexLocation, aws*, openrouter*). */
    settings?: Record<string, unknown>;
    /** Kodus-managed default (env key). Hidden from the UI; cost type `system`;
     *  no code branch — it normalizes to the env-default path. */
    managed?: boolean;
}

/** A configured model referencing a credential (no inline key). */
export interface BYOKModelConfig {
    id: string;
    credentialId: string;
    model: string;
    reasoningEffort?: ReasoningEffort;
    reasoningConfigOverride?: string;
    temperature?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxConcurrentRequests?: number;
    /** Requests-per-minute cap for this slot. Absent/≤0 ⇒ disabled (no rate
     *  gate). Enforced as a min-interval (`60000/rpm` ms) by the per-slot
     *  BYOKConcurrencyLimiter — v2-only, sibling to maxConcurrentRequests. */
    rpm?: number;
    /** Tokens-per-minute cap for this slot. Absent/≤0 ⇒ disabled (no token
     *  gate). Enforced as a per-slot token reservoir (capacity = tpm, refilled
     *  linearly per minute) debited by the pre-call tiktoken estimate and
     *  reconciled with real usage in the wrapper — v2-only, sibling to rpm. */
    tpm?: number;
    /** Cooldown window (ms) armed on a classified RATE_LIMIT (429-rate). After a
     *  rate-limit the per-slot limiter HOLDS new admissions for this long
     *  (DELAY, never retry). Absent/≤0 ⇒ disabled (never arms). Only a 429-rate
     *  arms it — a 429-quota (billing) and a 5xx transient never do — v2-only,
     *  sibling to rpm/tpm. */
    cooldownMs?: number;
}

/**
 * Routing policy. Persisted in Phase 2; EXECUTED in Phase 4 (Manual = static
 * task→model; Auto = the future router). The shape existing now lets Phase 4 wire
 * it with no re-migration.
 */
export interface BYOKRouting {
    mode?: 'manual' | 'auto';
    /** Model id per task (Manual policy). Renamed from `byTask` to match the
     *  RFC §4.2 precedence vocabulary the resolver reads (Phase 4, plan 04-01);
     *  the type had zero readers so the rename is free. */
    taskOverrides?: Partial<Record<LlmTask, string>>;
    /** Default model id when a task has no explicit override. */
    defaultModelId?: string;
    /** Single fallback model id used when the resolved tier fails the capability
     *  gate and no higher-precedence capable model exists (REQ-ROUTE-01). */
    fallbackModelId?: string;
}

export interface BYOKConfig {
    version: 2;
    credentials: BYOKCredential[];
    models: BYOKModelConfig[];
    routing?: BYOKRouting;
}

// ─── Internal normalized shape (what the resolver family consumes) ───────────

/**
 * One resolved model slot. Mirrors the legacy `NormalizedByokConfig['main']` fields so it
 * is a drop-in for byok-to-vercel.ts. `apiKey` is ENCRYPTED ciphertext —
 * byok-to-vercel decrypts downstream; normalize must NOT decrypt.
 */
export interface NormalizedModel {
    /** Provider id. Typed as BYOKProvider so NormalizedModel is a structural
     *  drop-in for the legacy NormalizedByokConfig['main'] — a normalized config casts to
     *  NormalizedByokConfig cleanly, so the 25 getBYOKConfig callers need no change. */
    provider: BYOKProvider;
    /** Encrypted key ciphertext (decrypted by byok-to-vercel). */
    apiKey: string;
    model: string;
    /** The config `models[]` entry id this slot resolved from (the BYOK v2 model
     *  id). Absent on env/managed-default slots. Stamped on the usage span so
     *  spend attributes by a STABLE id — not the versioned provider response
     *  model-name that breaks the name-based rollup. */
    byokModelId?: string;
    /** The credential id the resolved model draws from — the per-key attribution
     *  dimension the usage store otherwise lacks. Absent on env/managed slots. */
    credentialId?: string;
    baseURL?: string;
    reasoningEffort?: ReasoningEffort;
    reasoningConfigOverride?: string;
    temperature?: number;
    maxInputTokens?: number;
    maxConcurrentRequests?: number;
    /** Requests-per-minute cap for this slot (min-interval `60000/rpm` ms).
     *  Absent/≤0 ⇒ disabled. Sibling to maxConcurrentRequests; the limiter
     *  composes both gates on one instance. */
    rpm?: number;
    /** Tokens-per-minute cap for this slot (per-slot token reservoir, capacity =
     *  tpm, refilled linearly per minute). Absent/≤0 ⇒ disabled. Sibling to rpm;
     *  the limiter composes concurrency + rpm + tpm on one instance. */
    tpm?: number;
    /** Cooldown window (ms) armed on a classified RATE_LIMIT (429-rate). The
     *  per-slot limiter holds new admissions for this long after a rate-limit.
     *  Absent/≤0 ⇒ disabled (never arms). Sibling to rpm/tpm on the one
     *  instance; the limiter composes concurrency + rpm + tpm + cooldown. */
    cooldownMs?: number;
    maxOutputTokens?: number;
    vertexLocation?: string;
    awsBearerToken?: string;
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    awsSessionToken?: string;
    /** Routing PROVENANCE (not a credential/tuning field), stamped by
     *  `resolveTaskSlot` so it rides ALONG the slot to whichever span records the
     *  call — no per-agent threading. Absent on the env/managed-default path (no
     *  routing) and on a directly-constructed slot.
     *  - `route`: the routing TASK this slot serves (`codeReview`/`prSummary`/
     *    `kodyRulesReview`/`businessValidation`) — the usage span's per-task
     *    dimension. (The precedence tier that won is NOT here; it stays in the
     *    verdict's `reason`.)
     *  - `usedFallback`: true when the fallback model served instead of a primary
     *    tier — makes a silent primary→fallback swap visible on the span. */
    route?: string;
    usedFallback?: boolean;
    /** The RUNTIME failover target for this slot: the org's configured
     *  `routing.fallbackModelId`, resolved + capability-gated, stamped here by
     *  `resolveTaskSlot` so it rides ALONG the primary slot to `LLM.run` with no
     *  per-consumer threading. Present only when a distinct, eligible fallback
     *  exists (absent when none is configured, it fails the gate, or the primary
     *  IS already the fallback). Itself a plain slot — never carries a nested
     *  `.fallback` (the cascade is at most primary → fallback, one hop). `LLM.run`
     *  tries the primary, then this on a cascade-worthy failure. Typed as a slot
     *  WITHOUT its own `.fallback` so the compiler — not a prose invariant —
     *  enforces the single hop. */
    fallback?: Omit<NormalizedModel, 'fallback'>;
}

/** Narrow an unknown blob to a valid BYOK config by its schema discriminant. */
export function isByokConfig(raw: unknown): raw is BYOKConfig {
    return (
        !!raw &&
        typeof raw === 'object' &&
        (raw as { version?: unknown }).version === 2
    );
}

/**
 * True when a config carries at least one NON-managed (real BYOK) credential
 * — i.e. the org brought its own key. A managed credential (`managed: true`) is
 * the Kodus env-default and does NOT count as BYOK. This is the native
 * replacement for the legacy `Boolean(byokConfig?.main)` has-BYOK presence check
 * (a managed/env default always produced a `main`, so `.main` presence
 * over-reported BYOK). A legacy / absent / non-config blob is treated as "no BYOK".
 */
export function hasNonManagedCredential(
    config: BYOKConfig | null | undefined,
): boolean {
    return (
        isByokConfig(config) &&
        (config.credentials ?? []).some((c) => !c.managed)
    );
}

/**
 * Secret fields carried inside a credential's `settings` (Amazon Bedrock auth).
 * The SINGLE source of truth shared by the write path (create-or-update, which
 * encrypts/keeps them) and the read path (find-by-key, which masks them). Keeping
 * one list prevents the two from drifting — a field added to one but not the
 * other would leak that setting's ciphertext to the client on read.
 * `awsRegion`, `baseURL`, `vertexLocation` are plaintext settings, NOT listed.
 */
export const BYOK_SECRET_SETTINGS = [
    'awsBearerToken',
    'awsAccessKeyId',
    'awsSecretAccessKey',
    'awsSessionToken',
] as const;

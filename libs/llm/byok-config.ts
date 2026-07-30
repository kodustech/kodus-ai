/**
 * BYOK config — v2 shape + the internal normalized shape (Phase 2, plan 02-01).
 *
 * The v2 shape (credentials + models + routing) is the persisted format going
 * forward. `normalizeByokConfig` (02-01 Task 2) maps BOTH v2 AND the legacy
 * `{main,fallback}` shape to `NormalizedByokConfig` — the internal shape the
 * resolver family (byok-to-vercel.ts) consumes. That internal shape mirrors the
 * legacy `{main,fallback}` with an ENCRYPTED apiKey, so byok-to-vercel's existing
 * `decrypt()` + `.main`/`.fallback` logic works unchanged for both shapes.
 *
 * Types live in libs/llm (not kodus-common) — no runtime kodus-common dependency
 * (REQ-NOLC-01). Provider ids are plain strings matching BYOKProvider values.
 */
import { BYOKProvider } from '@libs/llm/model-providers';
import type { ReasoningEffort } from './providers/types';

// ─── v2 persisted shape ──────────────────────────────────────────────────────

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

/** LLM task taxonomy for routing (execution is Phase 4; the shape persists now). */
export type LlmTask = 'codeReview' | 'prSummary' | 'conversation';

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

export interface BYOKConfigV2 {
    version: 2;
    credentials: BYOKCredential[];
    models: BYOKModelConfig[];
    routing?: BYOKRouting;
}

// ─── Internal normalized shape (what the resolver family consumes) ───────────

/**
 * One resolved model slot. Mirrors the legacy `BYOKConfig['main']` fields so it
 * is a drop-in for byok-to-vercel.ts. `apiKey` is ENCRYPTED ciphertext —
 * byok-to-vercel decrypts downstream; normalize must NOT decrypt.
 */
export interface NormalizedModel {
    /** Provider id. Typed as BYOKProvider so NormalizedModel is a structural
     *  drop-in for the legacy BYOKConfig['main'] — a normalized config casts to
     *  BYOKConfig cleanly, so the 25 getBYOKConfig callers need no change. */
    provider: BYOKProvider;
    /** Encrypted key ciphertext (decrypted by byok-to-vercel). */
    apiKey: string;
    model: string;
    baseURL?: string;
    disableReasoning?: boolean;
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
}

/**
 * The internal shape the resolver family reads. `main` is OPTIONAL: a managed /
 * empty config yields absent `main` so byok-to-vercel's `if (!config)` env-default
 * branch runs with no call-site branch.
 */
export interface NormalizedByokConfig {
    main?: NormalizedModel;
    fallback?: NormalizedModel;
}

/**
 * Canonical BYOK carrier type. This is the v2-native replacement for the legacy
 * `BYOKConfig` that used to be imported from the former shared kodus-common `llm` package: it is the
 * SAME `{main,fallback}` shape the resolver family passes around, but built from
 * our own `NormalizedModel` and owned here, so nothing outside this repo defines
 * the carrier anymore. Consumers import `BYOKConfig` from `@libs/llm/byok-config`.
 */
export type BYOKConfig = NormalizedByokConfig;

/** Narrow an unknown blob to v2 by its discriminant. */
export function isV2Config(raw: unknown): raw is BYOKConfigV2 {
    return (
        !!raw &&
        typeof raw === 'object' &&
        (raw as { version?: unknown }).version === 2
    );
}

/**
 * True when a v2 config carries at least one NON-managed (real BYOK) credential
 * — i.e. the org brought its own key. A managed credential (`managed: true`) is
 * the Kodus env-default and does NOT count as BYOK. This is the v2-native
 * replacement for the legacy `Boolean(byokConfig?.main)` has-BYOK presence check
 * (a managed/env default always produced a `main`, so `.main` presence
 * over-reported BYOK). A legacy / absent / non-v2 blob is treated as "no BYOK".
 */
export function hasNonManagedCredential(
    config: BYOKConfigV2 | null | undefined,
): boolean {
    return isV2Config(config) && config.credentials.some((c) => !c.managed);
}

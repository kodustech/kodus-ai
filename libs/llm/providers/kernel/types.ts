/**
 * Provider registry — the `ProviderModule` contract (Phase 1, plan 01-01).
 *
 * One provider = one self-describing module. Adding a provider becomes a single
 * new file + one `registerProvider(...)` call — no edit to a central enum or
 * switch (that switch, in byok-to-vercel.ts / reasoning-options.ts, is removed
 * in 01-03 once every id is a module).
 *
 * Scope note: `normalize` / `normalizeUsage` are DECLARED here so the interface
 * shape is stable, but they are minimal stubs until Phase 3 (output-correctness)
 * implements them. `reasoning()` is folded from reasoning-options.ts in 01-04.
 */
import type { LanguageModel } from 'ai';
import type { z } from 'zod';
// Type-only imports (erased at runtime).
import type {
    ModelCapabilities as BaseModelCapabilities,
    ReasoningConfig,
} from '@libs/llm/providers/kernel/model-types';
import type { NormalizedModel } from '@libs/llm/byok-config';

/**
 * Provider capability descriptor. Extends the reasoning-only base
 * `ModelCapabilities` (providers/model-types) with execution fields. All new
 * fields are optional so existing base callers are unaffected.
 */
export interface ModelCapabilities extends BaseModelCapabilities {
    /** Max input/context window in tokens, when known. */
    maxInputTokens?: number;
    /** Native structured-output mode the provider honors. */
    structuredOutput?: 'json_schema' | 'json_object' | 'none';
    /** Native tool/function calling support. */
    toolCalling?: 'native' | 'none';
    /** Whether usage reports reasoning tokens separately from output. */
    usageGranularity?: 'reasoning_split' | 'output_only';
    /** Whether the provider supports streaming responses. */
    streaming?: boolean;
    /** Whether the provider supports prompt caching. */
    promptCaching?: boolean;
}

/**
 * The build config for one model = a BYOK `main`/`fallback` entry. `apiKey` is
 * already DECRYPTED by the caller (byok-to-vercel decrypts before dispatch), so
 * modules never import crypto. `main` is a superset of `fallback`.
 */
export type ProviderBuildConfig = NormalizedModel;

/** Mirrors byok-to-vercel's `ByokModelOptions` — per-call structured-output opt-in. */
export interface ProviderBuildOptions {
    structuredOutputs?: boolean;
}

/**
 * Canonical reasoning vocabulary at the module boundary. Provider-native
 * budget/level/adaptive stays INTERNAL to each `module.reasoning()` (01-04);
 * 'none' always means reasoning disabled regardless of the native type.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** Per-provider reasoning → AI-SDK providerOptions. Shape is provider-specific,
 *  so it stays loose here; 01-04 owns each mapping. */
export type ProviderReasoningOptions = Record<string, unknown>;

/** Normalized usage — Phase 3 fills the real extraction; declared now for shape
 *  stability so callers can type against it before Phase 3 lands. */
export interface NormalizedUsage {
    input: number;
    output: number;
    reasoning: number;
}

/** Normalized model result — Phase 3 owns the real shape; minimal here. */
export interface ModelResult {
    usage: NormalizedUsage;
    raw: unknown;
}

/** One entry in a provider's model catalog (populates the model picker). */
export interface CatalogModel {
    id: string;
    name: string;
    supportsReasoning?: boolean;
    reasoningConfig?: ReasoningConfig;
}

/** Credentials resolved by the caller (org saved slot → env fallback) before a
 *  listing HTTP call. `baseURL` is only relevant to baseURL-driven providers. */
export interface ResolvedListingCreds {
    apiKey?: string;
    baseURL?: string;
}

/**
 * How to enumerate a provider's models. Kept PURE (no HTTP, no NestJS): the
 * org-layer fetcher reads this descriptor and performs the request + SSRF gate.
 * This is what collapses `get-models-by-provider`'s per-provider switch.
 *  - `manual`  → provider can't be listed here; the UI asks for a model id.
 *  - `static`  → curated catalog (Bedrock/Vertex — can't list without heavy creds).
 *  - `http`    → hit the provider's `/models` endpoint (url/headers/parse are pure).
 */
export type ModelListing =
    | { kind: 'manual' }
    | { kind: 'static'; models: CatalogModel[] }
    | {
          kind: 'http';
          /** Env var to fall back to for the API key when no saved slot matches. */
          apiKeyEnv?: string;
          /** Env var to fall back to for the baseURL (baseURL-driven providers). */
          baseURLEnv?: string;
          /** Last-resort baseURL when neither a saved slot nor the env var is set. */
          defaultBaseURL?: string;
          /** baseURL-driven (self-hosted/proxy): the fetcher SSRF-gates it and
           *  disables redirects. */
          requiresBaseURL?: boolean;
          /** Optional request timeout in ms. */
          timeoutMs?: number;
          /** Build the `/models` URL (pure). */
          url(creds: ResolvedListingCreds): string;
          /** Build request headers (pure). */
          headers(creds: ResolvedListingCreds): Record<string, string>;
          /** Parse the raw response body → catalog (pure). */
          parse(body: unknown): CatalogModel[];
      };

/** UI field descriptor for the BYOK settings screen (Phase 4 consumes it). */
export interface FieldDescriptor {
    key: string;
    label: string;
    type: 'text' | 'password' | 'url' | 'select' | 'number' | 'boolean';
    required?: boolean;
    placeholder?: string;
    options?: Array<{ value: string; label: string }>;
    /** Whether the field lives at the top level of the config or under the
     *  provider-specific `settings` object. */
    scope?: 'top' | 'settings';
}

/**
 * A self-describing provider. Registered once via `registerProvider`; the core
 * resolves `REGISTRY.get(providerId)` instead of switching on the provider enum.
 */
export interface ProviderModule {
    /** Primary provider id — matches a `BYOKProvider` value (as a string). */
    id: string;
    /** Additional ids this same module also serves (e.g. openai_compatible on
     *  the openai module). Registered alongside `id`. */
    aliases?: string[];
    /** Human-readable label for the UI. */
    label: string;
    /** Zod schema validating this provider's `settings` (baseURL, region, ...). */
    settingsSchema: z.ZodType;
    /** Static capability descriptor for a given model id. Extended in 01-04. */
    capabilities(model: string): ModelCapabilities;
    /** Build the AI SDK LanguageModel. `cfg.apiKey` is already DECRYPTED. */
    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel;
    /** Normalize a raw provider result → ModelResult. STUB in Phase 1
     *  (declared for shape stability); Phase 3 implements. */
    normalize(raw: unknown): ModelResult;
    /** Normalize raw usage → NormalizedUsage. STUB in Phase 1; Phase 3 implements. */
    normalizeUsage(raw: unknown): NormalizedUsage;
    /** Optional pure request transform for provider quirks. */
    transformRequest?(cfg: ProviderBuildConfig): ProviderBuildConfig;
    /** Optional reasoning mapping: canonical effort → provider-native options.
     *  Folded from reasoning-options.ts in 01-04. */
    reasoning?(
        cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions;
    /** Optional system-prompt cache hint: the `providerOptions` to attach to the
     *  system message so a multi-step loop reads the (static) system prompt from
     *  cache instead of re-billing it. Provider-specific SHAPE lives here (only the
     *  module knows its protocol), sibling to `reasoning()` — e.g. Anthropic emits
     *  `{ anthropic: { cacheControl: { type: 'ephemeral' } } }`. Undefined/absent =
     *  no inline hint (providers that cache implicitly, like OpenAI, don't need one).
     *  Gated upstream by `capabilities().promptCaching`. */
    systemCacheControl?(
        cfg: ProviderBuildConfig,
    ): Record<string, unknown> | undefined;
    /** UI fields for the BYOK settings screen. */
    uiFields: FieldDescriptor[];
    /** How to enumerate this provider's models, per requested id (a module may
     *  serve several ids, e.g. openai + openai_compatible, whose listing differs).
     *  Returns null when the id is unknown to this module. */
    modelListing?(providerId: string): ModelListing | null;
}

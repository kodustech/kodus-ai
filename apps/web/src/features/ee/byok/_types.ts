export type ReasoningEffort = "none" | "low" | "medium" | "high";

// ─── web mirror ──────────────────────────────────────────────────────────────
//
// Web-side mirror of the persisted shape in libs/llm/byok-config.ts, kept
// field-for-field EXCEPT that every secret is a MASKED, display-only string:
// getBYOK() reads the find-by-key blob, which passes through maskV2ConfigSecrets
// server-side, so `credential.apiKey` is already a display mask — the
// `firstTwo...lastThree` shape (e.g. `sk...def`), or `••••` for a short/
// unreadable value — and the client never receives a real key.

/** LLM task taxonomy for routing (mirror of libs/llm LlmTask). */
export type LlmTask = "codeReview" | "prSummary" | "conversation";

/**
 * A connected provider credential. Connected once, referenced by many models
 * via `credentialId`. `apiKey` is a MASKED display string (server-masked); a
 * managed credential (env default) carries no key and is hidden from the UI.
 */
export type BYOKCredential = {
    id: string;
    /** Provider id (matches a BYOKProvider value). */
    provider: string;
    /** MASKED key ciphertext for display only. Absent for a managed credential. */
    apiKey?: string;
    /** Provider-specific settings (baseURL, vertexLocation, aws*, openrouter*). */
    settings?: Record<string, unknown>;
    /** Kodus-managed default (env key). Hidden from the UI; never rendered. */
    managed?: boolean;
};

/** A configured model referencing a credential (no inline key). */
export type BYOKModelConfig = {
    id: string;
    credentialId: string;
    model: string;
    reasoningEffort?: ReasoningEffort;
    reasoningConfigOverride?: string;
    temperature?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxConcurrentRequests?: number;
    /** Requests-per-minute cap for this slot. Absent/≤0 ⇒ disabled. */
    rpm?: number;
    /** Tokens-per-minute cap for this slot. Absent/≤0 ⇒ disabled. */
    tpm?: number;
    /** Cooldown window (ms) armed on a classified RATE_LIMIT. Absent/≤0 ⇒ off. */
    cooldownMs?: number;
};

/** Routing policy (Manual = static task→model; Auto = the future router). */
export type BYOKRouting = {
    mode?: "manual" | "auto";
    /** Model id per task (Manual policy). */
    taskOverrides?: Partial<Record<LlmTask, string>>;
    /** Default model id when a task has no explicit override. */
    defaultModelId?: string;
    /** Fallback model id when the resolved tier fails the capability gate. */
    fallbackModelId?: string;
};

export type BYOKConfig = {
    version: 2;
    credentials: BYOKCredential[];
    models: BYOKModelConfig[];
    routing?: BYOKRouting;
};

// ─── connect-form input ──────────────────────────────────────────────────────
//
// The flat single-model+credential shape the manual/edit-key + curated
// connect-panel/catalog flows emit from their forms; `byok-write.ts` splits it
// into the credential + model entries of the stored `BYOKConfig`.

export type BYOKConnectInput = {
    model: string;
    apiKey: string;
    provider: string;
    baseURL?: string;
    temperature?: number;
    maxInputTokens?: number;
    maxConcurrentRequests?: number;
    maxOutputTokens?: number;
    /** Google Vertex AI region (e.g. "us-central1"). Only used when
     *  provider === "google_vertex". */
    vertexLocation?: string;
    /** Bedrock API key (bearer token). Preferred auth path when
     *  provider === "amazon_bedrock"; takes precedence over IAM keys. */
    awsBearerToken?: string;
    /** Advanced: static IAM user credentials for Amazon Bedrock. Used
     *  only when awsBearerToken is not set. */
    awsAccessKeyId?: string;
    awsSecretAccessKey?: string;
    awsRegion?: string;
    awsSessionToken?: string;
    reasoningEffort?: ReasoningEffort;
    /** Raw JSON override for provider-specific reasoning config.
     *  When set, takes precedence over reasoningEffort preset.
     *  Format: provider options object (e.g. {"budget_tokens": 25000}). */
    reasoningConfigOverride?: string;
    /** Pin OpenRouter requests to specific upstream providers (in order).
     *  Ignored when provider !== 'openrouter'. */
    openrouterProviderOrder?: string[];
    /** Allow OpenRouter to fall back to other upstreams when the preferred
     *  order is unavailable. Defaults to OpenRouter's default (true) when
     *  undefined; set to false to hard-fail if pinned providers are down. */
    openrouterAllowFallbacks?: boolean;
};

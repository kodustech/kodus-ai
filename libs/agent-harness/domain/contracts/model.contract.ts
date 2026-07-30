/**
 * agent-harness — Model port (L0 boundary).
 *
 * The core never imports a provider SDK. It depends only on this port; the
 * infrastructure adapter (BYOK + Vercel AI SDK) implements it. This is what
 * keeps the harness model-agnostic.
 *
 * `TModel` is intentionally opaque to the core — the infra adapter knows it
 * is a Vercel `LanguageModel`, the core does not.
 */
export interface ModelResolver<TModel = unknown> {
    /** Resolve a model id (BYOK / provider-qualified) into a model handle. */
    resolve(modelId: string): TModel;
}

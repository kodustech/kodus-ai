# libs/llm

Shared LLM **provider** infrastructure — generic, domain-agnostic. Anything that
turns configuration into a usable model, or governs how model calls are made,
lives here (NOT review/agent logic).

- **`byok-to-vercel.ts`** — maps a BYOK config (provider + apiKey + model) to a
  Vercel AI SDK `LanguageModel`; plus `getInternalModel`, `getModelName`, and the
  process-wide BYOK concurrency limiter (`runWithBYOKLimiter`).
- **`env-llm-config.ts`** — pure, side-effect-free inspection of the self-hosted
  `.env`-driven LLM configuration.
- **`model-context-window.ts`** (+ `model-context-windows.json`) — resolves a
  model name to its context-window size (LiteLLM data + manual overrides).
- **`error-classifier.ts`** (+ `errors.ts`) — maps raw provider errors into the
  canonical `LlmErrorCategory` (auth / quota / rate-limit / context-overflow / …)
  so callers react to error *meaning*, not provider-specific strings.
- **`byok-model-wrapper.ts`** — wraps any `LanguageModel` so every generate goes
  through the process-wide BYOK concurrency limiter and reports BYOK failures
  (model-level, via AI SDK `wrapLanguageModel`; the failure reporter is injected).
- **`reasoning-options.ts`** — builds provider-specific reasoning/thinking
  `providerOptions` (Anthropic / Gemini / OpenAI / OpenRouter / compatible) from a
  normalized `ReasoningEffort`, plus OpenRouter provider-pinning.
- **`llm-call.ts`** — call timeouts (`AGENT_TIMEOUT_MS`, `LLM_CALL_TIMEOUT_MS`,
  `timeoutSignal`, `hardTimeout`) and `tracedGenerateText` (generateText + hard
  timeout for providers that ignore AbortSignal).
- **`preflight-context.ts`** — `assertPromptFitsInContext`: refuse a call whose
  estimated prompt won't fit the model's context window (avoids futile retries).
- **`system-cache.ts`** — `anthropicSystemCacheControl`: provider options to cache
  the (large) system prompt on Anthropic models across an agent loop's steps.

Consumed by `code-review`, `cli-review`, `organization`, … — any lib that needs to
create or describe an LLM model. Keep this free of review/agent-specific shapes
(findings, diffs, suggestions): those belong in their own domain libs.

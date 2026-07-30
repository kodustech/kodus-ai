# Structured Outputs Repro

Matrix test for the structured-output capability gate in
`libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts`.

## Why

`@ai-sdk/openai-compatible` only emits `response_format: { type: "json_schema", ... }`
when `supportsStructuredOutputs: true` is set at provider construction.
The first version of the fix (PR #1125) flipped that flag for every
OpenAI-compatible BYOK branch the moment the three Output.object call
sites in `agent-loop.ts` / `agent-review.stage.ts` opted in. That was
correct for vLLM, OpenAI-via-OR, Moonshot/Kimi, and Anthropic-via-OR —
but it silently regressed DeepSeek, Grok, Mistral, and grab-bag
`OPENAI_COMPATIBLE` upstreams that don't accept strict
`response_format: json_schema`. Those callers would 400, hit the
catch, and skip dedup / fallback structuring entirely. The follow-up
adds a capability gate plus a retry-on-error wrapper.

The matrix below probes both legs of that fix.

## Not part of `pnpm run test`

This is `repro.ts`, not `repro.spec.ts`, so Jest's
`testMatch` in `jest.config.ts` ignores it. Run manually.

## Run

```bash
# Full matrix, no network — 8 BYOK scenarios + 1 retry probe
pnpm run repro:structured-outputs

# Live spot-check against a single scenario (real OpenRouter / Google call)
pnpm run repro:structured-outputs --scenario openrouter-kimi --live
pnpm run repro:structured-outputs --scenario gemini-control --live
```

Always requires `API_CRYPTO_KEY` (`.env`). Live mode additionally
needs `API_OPENROUTER_KEY` or `API_GOOGLE_AI_API_KEY` depending on
the scenario.

## Matrix

| scenario              | provider          | model                          | expected outbound               |
| --------------------- | ----------------- | ------------------------------ | ------------------------------- |
| `openrouter-kimi`     | OPEN_ROUTER       | `moonshotai/kimi-k2-thinking`  | `response_format: json_schema`  |
| `openrouter-openai`   | OPEN_ROUTER       | `openai/gpt-4o-mini`           | `response_format: json_schema`  |
| `openrouter-anthropic`| OPEN_ROUTER       | `anthropic/claude-3-5-sonnet`  | `response_format: json_schema`  |
| `openrouter-deepseek` | OPEN_ROUTER       | `deepseek/deepseek-chat`       | `response_format: json_object`  |
| `openrouter-grok`     | OPEN_ROUTER       | `x-ai/grok-2`                  | `response_format: json_object`  |
| `oc-vllm`             | OPENAI_COMPATIBLE | any, `baseURL=...:8000/v1`     | `response_format: json_schema`  |
| `oc-generic`          | OPENAI_COMPATIBLE | any, `baseURL=random.example`  | `response_format: json_object`  |
| `gemini-control`      | GOOGLE_GEMINI     | `gemini-2.5-flash`             | `generationConfig.responseSchema` populated |

For every scenario the repro also asserts the **tool-loop probe**
(plain `generateText` with no `output:`) does NOT emit a structured
schema — guards against accidentally flipping the flag on for the
agentic loop.

## Retry-on-error probe

After the matrix, the script runs one more case that points at an
allowlisted scenario (`openai/gpt-4o-mini` via OR) but has the fake
fetch return `400 invalid_response_format`. The helper
`withStructuredOutputFallback` should catch that, mark the
`provider:model` combination unsupported in the process-scoped
cache, and retry once with `supportsStructuredOutputs: false`. The
probe asserts that two outbound requests were captured, first with
`json_schema` and second with `json_object`.

## Tuning the allowlist

The gate is in `shouldEnableJsonSchema(provider, model, baseURL)`:

- **OPEN_ROUTER**: model prefix in `OPENROUTER_JSON_SCHEMA_PREFIXES`
  (`openai/`, `anthropic/`, `google/`, `moonshotai/`)
- **OPENAI_COMPATIBLE**: `baseURL` contains `:8000/` (vLLM heuristic),
  or matches any substring listed in
  `API_TRUST_JSON_SCHEMA_BASE_URLS` (comma-separated env override)
- **NOVITA / unknown**: always false

To add a model:
1. Add a scenario to `SCENARIOS` in `repro.ts` with the expected outcome.
2. If the model legitimately supports `json_schema`, add its prefix to
   `OPENROUTER_JSON_SCHEMA_PREFIXES`.
3. Re-run the matrix.

If you're not sure — leave the prefix out. The retry-on-error wrapper
catches a wrong "off" decision (slow first call, then fine), while a
wrong "on" decision would silently regress the dedup/fallback paths
for that provider.

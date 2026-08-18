/**
 * Env / managed / self-host default-model resolution — the "no BYOK slot → which
 * model + creds" cascade. Split out of byok-to-vercel.ts (Wave 4, SRP) so the
 * env-provider selection lives apart from the slot→model adapter that consumes
 * it. `resolveManagedSlot` is re-exported from byok-to-vercel.ts for back-compat.
 *
 * Secret hygiene: a MANAGED slot carries a PLAINTEXT env apiKey (env keys are
 * already plaintext — never decrypt/encrypt them); the caller
 * (`buildModelFromSlot`) hands it straight to the provider builder.
 */
import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { BYOKProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { DEFAULT_MODEL } from './byok-defaults';
import { vertexModelFromAdc } from './model-builders';

// Model-name protocol patterns, used by the self-hosted / trial default-model
// resolution below (the BYOK provider builders moved to the provider modules
// + libs/llm/model-builders.ts in Phase 1).
const CLAUDE_MODEL_PATTERN = /^claude[-_]/i;
const GEMINI_MODEL_PATTERN = /^gemini[-_]/i;

/**
 * `options.structuredOutputs` opts the OpenAI-compatible branches into
 * `response_format: { type: "json_schema", json_schema: { schema, strict } }`
 * by setting `supportsStructuredOutputs: true` on the provider. Scope this
 * per-call to `generateObject` / `generateText({ output: Output.object })`
 * sites — leaving it off keeps the agentic tool-call loop on the unchanged
 * `json_object` (or absent) `response_format` path. Native SDKs
 * (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`,
 * `@ai-sdk/google-vertex`, `@ai-sdk/amazon-bedrock`) handle structured
 * outputs natively without any flag and are not affected by this option.
 *
 * Even when the caller opts in, the flag is gated by
 * `shouldEnableJsonSchema()` — only known-good provider/model/baseURL
 * combinations actually flip it on. Unknown OpenAI-compatible
 * upstreams (DeepSeek, Grok, random Novita models) fall back to the
 * SDK's `response_format: { type: "json_object" }` path, which is
 * slow but works. Call sites should pair the flag with a
 * retry-on-error wrapper that catches a wrong allowlist guess.
 */
export type ByokModelOptions = {
    structuredOutputs?: boolean;
};

/**
 * When the user sets `API_OPENAI_FORCE_BASE_URL` to a non-native endpoint
 * (OpenRouter, LiteLLM, Azure, DashScope, etc.), the intent is to route
 * through an OpenAI-compatible proxy regardless of the model name prefix.
 * In that case the native SDK auto-detect by model prefix is wrong — the
 * proxy only speaks the OpenAI Chat Completions protocol and the key the
 * user supplied belongs to the proxy, not to Anthropic/Google.
 *
 * Rule:
 *   - empty baseURL                            → native auto-detect is safe
 *   - baseURL contains "api.anthropic.com"     → still Anthropic native (explicit but native)
 *   - any other non-empty baseURL              → force OpenAI-compatible
 *
 * Vertex uses SA JSON auth (no baseURL), so its auto-detect is also gated
 * here: if the user explicitly overrode the URL, they are not going via
 * Vertex even if they have a Vertex key configured.
 */
function isProxyBaseURL(baseURL: string | undefined): boolean {
    if (!baseURL) return false;
    return !/(^|\/\/)api\.anthropic\.com\b/i.test(baseURL);
}

/**
 * The SINGLE source of truth for the self-hosted (`API_LLM_PROVIDER_MODEL`)
 * provider-selection cascade. `resolveManagedSlot` (which BUILDS the model) and
 * `getModelName` (which builds the telemetry NAME for that same model) both read
 * it, so the two can never drift out of sync — the previous copies of this
 * prefix/key cascade had to be kept identical by hand. Returns `null` for
 * `auto` (cloud) or a self-hosted mode with no usable env key → the caller
 * falls through to the cloud/managed default. `name` is the telemetry label;
 * `kind` drives the SDK/auth branch.
 */
export type EnvProviderResolution =
    | { kind: 'gemini_studio'; name: 'google_ai_studio'; apiKey: string }
    | {
          kind: 'gemini_vertex';
          name: 'google_vertex';
          apiKey: string;
          vertexLocation?: string;
      }
    | {
          kind: 'claude_anthropic';
          name: 'anthropic';
          apiKey: string;
          baseURL?: string;
      }
    | {
          kind: 'claude_vertex';
          name: 'google_vertex';
          apiKey: string;
          vertexLocation?: string;
      }
    | {
          kind: 'openai_compat';
          name: 'openai_compatible';
          apiKey: string;
          baseURL: string;
      }
    | {
          // Keyless Vertex via ambient Application Default Credentials — no
          // apiKey; the SDK discovers auth from the environment. Carries the
          // project (GOOGLE_CLOUD_PROJECT) the SDK needs pinned.
          kind: 'vertex_adc';
          name: 'google_vertex';
          project: string;
          vertexLocation?: string;
          isClaude: boolean;
      };

/** Resolve the Vertex project id for keyless (ADC) auth from the environment. */
function vertexProjectFromEnv(): string | undefined {
    const project = (
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.GCLOUD_PROJECT ||
        ''
    ).trim();
    return project || undefined;
}

export function resolveEnvProvider(): EnvProviderResolution | null {
    const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';
    if (envMode === 'auto') return null;

    const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
    const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);
    const openaiKey = process.env.API_OPEN_AI_API_KEY;
    const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
    const vertexKey = process.env.API_VERTEX_AI_API_KEY;
    const googleAiStudioKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const viaProxy = isProxyBaseURL(openaiBaseURL);
    const vertexLocation = process.env.API_VERTEX_AI_LOCATION;

    if (isGemini && !viaProxy) {
        // 1. AI Studio key → google_gemini. 2. Vertex SA JSON → google_vertex
        // (the module also handles a plain AIzaSy key pasted into the Vertex
        // slot). No Google key → fall through to the cloud default.
        if (googleAiStudioKey) {
            return {
                kind: 'gemini_studio',
                name: 'google_ai_studio',
                apiKey: googleAiStudioKey,
            };
        }
        if (vertexKey) {
            return {
                kind: 'gemini_vertex',
                name: 'google_vertex',
                apiKey: vertexKey,
                vertexLocation,
            };
        }
        // 3. Keyless: ambient ADC (GOOGLE_CLOUD_PROJECT). An explicit OpenAI key
        // WINS — a deployment that only set API_OPEN_AI_API_KEY must not be
        // switched to Vertex by an ambient identity it never opted into.
        const geminiProject = vertexProjectFromEnv();
        if (!openaiKey && geminiProject) {
            return {
                kind: 'vertex_adc',
                name: 'google_vertex',
                project: geminiProject,
                vertexLocation,
                isClaude: false,
            };
        }
    }
    // Native Anthropic key takes precedence over Claude-on-Vertex.
    if (isClaude && openaiKey && !viaProxy) {
        return {
            kind: 'claude_anthropic',
            name: 'anthropic',
            apiKey: openaiKey,
            baseURL: openaiBaseURL || undefined,
        };
    }
    if (isClaude && vertexKey && !viaProxy) {
        return {
            kind: 'claude_vertex',
            name: 'google_vertex',
            apiKey: vertexKey,
            vertexLocation,
        };
    }
    // Keyless Claude-on-Vertex via ambient ADC. Reached only when no native
    // Anthropic key and no Vertex SA JSON (those branches return first) — mirrors
    // the SA-JSON precedence.
    if (isClaude && !viaProxy) {
        const claudeProject = vertexProjectFromEnv();
        if (claudeProject) {
            return {
                kind: 'vertex_adc',
                name: 'google_vertex',
                project: claudeProject,
                vertexLocation,
                isClaude: true,
            };
        }
    }
    // Any other self-hosted model with an OpenAI-style key → OpenAI-compatible.
    if (openaiKey) {
        return {
            kind: 'openai_compat',
            name: 'openai_compatible',
            apiKey: openaiKey,
            baseURL: openaiBaseURL || 'https://api.openai.com/v1',
        };
    }
    return null;
}

/**
 * Managed/env-default resolution result (Wave 3).
 *
 * The env-default path used to hand-roll every SDK factory inline. It now
 * resolves to one of two shapes so BOTH the managed and BYOK paths share the
 * SAME `REGISTRY.get(provider).build(...)` dispatch:
 *   - `kind: 'slot'` — a MANAGED `NormalizedModel` carrying a PLAINTEXT env
 *     apiKey (env keys are already plaintext — do NOT decrypt/encrypt them). The
 *     provider module reproduces the exact factory call the inline code made.
 *   - `kind: 'inline'` — a LanguageModel that `resolveManagedSlot` built itself
 *     because the provider module CANNOT reproduce this managed case without
 *     changing its own BYOK behavior. There is exactly one such documented
 *     exception (see below): the self-hosted OpenAI-compatible default.
 */
export type ManagedResolution =
    | { kind: 'slot'; slot: NormalizedModel }
    | { kind: 'inline'; model: LanguageModel };

function managedSlot(
    provider: BYOKProvider,
    apiKey: string,
    model: string,
    extra?: Partial<NormalizedModel>,
): ManagedResolution {
    // MANAGED slot: the env apiKey is PLAINTEXT; buildModelFromSlot must NOT
    // decrypt it (decrypt is only for the ciphertext BYOK slot path).
    return { kind: 'slot', slot: { provider, apiKey, model, ...extra } };
}

/**
 * Resolve the env/managed/self-host default (the old `if (!config)` branch) to a
 * MANAGED slot routed through the registry, or to a pre-built inline exception.
 *
 * This is the SAME provider-selection logic the inline code had — the prefix of
 * `API_LLM_PROVIDER_MODEL` (or the default model) picks the SDK/auth/protocol:
 *   gemini-*  → google_gemini (AI Studio key) / google_vertex (SA JSON key)
 *   claude-*  → anthropic (native key) / google_vertex (Claude-on-Vertex SA JSON)
 *   any other → OpenAI-compatible (self-hosted) — the one INLINE exception
 * Cloud (managed/trial) falls back to the kimi/moonshot trial default (the
 * `moonshot` provider module) or the bundled Gemini default (`google_gemini`) —
 * both routed through the registry, not inline.
 *
 * Do NOT change this logic — it MUST stay behaviorally identical to the old
 * inline env-default branch (the env-default characterization tests pin it).
 */
export function resolveManagedSlot(
    defaultModel: string,
    options: ByokModelOptions,
): ManagedResolution {
    // Self-hosted: honor `API_LLM_PROVIDER_MODEL` (+ `API_OPEN_AI_API_KEY` /
    //   `API_OPENAI_FORCE_BASE_URL` / `API_VERTEX_AI_API_KEY`) so the customer's
    //   own keys from .env drive the main model, the same way `getInternalModel`
    //   does for helper calls.
    // Cloud (managed/trial): fall back to Kodus's bundled managed default
    //   (`DEFAULT_MODEL.model` = KODUS_TRIAL_MODEL → Fireworks-hosted
    //   deepseek-v4-flash; the Fireworks branch below builds it).
    // Self-hosted env provider selection — the single-source cascade. A null
    // result (cloud, or self-hosted with no usable key) falls through to the
    // Fireworks/managed default below.
    const env = resolveEnvProvider();
    if (env) {
        const envMode = process.env.API_LLM_PROVIDER_MODEL as string;
        switch (env.kind) {
            case 'gemini_studio':
                return managedSlot(
                    BYOKProvider.GOOGLE_GEMINI,
                    env.apiKey,
                    envMode,
                );
            case 'gemini_vertex':
            case 'claude_vertex':
                // Both Gemini-on-Vertex and Claude-on-Vertex (MaaS) route through
                // the ONE google_vertex module, which discriminates the id.
                return managedSlot(
                    BYOKProvider.GOOGLE_VERTEX,
                    env.apiKey,
                    envMode,
                    { vertexLocation: env.vertexLocation },
                );
            case 'claude_anthropic':
                return managedSlot(
                    BYOKProvider.ANTHROPIC,
                    env.apiKey,
                    envMode,
                    {
                        baseURL: env.baseURL,
                    },
                );
            case 'openai_compat':
                // INLINE EXCEPTION (self-hosted OpenAI-compatible): name
                // 'self-hosted', default baseURL api.openai.com, raw
                // structuredOutputs opt-in — the openai_compatible provider
                // module can't reproduce this without changing its BYOK behavior.
                return {
                    kind: 'inline',
                    model: createOpenAICompatible({
                        name: 'self-hosted',
                        apiKey: env.apiKey,
                        baseURL: env.baseURL,
                        supportsStructuredOutputs:
                            options.structuredOutputs === true,
                    })(envMode),
                };
            case 'vertex_adc': {
                // INLINE EXCEPTION (keyless Vertex via ambient ADC): there is no
                // apiKey — the google_vertex module's build() requires a decrypted
                // SA JSON, so a keyless deployment can't route through it. Build
                // from the ambient project here (claude-vs-gemini split mirrors
                // the SA path). A null build (SDK error) FALLS THROUGH to the
                // managed/cloud default below, exactly like main's ADC branch.
                const adcModel = vertexModelFromAdc(
                    envMode,
                    env.project,
                    env.vertexLocation,
                );
                if (adcModel) {
                    return { kind: 'inline', model: adcModel };
                }
                break;
            }
        }
    }

    // Fireworks AI — the managed default model for the trial / no-BYOK flow.
    // Detected by the `accounts/fireworks/models/` prefix so we don't need a
    // new BYOK provider entry just for the default-only path; wires through the
    // OpenAI-compatible adapter pointed at Fireworks (inline exception, like
    // self-hosted above).
    if (/^accounts\/fireworks\/models\//i.test(defaultModel)) {
        const fireworksKey =
            process.env.API_FIREWORKS_API_KEY ||
            process.env.FIREWORKS_API_KEY ||
            '';
        return {
            kind: 'inline',
            model: createOpenAICompatible({
                name: 'fireworks',
                apiKey: fireworksKey,
                baseURL:
                    process.env.API_FIREWORKS_BASE_URL ||
                    'https://api.fireworks.ai/inference/v1',
                supportsStructuredOutputs: true,
            })(defaultModel),
        };
    }

    // DeepSeek — legacy managed fallback, kept for any lingering explicit
    // `deepseek-*` override still in flight. New default is Fireworks above.
    if (/^deepseek[-_.]/i.test(defaultModel)) {
        const deepseekKey =
            process.env.API_DEEPSEEK_API_KEY ||
            process.env.DEEPSEEK_API_KEY ||
            '';
        return {
            kind: 'inline',
            model: createOpenAICompatible({
                name: 'deepseek',
                apiKey: deepseekKey,
                baseURL:
                    process.env.API_DEEPSEEK_BASE_URL ||
                    'https://api.deepseek.com/v1',
            })(defaultModel),
        };
    }

    // Kimi (Moonshot AI) — legacy managed fallback, kept for any lingering
    // `kimi-*` override still in flight. New default is Fireworks above. Routes
    // through the moonshot registry module (createOpenAICompatible under the hood).
    if (/^kimi[-_.]/i.test(defaultModel)) {
        const moonshotKey =
            process.env.API_MOONSHOT_API_KEY ||
            process.env.MOONSHOT_API_KEY ||
            '';
        return managedSlot(BYOKProvider.MOONSHOT, moonshotKey, defaultModel);
    }

    // Cloud default (gemini) — routes through the google_gemini module like any
    // other managed slot (the module's build() calls
    // createGoogleGenerativeAI({apiKey})(defaultModel), identical to the old
    // inline path).
    const googleKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        '';
    return managedSlot(BYOKProvider.GOOGLE_GEMINI, googleKey, defaultModel);
}

/**
 * Fail-soft guard for the no-BYOK internal path: is there a key backing the
 * managed model `resolveManagedSlot` would pick? Cloud → the Kodus-funded
 * Fireworks key (the `KODUS_DEFAULT_MODEL` default routes through Fireworks);
 * self-hosted → whichever provider key the env model needs. Kept deliberately
 * coarse (any relevant key present) — the exact provider match is
 * `resolveManagedSlot`'s job; this only decides skip-vs-run.
 */
export function hasManagedModelKey(): boolean {
    const selfHosted =
        (process.env.API_LLM_PROVIDER_MODEL ?? 'auto') !== 'auto';
    if (selfHosted) {
        return !!(
            process.env.API_OPEN_AI_API_KEY ||
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            process.env.API_VERTEX_AI_API_KEY ||
            // Keyless Vertex (ADC): no literal key, but the ambient project makes
            // the managed model resolvable — the coarse "has a backing key" check
            // must count it so secondary passes aren't skipped.
            vertexProjectFromEnv()
        );
    }
    // Cloud managed default is Fireworks (KODUS_DEFAULT_MODEL) — match the key
    // resolveManagedSlot's Fireworks branch actually builds with, NOT the legacy
    // DeepSeek key (checking the wrong key skipped every secondary pass on a
    // trial/managed org that only has the Fireworks key configured).
    return !!(
        process.env.API_FIREWORKS_API_KEY || process.env.FIREWORKS_API_KEY
    );
}

/**
 * Extract a human-readable model name from ONE resolved model slot.
 * Mirrors the env/default logic in `buildModelFromSlot` so telemetry/logs
 * reflect the model that will actually be used. A `undefined` slot resolves
 * the env/managed default name (the no-BYOK path), never a `.main`/`.fallback`
 * read.
 */
export function getModelName(
    slot?: NormalizedModel,
    defaultModelOverride?: string,
): string {
    if (slot) {
        return `${slot.provider}:${slot.model}`;
    }

    // Same single-source cascade the model is BUILT from (resolveManagedSlot),
    // so the telemetry name always matches the model actually used.
    const env = resolveEnvProvider();
    if (env) {
        return `${env.name}:${process.env.API_LLM_PROVIDER_MODEL}`;
    }

    return defaultModelOverride || DEFAULT_MODEL.model;
}

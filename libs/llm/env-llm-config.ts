/**
 * Pure, side-effect-free inspection of the self-hosted `.env`-driven LLM
 * configuration. Mirrors the provider-selection branches of `buildModelFromSlot`
 * in `byok-to-vercel.ts` but never instantiates an SDK client — safe to call
 * from HTTP handlers that only want to *describe* what the pipeline would use.
 *
 * The API key itself is intentionally not exposed: the UI surfaces these
 * values to logged-in admins, not to the pipeline, and leaking the secret
 * defeats the point of the BYOK/env split.
 */

export type EnvLLMProviderId =
    | 'openai'
    | 'openai_compatible'
    | 'anthropic'
    | 'google_gemini'
    | 'google_vertex';

export interface EnvLLMDescriptor {
    /** True iff the env configures a usable provider + key pair. */
    configured: boolean;
    /** Value of `API_LLM_PROVIDER_MODEL` when not `auto`. */
    model?: string;
    providerId?: EnvLLMProviderId;
    /** `API_OPENAI_FORCE_BASE_URL` (OpenAI-compatible proxy endpoint). */
    baseUrl?: string;
    /** `API_VERTEX_AI_LOCATION` when provider resolves to Vertex. */
    vertexLocation?: string;
    /**
     * Parsed `API_LLM_TEMPERATURE_OVERRIDE`. Present iff the operator set
     * an explicit numeric override. Surfaced so the dashboard can tell
     * the admin "your env clamps every call to N" instead of leaving
     * them guessing why every prompt ignores its hard-coded temperature.
     */
    temperatureOverride?: number;
}

const CLAUDE_MODEL_PATTERN = /^claude[-_]/i;
const GEMINI_MODEL_PATTERN = /^gemini[-_]/i;

/**
 * Mirrors `isProxyBaseURL` from byok-to-vercel.ts. An explicit baseURL that
 * isn't `api.anthropic.com` forces the OpenAI-compatible SDK regardless of
 * the model name prefix, because the proxy only speaks OpenAI Chat
 * Completions.
 */
function isProxyBaseURL(baseURL: string | undefined): boolean {
    if (!baseURL) return false;
    return !/(^|\/\/)api\.anthropic\.com\b/i.test(baseURL);
}

function looksLikeBase64Json(value: string): boolean {
    try {
        const decoded = Buffer.from(value, 'base64').toString('utf-8');
        const parsed = JSON.parse(decoded) as { project_id?: string };
        return !!parsed?.project_id;
    } catch {
        return false;
    }
}

/**
 * Vertex project for the KEYLESS (ADC) path — mirrors `vertexProjectFromEnv`
 * in managed-slot.ts, but reads from the passed `env` (this module stays a pure
 * inspector). `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` are the variables
 * google-auth-library reads anyway; when a key is absent they are the only
 * signal that a Vertex-via-ADC deployment is actually configured.
 */
function vertexProjectFromEnv(env: NodeJS.ProcessEnv): string | undefined {
    const project = (
        env.GOOGLE_CLOUD_PROJECT ||
        env.GCLOUD_PROJECT ||
        ''
    ).trim();
    return project || undefined;
}

/**
 * Describe the active env-based LLM config. Returns `{ configured: false }`
 * on cloud-mode installs (`API_LLM_PROVIDER_MODEL` unset or `"auto"`) and
 * on self-hosted installs that have the model set but no usable key.
 */
export function describeEnvLLMConfig(
    env: NodeJS.ProcessEnv = process.env,
): EnvLLMDescriptor {
    const envMode = env.API_LLM_PROVIDER_MODEL ?? 'auto';
    if (envMode === 'auto') {
        return { configured: false };
    }

    const openaiKey = env.API_OPEN_AI_API_KEY;
    const openaiBaseURL = env.API_OPENAI_FORCE_BASE_URL;
    const vertexKey = env.API_VERTEX_AI_API_KEY;
    const googleAiStudioKey =
        env.API_GOOGLE_AI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;
    const vertexLocation = env.API_VERTEX_AI_LOCATION || undefined;
    const viaProxy = isProxyBaseURL(openaiBaseURL);

    const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
    const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);

    const temperatureOverrideRaw = env.API_LLM_TEMPERATURE_OVERRIDE;
    const temperatureOverrideParsed =
        temperatureOverrideRaw !== undefined && temperatureOverrideRaw !== ''
            ? Number.parseFloat(temperatureOverrideRaw)
            : Number.NaN;
    const temperatureOverride = !Number.isNaN(temperatureOverrideParsed)
        ? temperatureOverrideParsed
        : undefined;

    const baseDescriptor = (descriptor: EnvLLMDescriptor): EnvLLMDescriptor =>
        temperatureOverride !== undefined
            ? { ...descriptor, temperatureOverride }
            : descriptor;

    if (isGemini && !viaProxy) {
        if (googleAiStudioKey) {
            return baseDescriptor({
                configured: true,
                model: envMode,
                providerId: 'google_gemini',
            });
        }
        if (vertexKey) {
            if (looksLikeBase64Json(vertexKey)) {
                return baseDescriptor({
                    configured: true,
                    model: envMode,
                    providerId: 'google_vertex',
                    vertexLocation: vertexLocation || 'us-central1',
                });
            }
            return baseDescriptor({
                configured: true,
                model: envMode,
                providerId: 'google_gemini',
            });
        }
        // Keyless ADC: no key at all, project pinned via GOOGLE_CLOUD_PROJECT /
        // GCLOUD_PROJECT (and no explicit OpenAI key to override) — mirrors
        // `resolveEnvProvider`'s `vertex_adc` precedence in managed-slot.ts. The
        // model DOES build here (vertexModelFromAdc), so the status descriptor
        // must agree; otherwise a working ADC deploy (Workload Identity on
        // GKE/EKS, or ADC creds) shows "No LLM provider configured" and reviews
        // are gated off. Location mirrors the builder default ('global').
        const adcProject = vertexProjectFromEnv(env);
        if (!openaiKey && adcProject) {
            return baseDescriptor({
                configured: true,
                model: envMode,
                providerId: 'google_vertex',
                vertexLocation: vertexLocation || 'global',
            });
        }
    }

    if (isClaude && openaiKey && !viaProxy) {
        return baseDescriptor({
            configured: true,
            model: envMode,
            providerId: 'anthropic',
            baseUrl: openaiBaseURL || undefined,
        });
    }

    // Claude-on-Vertex, mirroring managed-slot.ts precedence AFTER the native
    // Anthropic key: an SA-JSON key (google_vertex), then keyless ADC when only
    // a project is pinned. Without these a Claude-on-Vertex env deploy would hit
    // the same "not configured" false-negative the Gemini ADC path did.
    if (isClaude && vertexKey && !viaProxy) {
        return baseDescriptor({
            configured: true,
            model: envMode,
            providerId: 'google_vertex',
            vertexLocation: vertexLocation || 'global',
        });
    }
    if (isClaude && !viaProxy) {
        const claudeAdcProject = vertexProjectFromEnv(env);
        if (!openaiKey && claudeAdcProject) {
            return baseDescriptor({
                configured: true,
                model: envMode,
                providerId: 'google_vertex',
                vertexLocation: vertexLocation || 'global',
            });
        }
    }

    if (openaiKey) {
        return baseDescriptor({
            configured: true,
            model: envMode,
            providerId: 'openai_compatible',
            baseUrl: openaiBaseURL || 'https://api.openai.com/v1',
        });
    }

    return { configured: false };
}

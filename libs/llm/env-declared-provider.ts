/**
 * The self-hosted env path where the operator STATES the provider instead of
 * leaving it to be guessed from the model name (issue #1687).
 *
 * `API_LLM_PROVIDER` plays the role `BYOKConfig`'s provider plays in the DB: once
 * set, it is used as given, and the name/baseURL heuristics of the inference path
 * (managed-slot.ts `resolveEnvProvider`) never override it. The generic
 * `API_LLM_API_KEY` / `API_LLM_BASE_URL` / `API_LLM_REASONING_EFFORT` belong to
 * this path only: with no provider declared they would have to be guessed about
 * too (an AI Studio key and a Vertex one look alike to the model name), so setting
 * one without the provider is reported, not ignored.
 *
 * Pure: reads the env it is given, never builds a client, never returns a secret
 * to anyone but the model builder.
 */
import { stripSdkEndpoint } from './base-url-hygiene';
import type { ReasoningEffort } from './reasoning-options';

export const DECLARABLE_ENV_PROVIDERS = [
    'openai',
    'openai_compatible',
    'anthropic',
    'google_gemini',
    'google_vertex',
] as const;

export type DeclaredEnvProvider = (typeof DECLARABLE_ENV_PROVIDERS)[number];

const REASONING_EFFORTS: readonly ReasoningEffort[] = [
    'none',
    'low',
    'medium',
    'high',
];

const GENERIC_VARS = [
    'API_LLM_API_KEY',
    'API_LLM_BASE_URL',
    'API_LLM_REASONING_EFFORT',
] as const;

/** The provider-named keys, read in order when the generic one is empty.
 *  Anthropic keeps `API_OPEN_AI_API_KEY` after its own name: the inference path
 *  has always read a Claude key from it. */
const LEGACY_KEY_VARS: Record<DeclaredEnvProvider, readonly string[]> = {
    openai: ['API_OPEN_AI_API_KEY'],
    openai_compatible: ['API_OPEN_AI_API_KEY'],
    anthropic: ['API_ANTHROPIC_API_KEY', 'API_OPEN_AI_API_KEY'],
    google_gemini: ['API_GOOGLE_AI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    google_vertex: ['API_VERTEX_AI_API_KEY'],
};

/** Providers whose endpoint can be moved; the legacy var is OpenAI-named. */
const BASE_URL_PROVIDERS: ReadonlySet<DeclaredEnvProvider> = new Set([
    'openai',
    'openai_compatible',
    'anthropic',
]);
const LEGACY_BASE_URL_VAR = 'API_OPENAI_FORCE_BASE_URL';

const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export interface DeclaredEnvModel {
    provider: DeclaredEnvProvider;
    model: string;
    /** Absent only for keyless Vertex, which authenticates through ADC. */
    apiKey?: string;
    /** Project for keyless Vertex (ADC); set only when `apiKey` is absent. */
    adcProject?: string;
    baseURL?: string;
    vertexLocation?: string;
    reasoningEffort?: ReasoningEffort;
}

export type DeclaredEnvResolution =
    /** Nothing declared: the inference path decides, exactly as before. */
    | { kind: 'inferred' }
    | { kind: 'declared'; config: DeclaredEnvModel; warnings: string[] }
    /** Declared, but not runnable. `reason` names env vars, never values. */
    | { kind: 'invalid'; reason: string };

const read = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
};

function vertexProject(env: NodeJS.ProcessEnv): string | undefined {
    return read(env, 'GOOGLE_CLOUD_PROJECT') ?? read(env, 'GCLOUD_PROJECT');
}

/**
 * The generic var when set, else the first legacy one. A generic and a legacy
 * var that disagree are both meant by someone, so the loser is named in a
 * warning rather than dropped without a word.
 */
function pick(
    env: NodeJS.ProcessEnv,
    generic: string,
    legacy: readonly string[],
    warnings: string[],
): { value?: string; from?: string } {
    const genericValue = read(env, generic);
    const legacyName = legacy.find((name) => read(env, name));
    const legacyValue = legacyName ? read(env, legacyName) : undefined;
    if (genericValue) {
        if (legacyValue && legacyValue !== genericValue) {
            warnings.push(
                `${generic} and ${legacyName} are both set to different values; ${generic} is used.`,
            );
        }
        return { value: genericValue, from: generic };
    }
    return legacyValue ? { value: legacyValue, from: legacyName } : {};
}

export function resolveDeclaredEnvProvider(
    env: NodeJS.ProcessEnv = process.env,
): DeclaredEnvResolution {
    const model = env.API_LLM_PROVIDER_MODEL ?? 'auto';
    // Cloud (`auto`) never reads the env model, declared or not.
    if (model === 'auto') return { kind: 'inferred' };

    const provider = read(env, 'API_LLM_PROVIDER');
    if (!provider) {
        const orphan = GENERIC_VARS.filter((name) => read(env, name));
        return orphan.length
            ? {
                  kind: 'invalid',
                  reason: `${orphan.join(', ')} ${orphan.length > 1 ? 'require' : 'requires'} API_LLM_PROVIDER. Set API_LLM_PROVIDER to one of: ${DECLARABLE_ENV_PROVIDERS.join(', ')}.`,
              }
            : { kind: 'inferred' };
    }

    if (!(DECLARABLE_ENV_PROVIDERS as readonly string[]).includes(provider)) {
        return {
            kind: 'invalid',
            reason: `API_LLM_PROVIDER="${provider}" is not supported. Use one of: ${DECLARABLE_ENV_PROVIDERS.join(', ')}.`,
        };
    }
    const declared = provider as DeclaredEnvProvider;

    if (!model.trim()) {
        return {
            kind: 'invalid',
            reason: 'API_LLM_PROVIDER is set but API_LLM_PROVIDER_MODEL is empty.',
        };
    }

    const effortRaw = read(env, 'API_LLM_REASONING_EFFORT');
    if (
        effortRaw &&
        !(REASONING_EFFORTS as readonly string[]).includes(effortRaw)
    ) {
        return {
            kind: 'invalid',
            reason: `API_LLM_REASONING_EFFORT="${effortRaw}" is not supported. Use one of: ${REASONING_EFFORTS.join(', ')}.`,
        };
    }

    if (read(env, 'API_LLM_BASE_URL') && !BASE_URL_PROVIDERS.has(declared)) {
        return {
            kind: 'invalid',
            reason: `API_LLM_BASE_URL is not supported for API_LLM_PROVIDER=${declared}.`,
        };
    }

    const warnings: string[] = [];
    const key = pick(
        env,
        'API_LLM_API_KEY',
        LEGACY_KEY_VARS[declared],
        warnings,
    );
    const rawBase = BASE_URL_PROVIDERS.has(declared)
        ? pick(env, 'API_LLM_BASE_URL', [LEGACY_BASE_URL_VAR], warnings)
        : {};
    const baseURL = stripSdkEndpoint(
        rawBase.value,
        declared === 'anthropic' ? 'anthropic' : 'openai',
    );
    if (baseURL !== rawBase.value) {
        warnings.push(
            `${rawBase.from} ends with the endpoint the provider SDK adds itself; ${baseURL} is used.`,
        );
    }
    const vertexLocation = read(env, 'API_VERTEX_AI_LOCATION');

    const config: DeclaredEnvModel = {
        provider: declared,
        model,
        ...(effortRaw ? { reasoningEffort: effortRaw as ReasoningEffort } : {}),
    };

    if (key.value) {
        config.apiKey = key.value;
    } else if (declared === 'google_vertex' && vertexProject(env)) {
        config.adcProject = vertexProject(env);
    } else {
        const accepted = ['API_LLM_API_KEY', ...LEGACY_KEY_VARS[declared]];
        return {
            kind: 'invalid',
            reason: `API_LLM_PROVIDER=${declared} has no API key. Set ${accepted.join(' or ')}${declared === 'google_vertex' ? ', or GOOGLE_CLOUD_PROJECT for keyless ADC' : ''}.`,
        };
    }

    if (declared === 'openai_compatible') {
        config.baseURL = baseURL ?? OPENAI_DEFAULT_BASE_URL;
    } else if (baseURL) {
        config.baseURL = baseURL;
    }
    if (declared === 'google_vertex') {
        config.vertexLocation = vertexLocation || 'global';
    }

    return { kind: 'declared', config, warnings };
}

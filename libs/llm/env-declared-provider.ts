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
import { repairBaseUrl } from './base-url-hygiene';
import { BYOKProvider } from './model-providers';
import { REGISTRY, type SelfHostedEnvVars } from './providers';
import {
    REASONING_EFFORTS,
    type ReasoningEffort,
} from './providers/kernel/types';

/** The providers the env path can build (managed-slot.ts `fromDeclared`). Their
 *  env vars are declared by each provider module (`selfHostedEnv`). */
export const DECLARABLE_ENV_PROVIDERS = [
    BYOKProvider.OPENAI,
    BYOKProvider.OPENAI_COMPATIBLE,
    BYOKProvider.ANTHROPIC,
    BYOKProvider.ANTHROPIC_COMPATIBLE,
    BYOKProvider.GOOGLE_GEMINI,
    BYOKProvider.GOOGLE_VERTEX,
] as const;

export type DeclaredEnvProvider = (typeof DECLARABLE_ENV_PROVIDERS)[number];

const GENERIC_VARS = [
    'API_LLM_API_KEY',
    'API_LLM_BASE_URL',
    'API_LLM_REASONING_EFFORT',
] as const;

function envVarsOf(provider: DeclaredEnvProvider): SelfHostedEnvVars {
    const vars = REGISTRY.get(provider).selfHostedEnv?.(provider);
    if (!vars) {
        throw new Error(
            `Provider "${provider}" declares no self-hosted env vars.`,
        );
    }
    return vars;
}

const ENDPOINT_SUFFIX = 'ends with the endpoint the provider SDK adds itself';

/** A base URL var whose endpoint suffix was dropped, and the URL used instead. */
export function endpointSuffixWarning(varName: string, used: string): string {
    return `${varName} ${ENDPOINT_SUFFIX}; ${used} is used.`;
}

export function isEndpointSuffixWarning(warning: string): boolean {
    return warning.includes(ENDPOINT_SUFFIX);
}

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

    const vars = envVarsOf(declared);
    if (read(env, 'API_LLM_BASE_URL') && !vars.baseURL) {
        return {
            kind: 'invalid',
            reason: `API_LLM_BASE_URL is not supported for API_LLM_PROVIDER=${declared}.`,
        };
    }

    const warnings: string[] = [];
    const key = pick(env, 'API_LLM_API_KEY', vars.apiKeyVars, warnings);
    const rawBase = vars.baseURL
        ? pick(
              env,
              'API_LLM_BASE_URL',
              vars.baseURL.legacyVar ? [vars.baseURL.legacyVar] : [],
              warnings,
          )
        : {};
    const baseURL = repairBaseUrl(rawBase.value);
    if (baseURL !== rawBase.value) {
        warnings.push(endpointSuffixWarning(rawBase.from!, baseURL!));
    }
    const vertexLocation = read(env, 'API_VERTEX_AI_LOCATION');

    const config: DeclaredEnvModel = {
        provider: declared,
        model,
        ...(effortRaw ? { reasoningEffort: effortRaw as ReasoningEffort } : {}),
    };

    if (key.value) {
        config.apiKey = key.value;
    } else if (declared === BYOKProvider.GOOGLE_VERTEX && vertexProject(env)) {
        config.adcProject = vertexProject(env);
    } else {
        const accepted = ['API_LLM_API_KEY', ...vars.apiKeyVars];
        return {
            kind: 'invalid',
            reason: `API_LLM_PROVIDER=${declared} has no API key. Set ${accepted.join(' or ')}${declared === BYOKProvider.GOOGLE_VERTEX ? ', or GOOGLE_CLOUD_PROJECT for keyless ADC' : ''}.`,
        };
    }

    const endpoint = baseURL ?? vars.baseURL?.default;
    if (endpoint) {
        config.baseURL = endpoint;
    } else if (vars.baseURL?.required) {
        return {
            kind: 'invalid',
            reason: `API_LLM_PROVIDER=${declared} has no endpoint of its own. Set API_LLM_BASE_URL.`,
        };
    }
    if (declared === BYOKProvider.GOOGLE_VERTEX) {
        config.vertexLocation = vertexLocation || 'global';
    }

    return { kind: 'declared', config, warnings };
}

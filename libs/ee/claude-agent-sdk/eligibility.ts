/**
 * Which calls run on the Claude Agent SDK: a Claude model on a route whose
 * upstream speaks Anthropic Messages (Q1). Anything else — another model, a
 * brand that serves its own model behind an Anthropic-compatible endpoint, a
 * Claude id on a route we cannot authorize — stays on today's path.
 *
 * Returns the route with its credential decrypted, for the gateway only.
 */
import { repairBaseUrl } from '@libs/llm/base-url-hygiene';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { resolveEnvProvider } from '@libs/llm/managed-slot';
import { anthropicCompatibleRootURL, parseSaCredentials } from '@libs/llm/model-builders';
import { BYOKProvider } from '@libs/llm/model-providers';
import { isAnthropicModel } from '@libs/llm/providers/kernel/anthropic-cache';
import { kodusUpstreamKey } from '@libs/llm/providers/kodus';
import { canonicalUpstreamModelId, splitKodusModelId } from '@libs/llm/providers/kodus/model-id';

import type { ResolvedSdkRoute } from './route';

export const ANTHROPIC_API = 'https://api.anthropic.com';
export const OPENROUTER_ANTHROPIC_API = 'https://openrouter.ai/api';

function isFirstPartyAnthropic(baseUrl: string): boolean {
    try {
        return new URL(baseUrl).hostname === 'api.anthropic.com';
    } catch {
        return false;
    }
}

function safeDecrypt(value: string | undefined): string {
    if (!value) return '';
    try {
        // Loaded on use: the crypto module reads its key at import, and the
        // evals register the executors before they set it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { decrypt } = require('@libs/common/utils/crypto') as typeof import('@libs/common/utils/crypto');
        return decrypt(value);
    } catch {
        return '';
    }
}

function anthropicNative(apiKey: string, model: string, baseURL?: string): ResolvedSdkRoute | null {
    if (!apiKey) return null;
    const baseUrl = baseURL ? anthropicCompatibleRootURL(baseURL) : ANTHROPIC_API;
    return { model, route: { format: 'anthropic', baseUrl, apiKey, auth: 'x-api-key', firstParty: isFirstPartyAnthropic(baseUrl) } };
}

function vertexFromSa(saJson: string, model: string, region?: string): ResolvedSdkRoute | null {
    const credentials = parseSaCredentials(saJson);
    if (!credentials?.project_id) return null;
    return {
        model,
        route: { format: 'vertex', project: credentials.project_id, region: region?.trim() || 'global', credentials: credentials as Record<string, unknown>, firstParty: true },
    };
}

/** The env-configured model a self-hosted install runs when the org has no slot. */
function envRoute(): ResolvedSdkRoute | null {
    const model = (process.env.API_LLM_PROVIDER_MODEL ?? '').trim();
    if (!model || !isAnthropicModel(model)) return null;
    const env = resolveEnvProvider();
    if (!env) return null;
    switch (env.kind) {
        case 'claude_anthropic':
            return anthropicNative(env.apiKey, model, env.baseURL);
        case 'claude_vertex':
            return vertexFromSa(env.apiKey, model, env.vertexLocation);
        case 'vertex_adc':
            return env.isClaude
                ? { model, route: { format: 'vertex', project: env.project, region: env.vertexLocation?.trim() || 'global', credentials: 'adc', firstParty: true } }
                : null;
        default:
            return null;
    }
}

export function resolveClaudeSdkRoute(slot: NormalizedModel | undefined): ResolvedSdkRoute | null {
    if (!slot) return envRoute();

    const model = canonicalUpstreamModelId(slot.model);
    switch (slot.provider) {
        case BYOKProvider.ANTHROPIC:
            return isAnthropicModel(model) ? anthropicNative(safeDecrypt(slot.apiKey), model, repairBaseUrl(slot.baseURL)) : null;

        case BYOKProvider.KODUS: {
            const ref = splitKodusModelId(slot.model);
            if (!ref || ref.upstream !== 'anthropic' || !isAnthropicModel(ref.model)) return null;
            return anthropicNative(kodusUpstreamKey('anthropic'), ref.model);
        }

        case BYOKProvider.GOOGLE_VERTEX:
            return isAnthropicModel(model) ? vertexFromSa(safeDecrypt(slot.apiKey), model, slot.vertexLocation) : null;

        case BYOKProvider.AMAZON_BEDROCK: {
            if (!isAnthropicModel(model)) return null;
            const region = slot.awsRegion?.trim() || 'us-east-1';
            const bearer = safeDecrypt(slot.awsBearerToken).trim();
            if (bearer) return { model, route: { format: 'bedrock', region, auth: { kind: 'bearer', token: bearer }, firstParty: true } };
            const accessKeyId = safeDecrypt(slot.awsAccessKeyId);
            const secretAccessKey = safeDecrypt(slot.awsSecretAccessKey);
            if (!accessKeyId || !secretAccessKey) return null;
            const sessionToken = safeDecrypt(slot.awsSessionToken) || undefined;
            return { model, route: { format: 'bedrock', region, auth: { kind: 'sigv4', accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) }, firstParty: true } };
        }

        case BYOKProvider.OPEN_ROUTER: {
            // OpenRouter's Anthropic endpoint, pinned to Anthropic itself so the
            // request reaches the provider the CLI's protocol is written for.
            if (!/^anthropic\//i.test(model) || !isAnthropicModel(model)) return null;
            const apiKey = safeDecrypt(slot.apiKey);
            if (!apiKey) return null;
            return {
                model,
                route: { format: 'anthropic', baseUrl: OPENROUTER_ANTHROPIC_API, apiKey, auth: 'bearer', firstParty: false, openrouterProvider: { order: ['anthropic'], allow_fallbacks: false } },
            };
        }

        case BYOKProvider.ANTHROPIC_COMPATIBLE: {
            // A LiteLLM-style proxy serving a Claude id. Brands (Kimi, GLM,
            // DeepSeek) serve their own models here and never match.
            if (!/^claude[-_]/i.test(model) || !isAnthropicModel(model) || !slot.baseURL) return null;
            const apiKey = safeDecrypt(slot.apiKey);
            if (!apiKey) return null;
            const baseUrl = anthropicCompatibleRootURL(repairBaseUrl(slot.baseURL) ?? slot.baseURL);
            return { model, route: { format: 'anthropic', baseUrl, apiKey, auth: 'x-api-key', firstParty: isFirstPartyAnthropic(baseUrl) } };
        }

        default:
            return null;
    }
}

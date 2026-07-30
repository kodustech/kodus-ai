import { ChatAnthropic } from '@langchain/anthropic';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleAuth } from 'google-auth-library';
import { resolveModelOptions } from './resolver';
import {
    AdapterBuildParams,
    ProviderAdapter,
    LLM_TIMEOUT_MS,
    LLM_MAX_RETRIES,
} from './types';

interface VertexCredentials {
    project_id: string;
    [key: string]: unknown;
}

const VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

/**
 * Translate Anthropic Messages requests to the Vertex AI publisher-model
 * endpoint. We do NOT use `@anthropic-ai/vertex-sdk`: its path-rewrite hook
 * only fires when the base `@anthropic-ai/sdk` posts to exactly `/v1/messages`,
 * and the version pinned in this repo (0.98) changed that internal shape, so
 * the SDK silently falls through to `…/v1/v1/messages` (a 404). Instead we
 * give a stock `Anthropic` client a custom `fetch` that rewrites the URL to
 * `…/publishers/anthropic/models/{model}:rawPredict`, swaps the API-key auth
 * for a GCP bearer token, and moves `model` into the path with the required
 * `anthropic_version`. ChatAnthropic keeps doing everything else (message
 * shaping, tool-calls, token usage, structured output, streaming).
 */
function makeVertexAnthropicFetch(
    credentials: VertexCredentials,
    region: string,
): typeof fetch {
    const host =
        region === 'global'
            ? 'aiplatform.googleapis.com'
            : `${region}-aiplatform.googleapis.com`;
    const auth = new GoogleAuth({
        credentials: credentials as any,
        scopes: VERTEX_SCOPES,
    });

    return (async (input: any, init?: any) => {
        const url = new URL(String(input));
        if (init?.method === 'POST' && url.pathname.endsWith('/messages')) {
            const body = JSON.parse(init.body as string);
            const model = body.model;
            delete body.model;
            body.anthropic_version = 'vertex-2023-10-16';
            const verb = body.stream ? 'streamRawPredict' : 'rawPredict';
            const token = await auth.getAccessToken();
            const target = `https://${host}/v1/projects/${credentials.project_id}/locations/${region}/publishers/anthropic/models/${model}:${verb}`;
            const headers: Record<string, string> = { ...(init.headers ?? {}) };
            delete headers['x-api-key'];
            delete headers['anthropic-version'];
            headers['Authorization'] = `Bearer ${token}`;
            headers['Content-Type'] = 'application/json';
            return fetch(target, {
                ...init,
                body: JSON.stringify(body),
                headers,
            });
        }
        return fetch(input, init);
    }) as typeof fetch;
}

/**
 * Claude (Anthropic) models on Google Vertex AI for the v2 (langchain)
 * engine. Returns a ChatAnthropic whose underlying client is pointed at the
 * Vertex publishers/anthropic endpoint via the fetch shim above, so the BYOK
 * service account works on cloud AND self-hosted. Reasoning/thinking config
 * mirrors AnthropicAdapter so Claude behaves the same via the direct API or
 * Vertex.
 */
export class VertexAnthropicAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatAnthropic {
        const { model, apiKey, vertexLocation, options } = params;

        // BYOK service-account key: raw JSON (pasted file) or base64 of it.
        const rawKey = (apiKey || '').trim();
        const decoded = rawKey.startsWith('{')
            ? rawKey
            : Buffer.from(rawKey, 'base64').toString('utf-8');
        const credentials = JSON.parse(decoded) as VertexCredentials;
        // Default to the GLOBAL endpoint when no region is given — it routes
        // dynamically so callers don't need per-model region availability.
        // Deliberately NOT falling back to API_VERTEX_AI_LOCATION: that env is
        // the Gemini default (often us-central1), and regional endpoints don't
        // serve most Claude models (e.g. claude-haiku-4-5 is global-only). This
        // mirrors the v5 byok-to-vercel default and keeps both engines aligned.
        const region = vertexLocation?.trim() || 'global';
        const host =
            region === 'global'
                ? 'aiplatform.googleapis.com'
                : `${region}-aiplatform.googleapis.com`;

        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            maxReasoningTokens: options?.maxReasoningTokens,
            reasoningLevel: options?.reasoningLevel,
        });

        const maxTokens = resolved.resolvedMaxTokens ?? 4096;

        const isAdaptive = resolved.reasoningType === 'adaptive';
        const isBudget = resolved.reasoningType === 'budget';
        const reasoningBudget = options?.disableReasoning
            ? undefined
            : resolved.supportsReasoning && isBudget
              ? resolved.resolvedReasoningTokens
              : undefined;

        let thinkingConfig: any;
        if (isAdaptive && !options?.disableReasoning) {
            thinkingConfig = { type: 'adaptive' };
        } else if (typeof reasoningBudget === 'number') {
            thinkingConfig = { type: 'enabled', budget_tokens: reasoningBudget };
        }

        const effortLevel =
            isAdaptive && !options?.disableReasoning
                ? (resolved.resolvedReasoningLevel ?? 'low')
                : undefined;

        const vertexFetch = makeVertexAnthropicFetch(credentials, region);

        const payload: ConstructorParameters<typeof ChatAnthropic>[0] = {
            model,
            // The real auth is the GCP bearer the fetch shim injects;
            // ChatAnthropic still wants a non-empty key to construct a client.
            apiKey: 'vertex-byok',
            anthropicApiUrl: `https://${host}/v1`,
            ...(resolved.temperature !== undefined && !thinkingConfig
                ? { temperature: resolved.temperature }
                : {}),
            maxTokens,
            ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
            callbacks: options?.callbacks,
            maxRetries: LLM_MAX_RETRIES,
            clientOptions: { timeout: LLM_TIMEOUT_MS },
            // Override the client so requests hit the Vertex rawPredict URL.
            createClient: ((opts: any) =>
                new Anthropic({
                    ...opts,
                    baseURL: `https://${host}/v1`,
                    fetch: vertexFetch,
                })) as any,
        };

        if (effortLevel) {
            (payload as any).modelKwargs = {
                ...((payload as any).modelKwargs ?? {}),
                output_config: { effort: effortLevel },
            };
        }

        return new ChatAnthropic(payload);
    }
}

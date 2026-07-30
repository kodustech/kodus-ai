import { ChatVertexAI } from '@langchain/google-vertexai';
import { resolveModelOptions } from './resolver';
import { buildJsonModeOptions } from './jsonMode';
import { AdapterBuildParams, ProviderAdapter, LLM_MAX_RETRIES } from './types';

interface VertexCredentials {
    project_id: string;
    [key: string]: unknown;
}

export class VertexAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatVertexAI {
        const { model, apiKey, vertexLocation, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
        });

        // Prefer the BYOK service-account key (so a user's own key works on
        // cloud AND self-hosted); fall back to the env var only for the
        // legacy env-mode deployment. Accept the SA key as raw JSON (pasted
        // file contents) or base64-encoded JSON — base64 of a JSON object
        // always starts with `ey`, raw JSON starts with `{`.
        const raw =
            (apiKey || '').trim() || process.env.API_VERTEX_AI_API_KEY || '';
        if (!raw) {
            throw new Error(
                'Google Vertex requires a service account key (BYOK apiKey or API_VERTEX_AI_API_KEY env var)',
            );
        }
        const credentials = raw.startsWith('{')
            ? raw
            : Buffer.from(raw, 'base64').toString('utf-8');
        const parsedCredentials = JSON.parse(credentials) as VertexCredentials;
        const location =
            vertexLocation?.trim() ||
            process.env.API_VERTEX_AI_LOCATION ||
            'global';

        const payload: ConstructorParameters<typeof ChatVertexAI>[0] = {
            model,
            authOptions: {
                credentials: parsedCredentials,
                projectId: parsedCredentials.project_id,
            },
            location,
            ...(resolved.temperature !== undefined
                ? { temperature: resolved.temperature }
                : {}),
            ...(resolved.resolvedMaxTokens
                ? { maxOutputTokens: resolved.resolvedMaxTokens }
                : {}),
            callbacks: options?.callbacks,
            maxRetries: LLM_MAX_RETRIES,
            ...(resolved.supportsReasoning &&
            resolved.reasoningType === 'budget' &&
            resolved.resolvedReasoningTokens
                ? { maxReasoningTokens: resolved.resolvedReasoningTokens }
                : {}),
            ...buildJsonModeOptions('google_vertex', options?.jsonMode),
        };

        return new ChatVertexAI(payload);
    }
}

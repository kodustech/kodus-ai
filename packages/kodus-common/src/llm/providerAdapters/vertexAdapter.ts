import { ChatVertexAI } from '@langchain/google-vertexai';
import { resolveModelOptions } from './resolver';
import { buildJsonModeOptions } from './jsonMode';
import { AdapterBuildParams, ProviderAdapter, LLM_TIMEOUT_MS, LLM_MAX_RETRIES } from './types';

export class VertexAdapter implements ProviderAdapter {
    build(params: AdapterBuildParams): ChatVertexAI {
        const { model, options } = params;
        const resolved = resolveModelOptions(model, {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
        });

        const encoded = process.env.API_VERTEX_AI_API_KEY || '';
        if (!encoded) {
            throw new Error(
                'Vertex adapter requires API_VERTEX_AI_API_KEY (base64 credentials) env var',
            );
        }
        const credentials = Buffer.from(encoded, 'base64').toString('utf-8');

        const payload: ConstructorParameters<typeof ChatVertexAI>[0] = {
            model,
            authOptions: {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                credentials: JSON.parse(credentials),
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                projectId: JSON.parse(credentials).project_id,
            },
            location: 'us-east5',
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

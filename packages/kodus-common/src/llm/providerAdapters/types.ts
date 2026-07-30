import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Callbacks } from '@langchain/core/callbacks/manager';

/** 5 minutes – kills hung LLM calls that never respond */
export const LLM_TIMEOUT_MS = 5 * 60 * 1000;

/** Retry on transient failures (5xx, timeout, 429). Total attempts = maxRetries + 1 */
export const LLM_MAX_RETRIES = 2;

export interface AdapterBuildParams {
    model: string;
    apiKey: string;
    baseURL?: string;
    /** Google Vertex region (BYOK). Falls back to env, then us-central1. */
    vertexLocation?: string;
    options?: {
        temperature?: number;
        maxTokens?: number;
        jsonMode?: boolean;
        maxReasoningTokens?: number;
        reasoningLevel?: 'low' | 'medium' | 'high';
        disableReasoning?: boolean;
        callbacks?: Callbacks;
    };
}

export interface ProviderAdapter {
    build(params: AdapterBuildParams): BaseChatModel;
}

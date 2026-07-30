import { createLogger } from '@libs/core/log/logger';
import { LLMModelProvider, MODEL_STRATEGIES } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { encoding_for_model, TiktokenModel } from 'tiktoken';

import { estimateTokenCount } from '@libs/common/utils/langchainCommon/document';

export interface TokenChunkingOptions {
    model?: LLMModelProvider | string;
    data: any[];
    usagePercentage?: number;
    defaultMaxTokens?: number;
    /** When set, takes priority over model strategy lookup (used by BYOK maxInputTokens). */
    overrideMaxTokens?: number;
}

export interface TokenChunkingResult {
    chunks: any[][];
    totalItems: number;
    totalChunks: number;
    tokensPerChunk: number[];
    tokenLimit: number;
    modelUsed: string;
}

@Injectable()
export class TokenChunkingService {
    private readonly logger = createLogger(TokenChunkingService.name);
    constructor() {}

    /**
     * Splits data into chunks based on the LLM model's token limit
     *
     * @param options Chunking configurations
     * @returns Result with split chunks and metadata
     */
    public chunkDataByTokens(
        options: TokenChunkingOptions,
    ): TokenChunkingResult {
        const {
            model,
            data,
            usagePercentage = 60,
            defaultMaxTokens = 64000,
            overrideMaxTokens,
        } = options;

        // Validações de entrada
        if (!data || !Array.isArray(data)) {
            this.logger.error({
                message:
                    'Invalid data provided for token chunking - not an array',
                context: TokenChunkingService.name,
                metadata: {
                    dataType: typeof data,
                    model: model || 'default',
                },
            });

            return {
                chunks: [],
                totalItems: 0,
                totalChunks: 0,
                tokensPerChunk: [],
                tokenLimit: 0,
                modelUsed: model || 'default',
            };
        }

        if (data.length === 0) {
            this.logger.warn({
                message: 'Empty data array provided for token chunking',
                context: TokenChunkingService.name,
                metadata: { model: model || 'default' },
            });

            return {
                chunks: [],
                totalItems: 0,
                totalChunks: 0,
                tokensPerChunk: [],
                tokenLimit: 0,
                modelUsed: model || 'default',
            };
        }

        try {
            // 1. Determine token limit
            const maxTokens =
                overrideMaxTokens && overrideMaxTokens > 0
                    ? overrideMaxTokens
                    : this.getMaxTokensForModel(model, defaultMaxTokens);
            const tokenLimit = Math.floor(maxTokens * (usagePercentage / 100));

            this.logger.log({
                message: 'Starting token chunking process',
                context: TokenChunkingService.name,
                metadata: {
                    model: model || 'default',
                    maxTokens,
                    usagePercentage,
                    tokenLimit,
                    totalItems: data.length,
                },
            });

            // 2. Split data into chunks
            const chunks: any[][] = [];
            const tokensPerChunk: number[] = [];

            let currentChunk: any[] = [];
            let currentChunkTokens = 0;

            for (let i = 0; i < data.length; i++) {
                const item = data[i];

                // Validate item
                if (item === null || item === undefined) {
                    this.logger.warn({
                        message: 'Null or undefined item found, skipping',
                        context: TokenChunkingService.name,
                        metadata: { itemIndex: i, model: model || 'default' },
                    });
                    continue;
                }

                const itemTokens = this.countTokensForItem(item, model);

                // Edge case: single item exceeds token limit
                if (itemTokens > tokenLimit) {
                    this.logger.warn({
                        message: 'Single item exceeds token limit',
                        context: TokenChunkingService.name,
                        metadata: {
                            itemIndex: i,
                            itemTokens,
                            tokenLimit,
                            item:
                                typeof item === 'string'
                                    ? item.substring(0, 100) + '...'
                                    : 'complex object',
                        },
                    });

                    // If current chunk is not empty, finalize it
                    if (currentChunk.length > 0) {
                        chunks.push([...currentChunk]);
                        tokensPerChunk.push(currentChunkTokens);
                        currentChunk = [];
                        currentChunkTokens = 0;
                    }

                    // Add item as a single chunk
                    chunks.push([item]);
                    tokensPerChunk.push(itemTokens);
                    continue;
                }

                // Verify if adding the item would exceed the limit
                if (
                    currentChunkTokens + itemTokens > tokenLimit &&
                    currentChunk.length > 0
                ) {
                    // Finalize current chunk
                    chunks.push([...currentChunk]);
                    tokensPerChunk.push(currentChunkTokens);

                    // Start new chunk
                    currentChunk = [item];
                    currentChunkTokens = itemTokens;
                } else {
                    // Add item to current chunk
                    currentChunk.push(item);
                    currentChunkTokens += itemTokens;
                }
            }

            // Add last chunk if not empty
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
                tokensPerChunk.push(currentChunkTokens);
            }

            const result: TokenChunkingResult = {
                chunks,
                totalItems: data.length,
                totalChunks: chunks.length,
                tokensPerChunk,
                tokenLimit,
                modelUsed: model || 'default',
            };

            this.logger.log({
                message: 'Token chunking completed successfully',
                context: TokenChunkingService.name,
                metadata: {
                    totalItems: result.totalItems,
                    totalChunks: result.totalChunks,
                    tokenLimit: result.tokenLimit,
                    modelUsed: result.modelUsed,
                },
            });

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error during token chunking process',
                error,
                context: TokenChunkingService.name,
                metadata: {
                    model,
                    dataLength: data?.length || 0,
                    usagePercentage,
                    defaultMaxTokens,
                },
            });

            // Retornar resultado vazio em caso de erro
            return {
                chunks: [],
                totalItems: data?.length || 0,
                totalChunks: 0,
                tokensPerChunk: [],
                tokenLimit: 0,
                modelUsed: model || 'default',
            };
        }
    }

    /**
     * Gets the maximum token limit for a model
     */
    private getMaxTokensForModel(
        model?: LLMModelProvider | string,
        inputMaxTokens: number = 64000,
    ): number {
        if (!model) {
            return inputMaxTokens;
        }

        const strategy = MODEL_STRATEGIES[model as LLMModelProvider];
        if (!strategy) {
            return inputMaxTokens;
        }

        // If defaultMaxTokens is -1, it means no specific limit, use default
        if (strategy.inputMaxTokens === -1) {
            return inputMaxTokens;
        }

        return strategy.inputMaxTokens;
    }

    /**
     * Counts tokens for a specific item
     */
    private countTokensForItem(
        item: any,
        model?: LLMModelProvider | string,
    ): number {
        try {
            // Converts item to string for counting
            const text = this.serializeItem(item);

            // For OpenAI models, try using tiktoken for precise counting
            if (model && this.isOpenAIModel(model)) {
                try {
                    const encoder = encoding_for_model(
                        this.getOpenAIModelName(model) as TiktokenModel,
                    );
                    return encoder.encode(text).length;
                } catch (error) {
                    // If fails, use estimation
                    return estimateTokenCount(text);
                }
            }

            // For other models, use estimation
            return estimateTokenCount(text);
        } catch (error) {
            this.logger.warn({
                message:
                    'Error counting tokens for item, using fallback estimation',
                error,
                context: TokenChunkingService.name,
                metadata: {
                    itemType: typeof item,
                    model,
                },
            });

            // Fallback: basic estimation based on string length
            const text = this.serializeItem(item);
            return Math.ceil(text.length / 4); // Approximately 4 chars per token
        }
    }

    /**
     * Serializes an item to string consistently
     */
    private serializeItem(item: any): string {
        if (typeof item === 'string') {
            return item;
        }

        if (typeof item === 'object' && item !== null) {
            try {
                // Try normal serialization first
                return JSON.stringify(item);
            } catch (error) {
                // If fails (e.g. circular references), use safe serialization
                try {
                    return JSON.stringify(item, this.getCircularReplacer());
                } catch (fallbackError) {
                    this.logger.warn({
                        message:
                            'Failed to serialize object, using fallback string conversion',
                        context: TokenChunkingService.name,
                        metadata: {
                            itemType: typeof item,
                            error: fallbackError.message,
                        },
                    });
                    // Last fallback: safe toString
                    return String(item);
                }
            }
        }

        return String(item);
    }

    /**
     * Replacer function to handle circular references
     */
    private getCircularReplacer() {
        const seen = new WeakSet();
        return (key: string, value: any) => {
            if (typeof value === 'object' && value !== null) {
                if (seen.has(value)) {
                    return '[Circular]';
                }
                seen.add(value);
            }
            return value;
        };
    }

    /**
     * Checks if it is an OpenAI model
     */
    private isOpenAIModel(model: LLMModelProvider | string): boolean {
        const openaiModels = [
            LLMModelProvider.OPENAI_GPT_4O,
            LLMModelProvider.OPENAI_GPT_4O_MINI,
            LLMModelProvider.OPENAI_GPT_4_1,
            LLMModelProvider.OPENAI_GPT_O4_MINI,
        ];

        return openaiModels.includes(model as LLMModelProvider);
    }

    /**
     * Gets the OpenAI model name for tiktoken
     */
    private getOpenAIModelName(model: LLMModelProvider | string): string {
        const strategy = MODEL_STRATEGIES[model as LLMModelProvider];
        return strategy?.modelName || 'gpt-4o';
    }
}

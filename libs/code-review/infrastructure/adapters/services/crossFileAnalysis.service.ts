import { createLogger } from '@kodus/flow';
import {
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
    TokenUsage,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { LabelType } from '@libs/common/utils/codeManagement/labels';
import {
    CrossFileAnalysisPayload,
    CrossFileAnalysisSchema,
    CrossFileAnalysisSchemaType,
    CrossFileContextForPrompt,
    prompt_codereview_cross_file_analysis,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewCrossFileAnalysis';
import {
    AnalysisContext,
    CodeSuggestion,
    SuggestionType,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { TokenChunkingService } from '@libs/core/infrastructure/services/tokenChunking/tokenChunking.service';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';

//#region Interfaces
interface BatchProcessingConfig {
    maxConcurrentChunks: number;
    batchDelay: number; // milliseconds between batches
    retryAttempts: number;
    retryDelay: number; // milliseconds
}

interface ChunkProcessingResult {
    chunkIndex: number;
    result: CodeSuggestion[] | null;
    error?: Error;
    tokenUsage?: TokenUsage[];
}

type AnalysisType = 'analyzeCodeWithAI';
//#endregion

export const CROSS_FILE_ANALYSIS_SERVICE_TOKEN = Symbol(
    'CrossFileAnalysisService',
);

interface PreparedFileData {
    filename: string;
    patchWithLinesStr: string;
}

@Injectable()
export class CrossFileAnalysisService {
    private readonly logger = createLogger(CrossFileAnalysisService.name);
    private readonly DEFAULT_USAGE_LLM_MODEL_PERCENTAGE = 90;
    private readonly DEFAULT_BATCH_CONFIG: BatchProcessingConfig = {
        maxConcurrentChunks: 10,
        batchDelay: 2000,
        retryAttempts: 3,
        retryDelay: 1000,
    };

    constructor(
        private readonly tokenChunkingService: TokenChunkingService,
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
    ) {}

    async analyzeCrossFileCode(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        context: AnalysisContext,
        preparedFiles: PreparedFileData[],
        crossFileContexts?: CrossFileContextForPrompt[],
    ): Promise<{ codeSuggestions: CodeSuggestion[] }> {
        if (
            !preparedFiles ||
            !Array.isArray(preparedFiles) ||
            preparedFiles.length === 0
        ) {
            this.logger.warn({
                message: 'No prepared files found for cross-file analysis',
                context: CrossFileAnalysisService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return {
                codeSuggestions: [],
            };
        }

        if (!context?.codeReviewConfig) {
            this.logger.error({
                message: 'Missing codeReviewConfig in context',
                context: CrossFileAnalysisService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return {
                codeSuggestions: [],
            };
        }

        if (!context?.codeReviewConfig?.reviewOptions?.cross_file) {
            this.logger.log({
                message: 'Cross-file analysis is disabled in codeReviewConfig',
                context: CrossFileAnalysisService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return {
                codeSuggestions: [],
            };
        }

        const language =
            context.codeReviewConfig.languageResultPrompt || 'en-US';
        const provider = LLMModelProvider.GEMINI_2_5_PRO;

        try {
            // 1. Executar análise cross-file principal com arquivos preparados
            const crossFileAnalysisSuggestions =
                await this.processWithTokenChunking(
                    organizationAndTeamData,
                    prNumber,
                    context,
                    preparedFiles,
                    language,
                    provider,
                    'analyzeCodeWithAI',
                    crossFileContexts,
                );

            const finalSuggestions: CodeSuggestion[] =
                crossFileAnalysisSuggestions;

            this.logger.log({
                message:
                    'Cross-file analysis with prepared files completed successfully',
                context: CrossFileAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    finalSuggestions: finalSuggestions.length,
                },
            });

            return {
                codeSuggestions: finalSuggestions,
            };
        } catch (error) {
            this.logger.error({
                message: `Error during cross-file analysis with prepared files for PR#${prNumber}`,
                context: CrossFileAnalysisService.name,
                error,
                metadata: { organizationAndTeamData, prNumber },
            });
            throw error;
        }
    }
    //#endregion

    //#region Token Chunking with Parallel Processing
    /**
     * Processa análise com token chunking para arquivos preparados
     */
    private async processWithTokenChunking(
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        context: AnalysisContext,
        preparedFiles: PreparedFileData[],
        language: string,
        provider: LLMModelProvider,
        analysisType: AnalysisType,
        crossFileContexts?: CrossFileContextForPrompt[],
    ): Promise<CodeSuggestion[]> {
        const byokMaxInputTokens =
            context?.codeReviewConfig?.byokConfig?.main?.maxInputTokens;

        const chunkingResult = this.tokenChunkingService.chunkDataByTokens({
            model: provider,
            data: preparedFiles,
            usagePercentage: this.DEFAULT_USAGE_LLM_MODEL_PERCENTAGE,
            ...(byokMaxInputTokens && byokMaxInputTokens > 0
                ? { overrideMaxTokens: byokMaxInputTokens }
                : {}),
        });

        this.logger.log({
            message: `PR with prepared files divided into ${chunkingResult.totalChunks} chunks for ${analysisType}`,
            context: CrossFileAnalysisService.name,
            metadata: {
                totalFiles: preparedFiles.length,
                totalChunks: chunkingResult.totalChunks,
                tokenLimit: chunkingResult.tokenLimit,
                tokensPerChunk: chunkingResult.tokensPerChunk,
                prNumber,
                organizationAndTeamData,
                analysisType,
            },
        });

        // 3. Determinar configuração de batch
        const batchConfig = { ...this.DEFAULT_BATCH_CONFIG };

        const byokMaxConcurrent =
            context?.codeReviewConfig?.byokConfig?.main?.maxConcurrentRequests;
        if (byokMaxConcurrent && byokMaxConcurrent > 0) {
            batchConfig.maxConcurrentChunks = Math.min(
                batchConfig.maxConcurrentChunks,
                byokMaxConcurrent,
            );
        }

        // 4. Processar chunks em batches paralelos
        const allSuggestions = await this.processChunksInBatches(
            chunkingResult.chunks,
            context,
            language,
            provider,
            analysisType,
            prNumber,
            organizationAndTeamData,
            batchConfig,
            crossFileContexts,
        );

        return allSuggestions;
    }

    /**
     * NOVO MÉTODO: Processa chunks em batches paralelos para arquivos preparados
     */
    private async processChunksInBatches(
        chunks: PreparedFileData[][],
        context: AnalysisContext,
        language: string,
        provider: LLMModelProvider,
        analysisType: AnalysisType,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
        batchConfig: BatchProcessingConfig,
        crossFileContexts?: CrossFileContextForPrompt[],
    ): Promise<CodeSuggestion[]> {
        const allSuggestions: CodeSuggestion[] = [];
        let failedChunks = 0;
        let firstChunkError: Error | undefined;
        const totalChunks = chunks.length;
        const { maxConcurrentChunks, batchDelay } = batchConfig;

        for (let i = 0; i < totalChunks; i += maxConcurrentChunks) {
            const batchNumber = Math.floor(i / maxConcurrentChunks) + 1;
            const totalBatches = Math.ceil(totalChunks / maxConcurrentChunks);
            const batchChunks = chunks.slice(i, i + maxConcurrentChunks);

            this.logger.log({
                message: `Processing prepared files batch ${batchNumber}/${totalBatches} for ${analysisType}`,
                context: CrossFileAnalysisService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    batchNumber,
                    totalBatches,
                    chunksInBatch: batchChunks.length,
                    analysisType,
                },
            });

            const batchResults = await this.processBatchInParallel(
                batchChunks,
                i,
                context,
                language,
                provider,
                analysisType,
                prNumber,
                organizationAndTeamData,
                batchConfig,
                crossFileContexts,
            );

            batchResults.forEach(({ result, error, chunkIndex }) => {
                if (error) {
                    failedChunks++;
                    if (!firstChunkError) {
                        firstChunkError = error;
                    }
                    this.logger.error({
                        message: `Error in prepared files batch ${batchNumber}, chunk ${chunkIndex} for ${analysisType}`,
                        context: CrossFileAnalysisService.name,
                        error,
                        metadata: {
                            batchNumber,
                            chunkIndex,
                            prNumber,
                            organizationAndTeamData,
                            analysisType,
                        },
                    });
                } else if (result?.length) {
                    allSuggestions.push(...result);
                }
            });

            if (i + maxConcurrentChunks < totalChunks && batchDelay > 0) {
                await this.delay(batchDelay);
            }
        }

        if (failedChunks === totalChunks && totalChunks > 0) {
            const errorMessage = firstChunkError?.message || 'Unknown error';
            throw new Error(
                `Cross-file analysis failed in ${failedChunks}/${totalChunks} chunks: ${errorMessage}`,
            );
        }

        return allSuggestions;
    }

    /**
     * Processa batch em paralelo para arquivos preparados
     */
    private async processBatchInParallel(
        batchChunks: PreparedFileData[][],
        indexOffset: number,
        context: AnalysisContext,
        language: string,
        provider: LLMModelProvider,
        analysisType: AnalysisType,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
        batchConfig: BatchProcessingConfig,
        crossFileContexts?: CrossFileContextForPrompt[],
    ): Promise<ChunkProcessingResult[]> {
        const chunkPromises = batchChunks.map(async (chunk, batchIndex) => {
            const chunkIndex = indexOffset + batchIndex;

            return this.processChunkWithRetry(
                chunk,
                chunkIndex,
                context,
                language,
                provider,
                analysisType,
                prNumber,
                organizationAndTeamData,
                batchConfig,
                crossFileContexts,
            );
        });

        return Promise.all(chunkPromises);
    }

    /**
     * Processa chunk com retry para arquivos preparados
     */
    private async processChunkWithRetry(
        chunk: PreparedFileData[],
        chunkIndex: number,
        context: AnalysisContext,
        language: string,
        provider: LLMModelProvider,
        analysisType: AnalysisType,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
        batchConfig: BatchProcessingConfig,
        crossFileContexts?: CrossFileContextForPrompt[],
    ): Promise<ChunkProcessingResult> {
        const { retryAttempts, retryDelay } = batchConfig;
        const MAX_RETRY_DELAY = 10000;

        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                this.logger.log({
                    message: `Processing prepared files chunk ${chunkIndex + 1} for ${analysisType} (attempt ${attempt})`,
                    context: CrossFileAnalysisService.name,
                    metadata: {
                        chunkIndex,
                        attempt,
                        filesInChunk: chunk.length,
                        prNumber,
                        organizationAndTeamData,
                        analysisType,
                    },
                });

                const result = await this.processChunk(
                    context,
                    chunk,
                    language,
                    provider,
                    analysisType,
                    chunkIndex,
                    prNumber,
                    organizationAndTeamData,
                    crossFileContexts,
                );

                return { chunkIndex, result };
            } catch (error) {
                this.logger.warn({
                    message: `Error processing prepared files chunk ${chunkIndex + 1} for ${analysisType}, attempt ${attempt}`,
                    context: CrossFileAnalysisService.name,
                    error,
                    metadata: {
                        chunkIndex,
                        attempt,
                        prNumber,
                        organizationAndTeamData,
                        analysisType,
                    },
                });

                if (attempt < retryAttempts) {
                    const delayMs = Math.min(
                        retryDelay * attempt,
                        MAX_RETRY_DELAY,
                    );
                    await this.delay(delayMs);
                } else {
                    this.logger.error({
                        message: `Prepared files chunk ${chunkIndex + 1} failed after ${retryAttempts} attempts for ${analysisType}`,
                        context: CrossFileAnalysisService.name,
                        error,
                        metadata: {
                            chunkIndex,
                            totalAttempts: retryAttempts,
                            prNumber,
                            organizationAndTeamData,
                            analysisType,
                        },
                    });

                    return { chunkIndex, result: null, error: error as Error };
                }
            }
        }

        return {
            chunkIndex,
            result: null,
            error: new Error('Unexpected error in retry logic'),
        };
    }

    /**
     * Processa chunk individual para arquivos preparados
     */
    private async processChunk(
        context: AnalysisContext,
        preparedFilesChunk: PreparedFileData[],
        language: string,
        provider: LLMModelProvider,
        analysisType: AnalysisType,
        chunkIndex: number,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
        crossFileContexts?: CrossFileContextForPrompt[],
    ): Promise<CodeSuggestion[] | null> {
        const fileContexts =
            this.convertFilesToFileChangeContext(preparedFilesChunk);

        const payload = {
            files: fileContexts,
            language,
            v2PromptOverrides: context?.codeReviewConfig?.v2PromptOverrides,
            crossFileContexts,
            memories: context?.codeReviewConfig?.kodyMemoryRules || [],
            externalReferences:
                context?.externalPromptContext?.generation?.main?.references,
            externalReferenceErrors:
                context?.externalPromptContext?.generation?.main?.error,
        };

        const fallbackProvider = LLMModelProvider.GEMINI_2_5_FLASH;
        const runName = 'crossFileAnalyzeCodeWithAI';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            context?.codeReviewConfig?.byokConfig,
        );

        const spanName = `${CrossFileAnalysisService.name}::${runName}`;
        const spanAttrs = {
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            analysisType,
            chunkIndex,
            type: promptRunner.executeMode,
        };

        try {
            const analysisBuilder = promptRunner
                .builder()
                .setParser(ParserType.ZOD, CrossFileAnalysisSchema)
                .setLLMJsonMode(true)
                .setPayload(payload)
                .addPrompt({
                    prompt: prompt_codereview_cross_file_analysis,
                    role: PromptRole.SYSTEM,
                })
                .addPrompt({
                    prompt: 'Please analyze the provided information and return the response in the specified format.',
                    role: PromptRole.USER,
                })
                .setTemperature(0)
                .addTags([
                    ...this.buildTags(provider, 'primary', analysisType),
                    ...this.buildTags(
                        fallbackProvider,
                        'fallback',
                        analysisType,
                    ),
                ])
                .setRunName(runName)
                .setMaxReasoningTokens(5000)
                .addMetadata({
                    organizationAndTeamData,
                    prNumber,
                    provider:
                        context?.codeReviewConfig?.byokConfig?.main?.provider ||
                        provider,
                    model: context?.codeReviewConfig?.byokConfig?.main?.model,
                    fallbackProvider:
                        context?.codeReviewConfig?.byokConfig?.fallback
                            ?.provider || fallbackProvider,
                    fallbackModel:
                        context?.codeReviewConfig?.byokConfig?.fallback?.model,
                    analysisType,
                    runName,
                });

            const byokConfigRef = context?.codeReviewConfig?.byokConfig;

            const { result: analysis } =
                await this.observabilityService.runLLMInSpan({
                    spanName,
                    runName,
                    attrs: spanAttrs,
                    byokConfig: byokConfigRef,
                    exec: (callbacks) =>
                        analysisBuilder.addCallbacks(callbacks).execute(),
                });

            if (!analysis) {
                const message = `Empty response from LLM for ${analysisType} on chunk ${chunkIndex + 1}`;
                this.logger.error({
                    message,
                    context: CrossFileAnalysisService.name,
                    metadata: {
                        chunkIndex,
                        prNumber,
                        organizationAndTeamData,
                        analysisType,
                    },
                });
                throw new Error(message);
            }

            return this.processLLMResponse(
                analysis,
                analysisType,
                prNumber,
                organizationAndTeamData,
            );
        } catch (error) {
            this.logger.error({
                message: `Error processing ${analysisType} on chunk ${chunkIndex + 1}`,
                context: CrossFileAnalysisService.name,
                error,
                metadata: {
                    chunkIndex,
                    prNumber,
                    organizationAndTeamData,
                    analysisType,
                },
            });
            throw error;
        }
    }
    //#endregion

    //#region Response Processing
    /**
     * Processa resposta do LLM baseada no tipo de análise
     */
    private processLLMResponse(
        response: CrossFileAnalysisSchemaType,
        analysisType: AnalysisType,
        prNumber: number,
        organizationAndTeamData: OrganizationAndTeamData,
    ): CodeSuggestion[] | null {
        try {
            if (
                !response ||
                !response.suggestions ||
                !Array.isArray(response.suggestions)
            ) {
                this.logger.warn({
                    message: `Empty response from LLM for ${analysisType}`,
                    context: CrossFileAnalysisService.name,
                    metadata: {
                        prNumber,
                        organizationAndTeamData,
                        analysisType,
                    },
                });
                return null;
            }

            // Validar e enriquecer sugestões
            const validSuggestions = response.suggestions
                .filter((suggestion) =>
                    this.validateSuggestion(suggestion, analysisType),
                )
                .map((suggestion) => this.enrichSuggestion(suggestion));

            this.logger.log({
                message: `Successfully processed ${analysisType} response`,
                context: CrossFileAnalysisService.name,
                metadata: {
                    prNumber,
                    organizationAndTeamData,
                    analysisType,
                    rawSuggestions: response.suggestions.length,
                    validSuggestions: validSuggestions.length,
                },
            });

            return validSuggestions;
        } catch (error) {
            this.logger.error({
                message: `Error processing LLM response for ${analysisType}`,
                context: CrossFileAnalysisService.name,
                error,
                metadata: {
                    prNumber,
                    organizationAndTeamData,
                    analysisType,
                    responseLength: response?.suggestions?.length || 0,
                },
            });
            return null;
        }
    }

    /**
     * Valida se uma sugestão tem os campos obrigatórios
     */
    private validateSuggestion(
        suggestion: any,
        analysisType: AnalysisType,
    ): boolean {
        const requiredFields = ['suggestionContent', 'relevantFile'];

        for (const field of requiredFields) {
            if (!suggestion[field]) {
                this.logger.warn({
                    message: `Suggestion missing required field: ${field}`,
                    context: CrossFileAnalysisService.name,
                    metadata: { analysisType, suggestion },
                });
                return false;
            }
        }

        return true;
    }

    /**
     * Enriquece sugestão com campos padrão se necessário
     */
    private enrichSuggestion(
        suggestion: CrossFileAnalysisSchemaType['suggestions'][number],
    ): CodeSuggestion {
        return {
            id: uuidv4(),
            relevantFile: suggestion.relevantFile,
            language: suggestion?.language || '',
            suggestionContent: suggestion.suggestionContent,
            existingCode: suggestion.existingCode,
            improvedCode: suggestion?.improvedCode || '',
            oneSentenceSummary: suggestion.oneSentenceSummary,
            relevantLinesStart: suggestion.relevantLinesStart,
            relevantLinesEnd: suggestion.relevantLinesEnd,
            label: LabelType.CROSS_FILE,
            severity: suggestion.severity,
            rankScore: 0,
            type: SuggestionType.CROSS_FILE,
            ...suggestion, // Preserva outros campos que podem existir
        };
    }
    //#endregion

    //#region Utility Methods
    /**
     * Converte PreparedFileData[] para formato esperado pelo prompt
     */
    private convertFilesToFileChangeContext(
        preparedFiles: PreparedFileData[],
    ): Partial<CrossFileAnalysisPayload['files']> {
        return preparedFiles.map((preparedFile) => ({
            file: {
                filename: preparedFile.filename,
                codeDiff: preparedFile.patchWithLinesStr, // ✨ Usa patchWithLinesStr em vez de patch
            },
        }));
    }

    /**
     * Utility para delay
     */
    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * Constrói tags para o LLM
     */
    private buildTags(
        provider: LLMModelProvider,
        tier: 'primary' | 'fallback',
        analysisType: AnalysisType,
    ): string[] {
        return [
            `model:${provider}`,
            `tier:${tier}`,
            'crossFileAnalysis',
            analysisType,
        ];
    }
    //#endregion
}

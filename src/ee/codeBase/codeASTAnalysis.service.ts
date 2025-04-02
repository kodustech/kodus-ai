import * as path from 'path';
import {
    CodeAnalysisAST,
    Repository,
    ReviewModeResponse,
    AnalysisContext,
    AIAnalysisResult,
    CodeSuggestion,
} from '@/config/types/general/codeReview.type';
import { IASTAnalysisService } from '@/core/domain/codeBase/contracts/ASTAnalysisService.contract';
import {
    CodeAnalyzerService,
    FunctionsAffectResult,
    FunctionSimilarity,
} from './ast/services/code-analyzer.service';
import { CodeKnowledgeGraphService } from './ast/services/code-knowledge-graph.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import {
    getChatGPT,
    getDeepseekByNovitaAI,
} from '@/shared/utils/langchainCommon/document';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { prompt_detectBreakingChanges } from '@/shared/utils/langchainCommon/prompts/detectBreakingChanges';
import { Injectable } from '@nestjs/common';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { LLMResponseProcessor } from '@/core/infrastructure/adapters/services/codeBase/utils/transforms/llmResponseProcessor.transform';
import { ChangeResult, DiffAnalyzerService } from './diffAnalyzer.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

@Injectable()
export class CodeAstAnalysisService implements IASTAnalysisService {
    private readonly llmResponseProcessor: LLMResponseProcessor;

    constructor(
        private readonly codeAnalyzerService: CodeAnalyzerService,
        private readonly codeKnowledgeGraphService: CodeKnowledgeGraphService,
        private readonly diffAnalyzerService: DiffAnalyzerService,
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
    ) {
        this.llmResponseProcessor = new LLMResponseProcessor(logger);
    }

    async analyzeASTWithAI(
        context: AnalysisContext,
        reviewModeResponse: ReviewModeResponse,
    ): Promise<AIAnalysisResult> {
        try {
            const provider = LLMModelProvider.DEEPSEEK_V3;

            const baseContext = await this.prepareAnalysisContext(context);

            const chain = await this.createAnalysisChainWithFallback(
                provider,
                context,
            );

            // Execute analysis
            const result = await chain.invoke(baseContext);

            // Process result and tokens
            const analysisResult = this.llmResponseProcessor.processResponse(
                context.organizationAndTeamData,
                context.pullRequest.number,
                result,
            );

            analysisResult.codeReviewModelUsed = {
                generateSuggestions: provider,
            };

            return {
                ...analysisResult,
                codeSuggestions: analysisResult?.codeSuggestions?.map(
                    (codeSuggestion: CodeSuggestion) => ({
                        ...codeSuggestion,
                        severity: SeverityLevel.CRITICAL,
                        label: 'breaking_changes',
                    }),
                ),
            };
        } catch (error) {
            this.logger.error({
                message: `Error during AST code analysis for PR#${context.pullRequest.number}`,
                context: CodeAstAnalysisService.name,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
                error,
            });
            throw error;
        }
    }

    async cloneAndGenerate(
        repository: any,
        pullRequest: any,
        platformType: string,
        organizationAndTeamData: any,
    ): Promise<CodeAnalysisAST> {
        try {
            const headDir = await this.cloneRepository(
                {
                    id: repository.id,
                    name: repository.name,
                    defaultBranch: pullRequest.head.ref,
                    fullName:
                        repository.full_name ||
                        `${repository.owner}/${repository.name}`,
                    platform: platformType as 'github' | 'gitlab' | 'bitbucket',
                    language: repository.language || 'unknown',
                },
                organizationAndTeamData,
            );

            if (!headDir) {
                return null;
            }

            const baseDir = await this.cloneRepository(
                {
                    id: repository.id,
                    name: repository.name,
                    defaultBranch: pullRequest.base.ref,
                    fullName:
                        repository.full_name ||
                        `${repository.owner}/${repository.name}`,
                    platform: platformType as 'github' | 'gitlab' | 'bitbucket',
                    language: repository.language || 'unknown',
                },
                organizationAndTeamData,
            );

            if (!baseDir) {
                return null;
            }

            const headCodeGraph =
                await this.codeKnowledgeGraphService.buildGraphProgressively(
                    headDir,
                );

            const baseGraph =
                await this.codeKnowledgeGraphService.buildGraphProgressively(
                    baseDir,
                );

            const headCodeGraphEnriched =
                await this.codeAnalyzerService.enrichGraph(headCodeGraph);

            const codeAnalysisAST: CodeAnalysisAST = {
                headCodeGraph: {
                    codeGraphFunctions: headCodeGraph?.functions,
                    cloneDir: headDir,
                },
                baseCodeGraph: {
                    codeGraphFunctions: baseGraph?.functions,
                    cloneDir: baseDir,
                },
                headCodeGraphEnriched,
            };

            return codeAnalysisAST;
        } catch (error) {
            this.logger.error({
                message: `Error during AST Clone and Generate graph for PR#${pullRequest.number}`,
                context: CodeAstAnalysisService.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: pullRequest?.number,
                },
                error,
            });
            return null;
        }
    }

    private async cloneRepository(
        repository: Repository,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        return await this.codeManagementService.cloneRepository({
            repository,
            organizationAndTeamData,
        });
    }

    async analyzeCodeWithGraph(
        codeChunk: string,
        fileName: string,
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: any,
        codeAnalysisAST: CodeAnalysisAST,
    ): Promise<ChangeResult> {
        try {
            const processedChunk =
                this.codeAnalyzerService.preprocessCustomDiff(codeChunk);

            const prFilePath = path.join(
                codeAnalysisAST?.headCodeGraph?.cloneDir,
                fileName,
            );
            const baseFilePath = path.join(
                codeAnalysisAST?.baseCodeGraph?.cloneDir,
                fileName,
            );

            const functionsAffected: ChangeResult =
                await this.diffAnalyzerService.analyzeDiff(
                    {
                        diff: processedChunk,
                        headCodeGraphFunctions:
                            codeAnalysisAST?.headCodeGraph?.codeGraphFunctions,
                        prFilePath,
                    },
                    {
                        baseCodeGraphFunctions:
                            codeAnalysisAST?.baseCodeGraph?.codeGraphFunctions,
                        baseFilePath,
                    },
                );

            return functionsAffected;
        } catch (error) {
            this.logger.error({
                message: `Error during AST analyze CodeWith Graph for PR#${pullRequest.number}`,
                context: CodeAstAnalysisService.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: pullRequest?.number,
                },
                error,
            });
            throw error;
        }
    }

    async generateImpactAnalysis(
        codeAnalysis: CodeAnalysisAST,
        functionsAffected: ChangeResult,
        pullRequest: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<{
        functionsAffectResult: FunctionsAffectResult[];
        functionSimilarity: FunctionSimilarity[];
    }> {
        try {
            const impactedNodes =
                await this.codeAnalyzerService.computeImpactAnalysis(
                    codeAnalysis?.headCodeGraphEnriched,
                    [functionsAffected],
                    1,
                    'backward',
                );

            const functionSimilarity: FunctionSimilarity[] =
                await this.codeAnalyzerService.checkFunctionSimilarity(
                    {
                        organizationAndTeamData,
                        pullRequest,
                    },
                    functionsAffected.added,
                    Object.values(
                        codeAnalysis.headCodeGraph.codeGraphFunctions,
                    ),
                );

            const functionsAffectResult: FunctionsAffectResult[] =
                this.codeAnalyzerService.buildFunctionsAffect(
                    impactedNodes,
                    codeAnalysis.baseCodeGraph.codeGraphFunctions,
                    codeAnalysis.headCodeGraph.codeGraphFunctions,
                );

            return {
                functionSimilarity,
                functionsAffectResult,
            };
        } catch (error) {
            this.logger.error({
                message: `Error during AST generate Impact Analysis for PR#${pullRequest.number}`,
                context: CodeAstAnalysisService.name,
                metadata: {
                    organizationAndTeamData: organizationAndTeamData,
                    prNumber: pullRequest?.number,
                },
                error,
            });
            throw error;
        }
    }

    private async createAnalysisChainWithFallback(
        provider: LLMModelProvider,
        context: AnalysisContext,
    ) {
        const fallbackProvider = LLMModelProvider.CHATGPT_4_ALL;

        try {
            const mainChain = await this.createAnalysisProviderChain(provider);
            const fallbackChain =
                await this.createAnalysisProviderChain(fallbackProvider);

            // Usar withFallbacks para configurar o fallback corretamente
            return mainChain
                .withFallbacks({
                    fallbacks: [fallbackChain],
                })
                .withConfig({
                    runName: 'CodeASTAnalysisAI',
                    metadata: {
                        organizationId:
                            context?.organizationAndTeamData?.organizationId,
                        teamId: context?.organizationAndTeamData?.teamId,
                        pullRequestId: context?.pullRequest?.number,
                    },
                });
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis chain with fallback',
                error,
                context: CodeAstAnalysisService.name,
                metadata: {
                    provider,
                    fallbackProvider,
                },
            });
            throw error;
        }
    }

    private async createAnalysisProviderChain(provider: LLMModelProvider) {
        try {
            let llm =
                provider === LLMModelProvider.DEEPSEEK_V3
                    ? getDeepseekByNovitaAI({
                          temperature: 0,
                      })
                    : getChatGPT({
                          model: getLLMModelProviderWithFallback(
                              LLMModelProvider.CHATGPT_4_ALL,
                          ),
                          temperature: 0,
                      });

            if (provider === LLMModelProvider.CHATGPT_4_ALL) {
                llm = llm.bind({
                    response_format: { type: 'json_object' },
                });
            }

            const chain = RunnableSequence.from([
                async (input: any) => {
                    return [
                        {
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: prompt_detectBreakingChanges(input),
                                },
                            ],
                        },
                    ];
                },
                llm,
                new StringOutputParser(),
            ]);

            return chain;
        } catch (error) {
            this.logger.error({
                message: 'Error creating analysis code chain',
                error,
                context: CodeAstAnalysisService.name,
                metadata: { provider },
            });
            throw error;
        }
    }

    private async prepareAnalysisContext(context: AnalysisContext) {
        const baseContext = {
            language: context?.repository?.language,
            languageResultPrompt:
                context?.codeReviewConfig?.languageResultPrompt,
            impactASTAnalysis: context?.impactASTAnalysis?.functionsAffectResult
                ? Object.values(
                      context?.impactASTAnalysis?.functionsAffectResult,
                  )
                : [],
        };

        return baseContext;
    }
}

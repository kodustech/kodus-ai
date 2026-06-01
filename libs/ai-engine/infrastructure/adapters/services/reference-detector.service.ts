import { ContextDependency } from '@kodus/flow';
import { createLogger } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import {
    IDetectedReference,
    IFileReference,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import {
    prompt_detect_external_references_system,
    prompt_detect_external_references_user,
} from '@libs/common/utils/langchainCommon/prompts/externalReferences';
import {
    prompt_kodyrules_detect_references_system,
    prompt_kodyrules_detect_references_user,
} from '@libs/common/utils/langchainCommon/prompts/kodyRulesExternalReferences';
import { extractJsonFromResponse } from '@libs/common/utils/prompt-parser.utils';

export interface DetectReferencesParams {
    requirementId: string;
    promptText: string;
    organizationAndTeamData: OrganizationAndTeamData;
    context?: 'rule' | 'instruction' | 'prompt';
    detectionMode?: 'rule' | 'prompt';
    byokConfig?: BYOKConfig;
}

@Injectable()
export class ReferenceDetectorService {
    private readonly logger = createLogger(ReferenceDetectorService.name);

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
    ) {}

    hasLikelyExternalReferences(promptText: string): boolean {
        const patterns = [
            /@file[:\s]/i,
            /\[\[file:/i,
            /@\w+\.(ts|js|py|md|yml|yaml|json|txt|go|java|cpp|c|h|rs)/i,
            /refer to.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /check.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /see.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /\b\w+\.\w+\.(ts|js|py|md|yml|yaml|json|txt)\b/i,
            /\b[A-Z_][A-Z0-9_]*\.(ts|js|py|md|yml|yaml|json|txt)\b/,
            /\b(readme|contributing|changelog|license|setup|config|package|tsconfig|jest\.config|vite\.config|webpack\.config)\.(md|json|yml|yaml|ts|js)\b/i,
        ];

        return patterns.some((pattern) => pattern.test(promptText));
    }

    async detectReferences(
        params: DetectReferencesParams,
    ): Promise<IDetectedReference[]> {
        const mainProvider = LLMModelProvider.GEMINI_2_5_FLASH;
        const fallbackProvider = LLMModelProvider.GEMINI_2_5_PRO;
        const runName = 'detectExternalReferences';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            mainProvider,
            fallbackProvider,
            params.byokConfig,
        );

        const { organizationAndTeamData } = params;

        const { result: raw } = await this.observabilityService.runLLMInSpan({
            spanName: `${ReferenceDetectorService.name}::${runName}`,
            runName,
            attrs: {
                organizationId: organizationAndTeamData.organizationId,
                type: promptRunner.executeMode,
                fallback: false,
                context: params.context || 'unknown',
            },
            byokConfig: params.byokConfig,
            exec: async (callbacks) => {
                const isRuleMode = params.detectionMode === 'rule';
                const systemPrompt = isRuleMode
                    ? prompt_kodyrules_detect_references_system()
                    : prompt_detect_external_references_system();
                const userPrompt = isRuleMode
                    ? prompt_kodyrules_detect_references_user({
                          rule: params.promptText,
                      })
                    : prompt_detect_external_references_user({
                          text: params.promptText,
                          context: params.context,
                      });

                return await promptRunner
                    .builder()
                    .setParser(ParserType.STRING)
                    .setPayload({
                        text: params.promptText,
                        context: params.context,
                    })
                    .addPrompt({
                        role: PromptRole.SYSTEM,
                        prompt: systemPrompt,
                    })
                    .addPrompt({
                        role: PromptRole.USER,
                        prompt: userPrompt,
                    })
                    .addCallbacks(callbacks)
                    .addMetadata({ runName })
                    .setRunName(runName)
                    .execute();
            },
        });

        if (!raw) {
            return [];
        }

        const parsed = extractJsonFromResponse(raw);
        if (!parsed || !Array.isArray(parsed)) {
            return [];
        }

        this.logger.debug({
            message: 'Detected external references',
            context: ReferenceDetectorService.name,
            metadata: {
                referencesCount: parsed.length,
                organizationAndTeamData,
                requirementId: params.requirementId,
            },
        });

        return parsed as IDetectedReference[];
    }

    extractMarkers(promptText: string, references: IFileReference[]): string[] {
        const markers = new Set<string>();

        for (const reference of references) {
            if (reference.originalText) {
                markers.add(reference.originalText);
            }
        }

        const fileRegex = /@[A-Za-z0-9/_\-.]+/g;
        const fileMatches = promptText.match(fileRegex);
        if (fileMatches) {
            fileMatches.forEach((match) => markers.add(match));
        }

        // Detect MCP markers: @mcp<app|tool>
        const mcpRegex = /@mcp<([^|>]+)\|([^>]+)>/g;
        let mcpMatch;
        while ((mcpMatch = mcpRegex.exec(promptText)) !== null) {
            markers.add(mcpMatch[0]); // Add the full @mcp<app|tool> marker
        }

        return Array.from(markers.values());
    }

    extractMCPDependencies(
        text: string,
        repositoryId: string,
    ): ContextDependency[] {
        const mcpDependencies: ContextDependency[] = [];
        const mcpRegex = /@mcp<([^|>]+)\|([^>]+)>/g;
        let match;

        this.logger.debug({
            message: 'Extracting MCP dependencies from text',
            context: ReferenceDetectorService.name,
            metadata: {
                textLength: text.length,
                textSnippet: text.substring(0, 200),
                repositoryId,
            },
        });

        while ((match = mcpRegex.exec(text)) !== null) {
            const [fullMatch, app, tool] = match;
            this.logger.log({
                message: 'Found MCP dependency',
                context: ReferenceDetectorService.name,
                metadata: {
                    fullMatch,
                    app,
                    tool,
                    repositoryId,
                },
            });
            mcpDependencies.push({
                type: 'mcp',
                id: `${app}|${tool}`,
                metadata: {
                    app,
                    tool,
                    originalText: fullMatch,
                    repositoryId,
                    detectedAt: new Date().toISOString(),
                },
            });
        }

        this.logger.debug({
            message: 'MCP extraction completed',
            context: ReferenceDetectorService.name,
            metadata: {
                foundCount: mcpDependencies.length,
            },
        });

        return mcpDependencies;
    }
}

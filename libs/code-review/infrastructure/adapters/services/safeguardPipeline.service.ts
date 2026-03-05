import { createLogger } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    SafeguardFeatureExtractionResult,
    SafeguardFeatureSet,
    STRUCTURAL_DEFECT_FEATURES,
    prompt_codeReviewSafeguard_featureExtraction,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguardFeatures';
import {
    TriageDecision,
    triageSuggestion,
} from '@libs/code-review/infrastructure/adapters/services/safeguardTriage.service';
import { prompt_codeReviewSafeguard_verification } from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguardVerification';
import {
    SAFEGUARD_CROSS_FILE_CONTEXT_PREAMBLE,
    formatMemoriesSection,
    formatReferenceSection,
    formatSyncErrors,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguard';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ISafeguardResponse } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ReviewModeResponse } from '@libs/core/domain/enums/code-review.enum';

interface SafeguardPipelineParams {
    organizationAndTeamData: OrganizationAndTeamData;
    prNumber: number;
    file: any;
    relevantContent: string;
    codeDiff: string;
    suggestions: any[];
    languageResultPrompt: string;
    reviewMode: ReviewModeResponse;
    byokConfig: BYOKConfig;
    crossFileSnippets?: CrossFileContextSnippet[];
    remoteCommands?: RemoteCommands;
    memories?: Array<Partial<{ title?: string; rule?: string }>>;
    externalReferences?: unknown[];
    externalReferenceErrors?: unknown[] | string;
}

const MAX_AGENT_TURNS = 6;

@Injectable()
export class SafeguardPipelineService {
    private readonly logger = createLogger(SafeguardPipelineService.name);

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observability: ObservabilityService,
    ) {}

    async execute(params: SafeguardPipelineParams): Promise<ISafeguardResponse> {
        const {
            organizationAndTeamData,
            prNumber,
            file,
            suggestions,
            byokConfig,
            remoteCommands,
        } = params;

        const provider = LLMModelProvider.GEMINI_2_5_PRO;
        const fallbackProvider = LLMModelProvider.NOVITA_DEEPSEEK_V3;

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            byokConfig,
        );

        const pipelineStart = Date.now();
        const fileLabel = file?.filename || 'unknown';

        try {
            // Step 1: Feature Extraction (batch — one LLM call for all suggestions in the file)
            const feStart = Date.now();
            const featureResult = await this.extractFeatures(params, promptRunner);
            const feMs = Date.now() - feStart;

            if (!featureResult?.codeSuggestions?.length) {
                this.logger.warn({
                    message: `No features extracted for PR#${prNumber} file ${file?.filename}`,
                    context: SafeguardPipelineService.name,
                });
                this.logger.log({
                    message: `[TIMING] PR#${prNumber} ${fileLabel} — Feature Extraction: ${(feMs / 1000).toFixed(1)}s (no features) | Total: ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s`,
                    context: SafeguardPipelineService.name,
                });
                return { suggestions, codeReviewModelUsed: { safeguard: provider } };
            }

            // Build lookup map: suggestion id → features
            const featuresById = new Map<string, SafeguardFeatureSet>();
            for (const item of featureResult.codeSuggestions) {
                if (item.id && item.features) {
                    featuresById.set(item.id, item.features);
                }
            }

            // Step 2: Triage (deterministic — per suggestion)
            const kept: any[] = [];
            const toVerify: Array<{ suggestion: any; features: SafeguardFeatureSet }> = [];
            let discardedCount = 0;

            for (const suggestion of suggestions) {
                const features = featuresById.get(suggestion.id);
                if (!features) {
                    // No features extracted — keep suggestion as-is (safe default)
                    this.logger.log({
                        message: `[TRIAGE] PR#${prNumber} ${fileLabel} — suggestion "${suggestion.label || suggestion.id}" (${suggestion.severity}): no features → keep (default)`,
                        context: SafeguardPipelineService.name,
                    });
                    kept.push(suggestion);
                    continue;
                }

                const decision: TriageDecision = triageSuggestion(features);

                this.logger.log({
                    message: `[TRIAGE] PR#${prNumber} ${fileLabel} — suggestion "${suggestion.label || suggestion.id}" (${suggestion.severity}): decision=${decision} | features: ${JSON.stringify(features)}`,
                    context: SafeguardPipelineService.name,
                });

                if (decision === 'keep') {
                    // Handle improvedCode correctness
                    if (features.improvedCode_is_correct === false) {
                        kept.push({ ...suggestion, improvedCode: null });
                    } else {
                        kept.push(suggestion);
                    }
                } else if (decision === 'discard') {
                    // Discarded — do not include in output
                    discardedCount++;
                    continue;
                } else {
                    // 'verify' — needs agent investigation
                    toVerify.push({ suggestion, features });
                }
            }

            this.logger.log({
                message: `[TIMING] PR#${prNumber} ${fileLabel} — Feature Extraction: ${(feMs / 1000).toFixed(1)}s | Triage: ${kept.length} kept, ${discardedCount} discarded, ${toVerify.length} verify (of ${suggestions.length} total)`,
                context: SafeguardPipelineService.name,
            });

            // Step 3: Agent Verification (per suggestion that needs it)
            if (toVerify.length > 0 && remoteCommands) {
                // Create a separate prompt runner for agent turns (use Flash for cost efficiency)
                const agentProvider = LLMModelProvider.GEMINI_2_5_FLASH;
                const agentPromptRunner = new BYOKPromptRunnerService(
                    this.promptRunnerService,
                    agentProvider,
                    undefined,
                    byokConfig,
                );

                const agentStart = Date.now();
                let agentKept = 0;
                let agentDiscarded = 0;
                let totalTurns = 0;

                for (const { suggestion, features } of toVerify) {
                    try {
                        const suggStart = Date.now();
                        const result = await this.verifyWithAgent(
                            suggestion,
                            features,
                            remoteCommands,
                            agentPromptRunner,
                            params.languageResultPrompt,
                            organizationAndTeamData,
                            prNumber,
                            params.memories,
                        );

                        const suggMs = Date.now() - suggStart;

                        if (result.action === 'no_changes') {
                            if (features.improvedCode_is_correct === false) {
                                kept.push({ ...suggestion, improvedCode: null });
                            } else {
                                kept.push(suggestion);
                            }
                            agentKept++;
                        } else {
                            agentDiscarded++;
                        }

                        this.logger.log({
                            message: `[TIMING] PR#${prNumber} ${fileLabel} — Agent verified suggestion ${suggestion.id}: ${result.action} in ${(suggMs / 1000).toFixed(1)}s (${result.turnsUsed}/${MAX_AGENT_TURNS} turns) | Evidence: ${(result.evidence || '').substring(0, 120)}`,
                            context: SafeguardPipelineService.name,
                        });
                        totalTurns += result.turnsUsed;
                    } catch (error) {
                        this.logger.warn({
                            message: `Agent verification failed for suggestion ${suggestion.id}, discarding (safe default)`,
                            context: SafeguardPipelineService.name,
                            error,
                        });
                        agentDiscarded++;
                        // Safe default: discard on agent failure
                    }
                }

                const agentMs = Date.now() - agentStart;
                this.logger.log({
                    message: `[TIMING] PR#${prNumber} ${fileLabel} — Agent Verification: ${(agentMs / 1000).toFixed(1)}s (${toVerify.length} suggestions, ${agentKept} kept, ${agentDiscarded} discarded, ${totalTurns} total turns, avg ${(agentMs / toVerify.length / 1000).toFixed(1)}s each)`,
                    context: SafeguardPipelineService.name,
                });
            } else if (toVerify.length > 0 && !remoteCommands) {
                // No sandbox available — discard all "verify" suggestions (safe default)
                this.logger.log({
                    message: `[TIMING] PR#${prNumber} ${fileLabel} — No E2B sandbox available, discarding ${toVerify.length} ambiguous suggestions`,
                    context: SafeguardPipelineService.name,
                });
            }

            this.logger.log({
                message: `[TIMING] PR#${prNumber} ${fileLabel} — Pipeline Total: ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s | Input: ${suggestions.length} suggestions → Output: ${kept.length} kept`,
                context: SafeguardPipelineService.name,
            });

            return {
                suggestions: kept,
                codeReviewModelUsed: { safeguard: byokConfig?.main?.provider || provider },
            };
        } catch (error) {
            this.logger.error({
                message: `Safeguard pipeline failed for PR#${prNumber} file ${file?.filename}, returning all suggestions (${((Date.now() - pipelineStart) / 1000).toFixed(1)}s)`,
                context: SafeguardPipelineService.name,
                error,
            });
            return { suggestions, codeReviewModelUsed: { safeguard: provider } };
        }
    }

    /**
     * Step 1: Extract boolean features for each suggestion using a single LLM call.
     */
    private async extractFeatures(
        params: SafeguardPipelineParams,
        promptRunner: BYOKPromptRunnerService,
    ): Promise<SafeguardFeatureExtractionResult> {
        const {
            organizationAndTeamData,
            prNumber,
            file,
            relevantContent,
            codeDiff,
            suggestions,
            languageResultPrompt,
            reviewMode,
            crossFileSnippets,
        } = params;

        const runName = 'safeguardFeatureExtraction';

        const schema = z.object({
            codeSuggestions: z.array(
                z.object({
                    id: z.string(),
                    features: z.object({
                        has_resource_leak: z.boolean(),
                        has_inconsistent_contract: z.boolean(),
                        has_wrong_algorithm: z.boolean(),
                        has_data_exposure: z.boolean(),
                        has_missing_error_handling: z.boolean(),
                        has_redundant_work_in_loop: z.boolean(),
                        has_unsafe_data_flow: z.boolean(),
                        requires_assumed_input: z.boolean(),
                        requires_assumed_workload: z.boolean(),
                        is_quality_opinion: z.boolean(),
                        is_anti_pattern_only: z.boolean(),
                        targets_unchanged_code: z.boolean(),
                        improvedCode_is_correct: z.boolean(),
                    }),
                }),
            ),
        });

        const systemPrompt = prompt_codeReviewSafeguard_featureExtraction({
            languageResultPrompt,
        });

        const userPrompt = this.buildUserPrompt({
            fileContent: file?.fileContent,
            relevantContent,
            patchWithLinesStr: codeDiff,
            filePath: file?.filename,
            suggestions,
            crossFileSnippets,
            memories: params.memories,
            externalReferences: params.externalReferences,
            externalReferenceErrors: params.externalReferenceErrors,
        });

        const spanName = `${SafeguardPipelineService.name}::${runName}`;
        const spanAttrs = {
            type: promptRunner.executeMode,
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            file: { filePath: file?.filename },
        };

        const { result } = await this.observability.runLLMInSpan({
            spanName,
            runName,
            attrs: spanAttrs,
            exec: async (callbacks) => {
                return await promptRunner
                    .builder()
                    .setParser(ParserType.ZOD, schema as any, {
                        provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                        fallbackProvider: LLMModelProvider.OPENAI_GPT_4O,
                    })
                    .setLLMJsonMode(true)
                    .addPrompt({
                        prompt: systemPrompt,
                        role: PromptRole.SYSTEM,
                    })
                    .addPrompt({
                        prompt: userPrompt,
                        role: PromptRole.USER,
                    })
                    .addMetadata({
                        organizationId: organizationAndTeamData?.organizationId,
                        teamId: organizationAndTeamData?.teamId,
                        pullRequestId: prNumber,
                        reviewMode,
                        runName,
                    })
                    .setTemperature(0)
                    .addCallbacks(callbacks)
                    .setRunName(runName)
                    .execute();
            },
        });

        const parsed = schema.safeParse(result);
        if (!parsed.success) {
            this.logger.warn({
                message: `Feature extraction parse failed for PR#${prNumber}`,
                context: SafeguardPipelineService.name,
                metadata: { error: parsed.error.message },
            });
            return { codeSuggestions: [] };
        }

        return parsed.data;
    }

    /**
     * Step 3: Multi-turn agent loop that searches the codebase to verify a suggestion.
     */
    private async verifyWithAgent(
        suggestion: any,
        features: SafeguardFeatureSet,
        remoteCommands: RemoteCommands,
        promptRunner: BYOKPromptRunnerService,
        languageResultPrompt: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        memories?: Array<Partial<{ title?: string; rule?: string }>>,
    ): Promise<{ verified: boolean; action: string; evidence: string; turnsUsed: number }> {
        const claimedDefects = STRUCTURAL_DEFECT_FEATURES
            .filter((f) => features[f])
            .join(', ');

        const systemPrompt = prompt_codeReviewSafeguard_verification({
            suggestionContent: suggestion.suggestionContent || '',
            claimedDefectType: claimedDefects,
            existingCode: suggestion.existingCode || '',
            filePath: suggestion.filePath || '',
            languageResultPrompt,
        });

        // Build initial user message with optional memory rules context
        let userMessage = 'Verify the suggestion. Begin by searching for the key symbol or reading the file.';
        const memoriesBlock = formatMemoriesSection(
            memories as Array<{ title?: string; rule?: string }>,
        );
        if (memoriesBlock) {
            userMessage += `\n\n${memoriesBlock}\n\nConsider these team rules when evaluating the suggestion — if it contradicts a rule, lean towards discarding.`;
        }

        // Build conversation history for multi-turn agent loop
        // Gemini requires at least one USER message in contents (SYSTEM goes to systemInstruction)
        const messages: Array<{ prompt: string; role: PromptRole }> = [
            { prompt: systemPrompt, role: PromptRole.SYSTEM },
            { prompt: userMessage, role: PromptRole.USER },
        ];

        const runName = 'safeguardAgentVerification';

        for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
            const { result: response } = await this.observability.runLLMInSpan({
                spanName: `${SafeguardPipelineService.name}::${runName}::turn${turn}`,
                runName,
                attrs: {
                    organizationId: organizationAndTeamData?.organizationId,
                    prNumber,
                    turn,
                    suggestionId: suggestion.id,
                },
                exec: async (callbacks) => {
                    let builder = promptRunner
                        .builder()
                        .setParser(ParserType.STRING)
                        .setPayload({});
                    for (const msg of messages) {
                        builder = builder.addPrompt(msg);
                    }
                    return await builder
                        .setTemperature(0)
                        .addCallbacks(callbacks)
                        .setRunName(`${runName}_turn${turn}`)
                        .execute();
                },
            });

            const responseText = typeof response === 'string'
                ? response
                : JSON.stringify(response);

            const parsed = this.parseAgentResponse(responseText);

            if (!parsed) {
                // Invalid response — ask for valid JSON
                messages.push({ prompt: responseText, role: PromptRole.AI });
                messages.push({
                    prompt: 'Respond with valid JSON only. Either a tool call or a verdict.',
                    role: PromptRole.USER,
                });
                continue;
            }

            // Final verdict
            if ('verdict' in parsed) {
                // Reject "keep" verdicts on the first turn — the agent must
                // make at least one tool call to verify the code actually
                // contains the claimed defect before accepting a suggestion.
                if (turn === 0 && parsed.verdict === true) {
                    messages.push({ prompt: JSON.stringify(parsed), role: PromptRole.AI });
                    messages.push({
                        prompt: 'You must use at least one tool call to verify the defect exists in the actual code before giving a verdict. Search for the key symbol or read the file first.',
                        role: PromptRole.USER,
                    });
                    continue;
                }

                return {
                    verified: parsed.verdict,
                    action: parsed.action || (parsed.verdict ? 'no_changes' : 'discard'),
                    evidence: parsed.evidence || '',
                    turnsUsed: turn + 1,
                };
            }

            // Tool call — execute and feed result back
            let toolResult: string;
            try {
                if (parsed.tool === 'search') {
                    toolResult = await remoteCommands.grep(parsed.pattern || '', '.', undefined);
                    // Limit results to avoid blowing up context
                    const lines = toolResult.split('\n');
                    if (lines.length > 15) {
                        toolResult = lines.slice(0, 15).join('\n') + `\n... (${lines.length - 15} more matches)`;
                    }
                } else if (parsed.tool === 'read') {
                    toolResult = await remoteCommands.read(parsed.path || '', 0, 0);
                } else if (parsed.tool === 'list') {
                    toolResult = await remoteCommands.listDir(parsed.path || '.', 2);
                } else {
                    toolResult = `Unknown tool: ${parsed.tool}`;
                }
            } catch (toolError) {
                toolResult = `Tool error: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
            }

            messages.push({ prompt: JSON.stringify(parsed), role: PromptRole.AI });

            const remainingTurns = MAX_AGENT_TURNS - turn - 1;
            let followUp = `Tool result:\n${toolResult}`;
            if (remainingTurns <= 1) {
                followUp += `\n\nThis is your LAST tool call. You MUST respond with a verdict now.`;
            } else if (remainingTurns <= 2) {
                followUp += `\n\n${remainingTurns} tool call(s) remaining. Provide your verdict unless you need one critical search.`;
            }

            messages.push({
                prompt: followUp,
                role: PromptRole.USER,
            });
        }

        // Max turns reached — default to keep (assume defect is real)
        return {
            verified: true,
            action: 'no_changes',
            evidence: 'Max agent turns reached — defaulting to keep',
            turnsUsed: MAX_AGENT_TURNS,
        };
    }

    /**
     * Parse agent response text into a structured object.
     * Returns null if the response is not valid JSON.
     */
    private parseAgentResponse(text: string): any {
        if (!text?.trim()) return null;

        // Try direct parse
        try {
            return JSON.parse(text);
        } catch {}

        // Extract from markdown code blocks
        const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) {
            try {
                return JSON.parse(codeBlock[1].trim());
            } catch {}
        }

        // Extract outermost JSON object
        const objStart = text.indexOf('{');
        if (objStart === -1) return null;

        let json = text.substring(objStart);
        let depth = 0;
        let inStr = false;
        let escape = false;
        let end = -1;

        for (let i = 0; i < json.length; i++) {
            const c = json[i];
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') depth++;
            if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
        }

        if (end > 0) json = json.substring(0, end + 1);

        try {
            return JSON.parse(json);
        } catch {}

        // Clean trailing commas and try again
        const cleaned = json
            .replace(/,\s*([\]}])/g, '$1')
            .replace(/\/\/[^\n]*/g, '');

        try {
            return JSON.parse(cleaned);
        } catch {}

        return null;
    }

    /**
     * Build the user prompt with file context and suggestions.
     */
    private buildUserPrompt(context: {
        fileContent: string;
        relevantContent: string;
        patchWithLinesStr: string;
        filePath: string;
        suggestions: any[];
        crossFileSnippets?: CrossFileContextSnippet[];
        memories?: Array<Partial<{ title?: string; rule?: string }>>;
        externalReferences?: unknown[];
        externalReferenceErrors?: unknown[] | string;
    }): string {
        let crossFileBlock = '';
        if (context.crossFileSnippets?.length) {
            const snippetLines = context.crossFileSnippets.map(
                (s) =>
                    `#### ${s.filePath}${s.relatedSymbol ? ` (symbol: ${s.relatedSymbol})` : ''}\n**Rationale:** ${s.rationale}\n\`\`\`\n${s.content}\n\`\`\``,
            );
            crossFileBlock = `\n\n<codebaseContext>\n${SAFEGUARD_CROSS_FILE_CONTEXT_PREAMBLE}\n${snippetLines.join('\n\n')}\n</codebaseContext>`;
        }

        // Build external context blocks (memories, references, errors)
        const externalBlocks: string[] = [];

        const memoriesBlock = formatMemoriesSection(
            context.memories as Array<{ title?: string; rule?: string }>,
        );
        if (memoriesBlock) externalBlocks.push(memoriesBlock);

        const referencesBlock = formatReferenceSection(context.externalReferences);
        if (referencesBlock) externalBlocks.push(referencesBlock);

        const errorsBlock = formatSyncErrors(context.externalReferenceErrors);
        if (errorsBlock) externalBlocks.push(errorsBlock);

        let externalContextBlock = '';
        if (externalBlocks.length) {
            externalContextBlock = `\n\n<externalContext>\n## External Context & Injected Knowledge\n\nThe following information is provided to ground your analysis in the broader system reality. Use this as your source of truth.\n\n---\n\n${externalBlocks.join('\n\n---\n\n')}\n</externalContext>`;
        }

        return `
## Context

<fileContent>
    ${context.relevantContent || context.fileContent}
</fileContent>

<codeDiff>
    ${context.patchWithLinesStr}
</codeDiff>

<filePath>
    ${context.filePath}
</filePath>

<suggestionsContext>
${JSON.stringify(context?.suggestions) || 'No suggestions provided'}
</suggestionsContext>${crossFileBlock}${externalContextBlock}`;
    }
}

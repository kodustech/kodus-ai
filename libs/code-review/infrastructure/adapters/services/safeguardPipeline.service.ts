import { createLogger } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import {
    CreateSandboxParams,
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
    SandboxInstance,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import {
    TriageDecision,
    triageSuggestion,
} from '@libs/code-review/infrastructure/adapters/services/safeguardTriage.service';
import { DocumentationQueryPlanByFile } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import {
    SAFEGUARD_CROSS_FILE_CONTEXT_PREAMBLE,
    formatMemoriesSection,
    formatReferenceSection,
    formatSyncErrors,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguard';
import {
    STRUCTURAL_DEFECT_FEATURES,
    SafeguardFeatureExtractionResult,
    SafeguardFeatureSet,
    prompt_codeReviewSafeguard_featureExtraction,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguardFeatures';
import { prompt_codeReviewSafeguard_verification } from '@libs/common/utils/langchainCommon/prompts/codeReviewSafeguardVerification';
import { ReviewModeResponse } from '@libs/core/domain/enums/code-review.enum';
import {
    DocumentationContextItem,
    ISafeguardResponse,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';

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
    getFreshCloneParams?: () => Promise<CreateSandboxParams>;
    documentationContext?: DocumentationContextItem[];
}

const MAX_AGENT_TURNS = 6;

@Injectable()
export class SafeguardPipelineService {
    private readonly logger = createLogger(SafeguardPipelineService.name);

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observability: ObservabilityService,
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly documentationSearchExaService: DocumentationSearchExaService,
    ) {}

    async execute(
        params: SafeguardPipelineParams,
    ): Promise<ISafeguardResponse> {
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
            const featureResult = await this.extractFeatures(
                params,
                promptRunner,
            );
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
                return {
                    suggestions,
                    codeReviewModelUsed: { safeguard: provider },
                };
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
            const toVerify: Array<{
                suggestion: any;
                features: SafeguardFeatureSet;
            }> = [];
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
                this.logger.log({
                    message: `[SAFEGUARD_DECISION] PR#${prNumber} ${fileLabel} — using agent verification with sandbox`,
                    context: SafeguardPipelineService.name,
                    metadata: {
                        safeguardMode: 'agent_verification',
                        sandboxAvailable: true,
                        safeguardReason: 'remote_commands_available',
                        prNumber,
                        filePath: file?.filename,
                        toVerifyCount: toVerify.length,
                        hasFreshCloneParams: !!params.getFreshCloneParams,
                    },
                });

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

                let currentRemoteCommands = remoteCommands;
                let renewedCleanup: (() => Promise<void>) | undefined;

                const canRenew = !!(
                    params.getFreshCloneParams && this.sandboxProvider
                );
                this.logger.log({
                    message: `[SAFEGUARD] PR#${prNumber} ${fileLabel} — Agent verification starting: ${toVerify.length} suggestions to verify, sandbox renewal ${canRenew ? 'available' : 'NOT available'}${!params.getFreshCloneParams ? ' (no getFreshCloneParams)' : ''}${!this.sandboxProvider ? ' (no sandboxProvider)' : ''}`,
                    context: SafeguardPipelineService.name,
                });

                // Closure to attempt sandbox renewal; returns true on success
                const tryRenewSandbox = async (): Promise<boolean> => {
                    if (!params.getFreshCloneParams || !this.sandboxProvider) {
                        this.logger.warn({
                            message: `[SAFEGUARD] PR#${prNumber} ${fileLabel} — Cannot renew sandbox: ${!params.getFreshCloneParams ? 'getFreshCloneParams is missing' : 'sandboxProvider is missing'}`,
                            context: SafeguardPipelineService.name,
                        });
                        return false;
                    }
                    let newSandbox: SandboxInstance | undefined;
                    try {
                        const freshCloneParams =
                            await params.getFreshCloneParams();
                        newSandbox =
                            await this.sandboxProvider.createSandboxWithRepo(
                                freshCloneParams,
                            );
                        currentRemoteCommands = newSandbox.remoteCommands;
                        if (renewedCleanup)
                            await renewedCleanup().catch(() => {});
                        renewedCleanup = newSandbox.cleanup;
                        this.logger.log({
                            message: `Sandbox renewed for PR#${prNumber} ${fileLabel}`,
                            context: SafeguardPipelineService.name,
                        });
                        return true;
                    } catch (renewErr) {
                        this.logger.warn({
                            message: `Sandbox renewal failed for PR#${prNumber} ${fileLabel}, stopping agent verification`,
                            context: SafeguardPipelineService.name,
                            error: renewErr,
                        });
                        // Clean up the new sandbox if it was created but setup failed after
                        if (newSandbox?.cleanup) {
                            await newSandbox.cleanup().catch(() => {});
                        }
                        return false;
                    }
                };

                let stopLoop = false;

                for (const { suggestion, features } of toVerify) {
                    if (stopLoop) break;

                    const suggStart = Date.now();
                    let result:
                        | {
                              action: string;
                              evidence: string;
                              turnsUsed: number;
                          }
                        | undefined;
                    let sandboxError = false;

                    // First attempt
                    try {
                        result = await this.verifyWithAgent(
                            suggestion,
                            features,
                            currentRemoteCommands,
                            agentPromptRunner,
                            params.languageResultPrompt,
                            organizationAndTeamData,
                            prNumber,
                            params.memories,
                            params.documentationContext,
                            byokConfig,
                        );

                        if (
                            result.action !== 'no_changes' &&
                            this.isSandboxRelatedEvidence(result.evidence)
                        ) {
                            sandboxError = true;
                        }
                    } catch (error) {
                        sandboxError = this.isSandboxDeadError(error);
                        if (!sandboxError) {
                            // Non-sandbox error — discard and move on
                            this.logger.warn({
                                message: `Agent verification failed for suggestion ${suggestion.id}, discarding (safe default)`,
                                context: SafeguardPipelineService.name,
                                error,
                            });
                            agentDiscarded++;
                            continue;
                        }
                    }

                    // If sandbox died, renew and retry this same suggestion
                    if (sandboxError) {
                        this.logger.warn({
                            message: `[SAFEGUARD] Sandbox dead detected for suggestion ${suggestion.id} in PR#${prNumber} ${fileLabel}, attempting renewal | First attempt evidence: ${(result?.evidence || 'N/A (exception)').substring(0, 200)}`,
                            context: SafeguardPipelineService.name,
                        });

                        if (!(await tryRenewSandbox())) {
                            agentDiscarded++;
                            stopLoop = true;
                            continue;
                        }

                        // Retry with the renewed sandbox
                        try {
                            result = await this.verifyWithAgent(
                                suggestion,
                                features,
                                currentRemoteCommands,
                                agentPromptRunner,
                                params.languageResultPrompt,
                                organizationAndTeamData,
                                prNumber,
                                params.memories,
                                undefined,
                                byokConfig,
                            );
                        } catch (retryError) {
                            this.logger.warn({
                                message: `Agent verification retry failed for suggestion ${suggestion.id} after sandbox renewal, discarding`,
                                context: SafeguardPipelineService.name,
                                error: retryError,
                            });
                            agentDiscarded++;
                            // If retry also fails with sandbox error, stop entirely
                            if (this.isSandboxDeadError(retryError)) {
                                stopLoop = true;
                            }
                            continue;
                        }
                    }

                    // Process result
                    const suggMs = Date.now() - suggStart;
                    const wasRetry = sandboxError; // sandboxError means this result came from a retry

                    if (result.action === 'no_changes') {
                        if (features.improvedCode_is_correct === false) {
                            kept.push({
                                ...suggestion,
                                improvedCode: null,
                            });
                        } else {
                            kept.push(suggestion);
                        }
                        agentKept++;
                    } else {
                        agentDiscarded++;
                    }

                    this.logger.log({
                        message: `[TIMING] PR#${prNumber} ${fileLabel} — Agent verified suggestion ${suggestion.id}: ${result.action}${wasRetry ? ' (after sandbox renewal)' : ''} in ${(suggMs / 1000).toFixed(1)}s (${result.turnsUsed}/${MAX_AGENT_TURNS} turns) | Evidence: ${(result.evidence || '').substring(0, 120)}`,
                        context: SafeguardPipelineService.name,
                    });
                    totalTurns += result.turnsUsed;
                }

                // Cleanup renewed sandbox
                if (renewedCleanup) {
                    await renewedCleanup().catch(() => {});
                }

                const agentMs = Date.now() - agentStart;
                this.logger.log({
                    message: `[TIMING] PR#${prNumber} ${fileLabel} — Agent Verification: ${(agentMs / 1000).toFixed(1)}s (${toVerify.length} suggestions, ${agentKept} kept, ${agentDiscarded} discarded, ${totalTurns} total turns, avg ${(agentMs / toVerify.length / 1000).toFixed(1)}s each)`,
                    context: SafeguardPipelineService.name,
                });
            } else if (toVerify.length > 0 && !remoteCommands) {
                this.logger.log({
                    message: `[SAFEGUARD_DECISION] PR#${prNumber} ${fileLabel} — falling back to prompt-only verification`,
                    context: SafeguardPipelineService.name,
                    metadata: {
                        safeguardMode: 'prompt_only',
                        sandboxAvailable: false,
                        safeguardReason: 'no_remote_commands',
                        prNumber,
                        filePath: file?.filename,
                        toVerifyCount: toVerify.length,
                        hasFreshCloneParams: !!params.getFreshCloneParams,
                    },
                });

                // No sandbox available — fallback to prompt-only verification
                const fallbackStart = Date.now();
                let fallbackKept = 0;
                let fallbackDiscarded = 0;

                for (const { suggestion, features } of toVerify) {
                    try {
                        const result = await this.verifyWithPromptOnly(
                            suggestion,
                            features,
                            params,
                            promptRunner,
                        );

                        if (result.keep) {
                            if (features.improvedCode_is_correct === false) {
                                kept.push({
                                    ...suggestion,
                                    improvedCode: null,
                                });
                            } else {
                                kept.push(suggestion);
                            }
                            fallbackKept++;
                        } else {
                            fallbackDiscarded++;
                        }
                    } catch (error) {
                        this.logger.warn({
                            message: `Prompt-only verification failed for suggestion ${suggestion.id}, keeping (safe default)`,
                            context: SafeguardPipelineService.name,
                            error,
                        });
                        if (features.improvedCode_is_correct === false) {
                            kept.push({ ...suggestion, improvedCode: null });
                        } else {
                            kept.push(suggestion);
                        }
                        fallbackKept++;
                    }
                }

                const fallbackMs = Date.now() - fallbackStart;
                this.logger.log({
                    message: `[TIMING] PR#${prNumber} ${fileLabel} — Prompt-only Verification (no sandbox): ${(fallbackMs / 1000).toFixed(1)}s (${toVerify.length} suggestions, ${fallbackKept} kept, ${fallbackDiscarded} discarded)`,
                    context: SafeguardPipelineService.name,
                });
            }

            this.logger.log({
                message: `[TIMING] PR#${prNumber} ${fileLabel} — Pipeline Total: ${((Date.now() - pipelineStart) / 1000).toFixed(1)}s | Input: ${suggestions.length} suggestions → Output: ${kept.length} kept`,
                context: SafeguardPipelineService.name,
            });

            return {
                suggestions: kept,
                codeReviewModelUsed: {
                    safeguard: byokConfig?.main?.provider || provider,
                },
            };
        } catch (error) {
            this.logger.error({
                message: `Safeguard pipeline failed for PR#${prNumber} file ${file?.filename}, returning all suggestions (${((Date.now() - pipelineStart) / 1000).toFixed(1)}s)`,
                context: SafeguardPipelineService.name,
                error,
            });
            return {
                suggestions,
                codeReviewModelUsed: { safeguard: provider },
            };
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
            byokConfig,
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
            byokConfig,
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
     * Prompt-only fallback when no sandbox is available.
     * Single LLM call using only the context already in hand
     * (diff, file content, cross-file snippets).
     */
    private async verifyWithPromptOnly(
        suggestion: any,
        features: SafeguardFeatureSet,
        params: SafeguardPipelineParams,
        promptRunner: BYOKPromptRunnerService,
    ): Promise<{ keep: boolean; evidence: string }> {
        const claimedDefects = STRUCTURAL_DEFECT_FEATURES.filter(
            (f) => features[f],
        ).join(', ');

        const schema = z.object({
            verdict: z.boolean(),
            evidence: z.string(),
        });

        const systemPrompt = `You are a code review verification assistant. A suggestion was flagged as ambiguous by triage and needs a final decision.

You do NOT have access to the full codebase — only the diff, the file content, and any cross-file snippets provided below. Decide based ONLY on what you can see.

## Rules
- If the defect is clearly visible in the provided context → verdict: true (keep)
- If the defect requires seeing code NOT shown here to confirm → verdict: false (discard — insufficient evidence)
- If the suggestion is speculative ("what if...") without proof in the visible code → verdict: false
- Default to false (discard) when uncertain — reducing noise is more important than catching every edge case

## Suggestion Under Review
**File**: ${suggestion.filePath || params.file?.filename || 'unknown'}
**Claimed defect**: ${claimedDefects}
**Suggestion**: ${suggestion.suggestionContent || ''}
**Code in question**:
\`\`\`
${suggestion.existingCode || ''}
\`\`\`

Respond with JSON only: {"verdict": true/false, "evidence": "brief reason"}
Evidence field in ${params.languageResultPrompt}.`;

        const userPrompt = this.buildUserPrompt({
            fileContent: params.file?.fileContent,
            relevantContent: params.relevantContent,
            patchWithLinesStr: params.codeDiff,
            filePath: params.file?.filename,
            suggestions: [suggestion],
            crossFileSnippets: params.crossFileSnippets,
            memories: params.memories,
            externalReferences: params.externalReferences,
            externalReferenceErrors: params.externalReferenceErrors,
        });

        const runName = 'safeguardPromptOnlyVerification';

        const { result } = await this.observability.runLLMInSpan({
            spanName: `${SafeguardPipelineService.name}::${runName}`,
            runName,
            attrs: {
                organizationId: params.organizationAndTeamData?.organizationId,
                prNumber: params.prNumber,
                suggestionId: suggestion.id,
                safeguardMode: 'prompt_only',
                sandboxAvailable: false,
                sandboxReason: 'no_remote_commands',
            },
            byokConfig: params.byokConfig,
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
                        organizationId:
                            params.organizationAndTeamData?.organizationId,
                        teamId: params.organizationAndTeamData?.teamId,
                        pullRequestId: params.prNumber,
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
            // Parse failed — keep suggestion (safe default)
            return {
                keep: true,
                evidence: 'prompt-only parse failed, keeping as safe default',
            };
        }

        return { keep: parsed.data.verdict, evidence: parsed.data.evidence };
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
        documentationContext?: DocumentationContextItem[],
        byokConfig?: BYOKConfig,
    ): Promise<{
        verified: boolean;
        action: string;
        evidence: string;
        turnsUsed: number;
    }> {
        const claimedDefects = STRUCTURAL_DEFECT_FEATURES.filter(
            (f) => features[f],
        ).join(', ');

        const systemPrompt = prompt_codeReviewSafeguard_verification({
            suggestionContent: suggestion.suggestionContent || '',
            claimedDefectType: claimedDefects,
            existingCode: suggestion.existingCode || '',
            filePath: suggestion.filePath || '',
            languageResultPrompt,
        });

        // Build initial user message with optional memory rules context
        let userMessage =
            'Verify the suggestion. Begin by searching for the key symbol or reading the file.';
        const memoriesBlock = formatMemoriesSection(
            memories as Array<{ title?: string; rule?: string }>,
        );
        if (memoriesBlock) {
            userMessage += `\n\n${memoriesBlock}\n\nConsider these team rules when evaluating the suggestion — if it contradicts a rule, lean towards discarding.`;
        }

        const documentationBlock =
            this.buildDocumentationContextBlock(documentationContext);
        if (documentationBlock) {
            userMessage += `\n\n${documentationBlock}`;
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
                    safeguardMode: 'agent_verification',
                    sandboxAvailable: true,
                    sandboxReason: 'remote_commands_available',
                },
                byokConfig,
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
                        .addMetadata({
                            organizationId:
                                organizationAndTeamData?.organizationId,
                            teamId: organizationAndTeamData?.teamId,
                            pullRequestId: prNumber,
                            runName,
                        })
                        .setRunName(`${runName}_turn${turn}`)
                        .execute();
                },
            });

            const responseText =
                typeof response === 'string'
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
                    messages.push({
                        prompt: JSON.stringify(parsed),
                        role: PromptRole.AI,
                    });
                    messages.push({
                        prompt: 'You must use at least one tool call to verify the defect exists in the actual code before giving a verdict. Search for the key symbol or read the file first.',
                        role: PromptRole.USER,
                    });
                    continue;
                }

                return {
                    verified: parsed.verdict,
                    action:
                        parsed.action ||
                        (parsed.verdict ? 'no_changes' : 'discard'),
                    evidence: parsed.evidence || '',
                    turnsUsed: turn + 1,
                };
            }

            // Tool call — execute and feed result back
            let toolResult: string;
            try {
                if (parsed.tool === 'search') {
                    toolResult = await remoteCommands.grep(
                        parsed.pattern || '',
                        '.',
                        undefined,
                    );
                    // Limit results to avoid blowing up context
                    const lines = toolResult.split('\n');
                    if (lines.length > 15) {
                        toolResult =
                            lines.slice(0, 15).join('\n') +
                            `\n... (${lines.length - 15} more matches)`;
                    }
                } else if (parsed.tool === 'read') {
                    toolResult = await remoteCommands.read(
                        parsed.path || '',
                        0,
                        0,
                    );
                    const MAX_READ_LENGTH = 20000;
                    if (toolResult.length > MAX_READ_LENGTH) {
                        toolResult =
                            toolResult.substring(0, MAX_READ_LENGTH) +
                            `\n... (file truncated)`;
                    }
                } else if (parsed.tool === 'list') {
                    toolResult = await remoteCommands.listDir(
                        parsed.path || '.',
                        2,
                    );
                    const MAX_LIST_LENGTH = 10000;
                    if (toolResult.length > MAX_LIST_LENGTH) {
                        toolResult =
                            toolResult.substring(0, MAX_LIST_LENGTH) +
                            `\n... (listing truncated)`;
                    }
                } else if (parsed.tool === 'documentation') {
                    toolResult = await this.getDocumentationToolResult(
                        parsed.packageName || '',
                        parsed.query || suggestion?.suggestionContent || '',
                        documentationContext,
                    );
                } else {
                    toolResult = `Unknown tool: ${parsed.tool}`;
                }
            } catch (toolError) {
                toolResult = `Tool error: ${toolError instanceof Error ? toolError.message : String(toolError)}`;
            }

            this.logger.log({
                message: `[AGENT-TOOL] PR#${prNumber} ${suggestion.id} turn=${turn} tool=${parsed.tool} path=${parsed.path || parsed.pattern || ''} resultLength=${toolResult.length}${toolResult.startsWith('Tool error') ? ` error=${toolResult.substring(0, 150)}` : ''}`,
                context: SafeguardPipelineService.name,
            });

            messages.push({
                prompt: JSON.stringify(parsed),
                role: PromptRole.AI,
            });

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
        } catch {
            // intentional fallback
        }

        // Extract from markdown code blocks
        const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (codeBlock) {
            try {
                return JSON.parse(codeBlock[1].trim());
            } catch {
                // intentional fallback
            }
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
            if (escape) {
                escape = false;
                continue;
            }
            if (c === '\\') {
                escape = true;
                continue;
            }
            if (c === '"') {
                inStr = !inStr;
                continue;
            }
            if (inStr) continue;
            if (c === '{') depth++;
            if (c === '}') {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }

        if (end > 0) json = json.substring(0, end + 1);

        try {
            return JSON.parse(json);
        } catch {
            // intentional fallback
        }

        // Clean trailing commas and try again
        const cleaned = json
            .replace(/,\s*([\]}])/g, '$1')
            .replace(/\/\/[^\n]*/g, '');

        try {
            return JSON.parse(cleaned);
        } catch {
            // intentional fallback
        }

        return null;
    }

    private buildDocumentationContextBlock(
        documentationContext?: DocumentationContextItem[],
    ): string {
        if (!documentationContext?.length) {
            return '';
        }

        const excerpts = documentationContext
            .map(
                (item, index) =>
                    `${index + 1}. ${item.title || 'Documentation'} (${item.url || 'unknown'})\nQuery: ${item.query}\nSnippet: ${item.snippet || ''}`,
            )
            .join('\n\n');

        return `## Available Documentation Context\nUse this context first before requesting more docs with the documentation tool.\n\n${excerpts}`;
    }

    private async getDocumentationToolResult(
        packageName: string,
        query: string,
        fallbackContext?: DocumentationContextItem[],
    ): Promise<string> {
        const normalizedQuery = (query || '').trim();
        const normalizedPackageName = (packageName || '').trim();

        if (!normalizedQuery) {
            return 'Documentation tool error: query is required.';
        }

        const localMatch = (fallbackContext || []).find(
            (item) =>
                item.query
                    ?.toLowerCase()
                    .includes(normalizedQuery.toLowerCase()) ||
                item.title
                    ?.toLowerCase()
                    .includes(normalizedPackageName.toLowerCase()),
        );

        if (localMatch) {
            return `Documentation (preloaded):\nTitle: ${localMatch.title}\nURL: ${localMatch.url}\nSnippet: ${localMatch.snippet}`;
        }

        const packageForPlan = normalizedPackageName || 'framework';

        const planByFile: Record<string, DocumentationQueryPlanByFile> = {
            safeguard: {
                queryTasks: [
                    {
                        packageName: packageForPlan,
                        query: normalizedQuery,
                    },
                ],
            },
        };

        const results =
            await this.documentationSearchExaService.searchByFilePlan(
                planByFile,
            );
        const docs = results.safeguard || [];

        if (!docs.length) {
            return `Documentation lookup returned no results for package "${packageForPlan}" and query "${normalizedQuery}".`;
        }

        const doc = docs[0];

        return `Documentation:\nTitle: ${doc.title}\nURL: ${doc.url}\nQuery: ${doc.query}\nSnippet: ${doc.snippet}`;
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

        const referencesBlock = formatReferenceSection(
            context.externalReferences,
        );
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

    /**
     * Detect if an error indicates the sandbox is no longer running.
     */
    private isSandboxDeadError(error: unknown): boolean {
        const msg = error instanceof Error ? error.message : String(error);
        return (
            /sandbox/i.test(msg) ||
            msg.includes('ECONNREFUSED') ||
            msg.includes('not running')
        );
    }

    /**
     * Detect if the agent's discard evidence suggests the sandbox was dead
     * (e.g. all tool calls returned "Sandbox is probably not running").
     */
    private isSandboxRelatedEvidence(evidence?: string): boolean {
        if (!evidence) return false;
        const lower = evidence.toLowerCase();
        return (
            lower.includes('sandbox') ||
            lower.includes('not running') ||
            lower.includes('econnrefused')
        );
    }
}

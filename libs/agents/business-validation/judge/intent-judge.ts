import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import { finalText } from '@libs/agent-harness/domain/run-state.util';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { createLogger } from '@libs/core/log/logger';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import type { NormalizedModel } from '@libs/llm/byok-config';

import type { Task } from '../business-validation.types';
import { buildBusinessRulesAnalysisPrompt } from './analysis-prompt.builder';
import {
    applyBusinessRulesVerdict,
    BusinessRulesVerifier,
    shouldVerifyValidationResult,
} from './business-rules-verifier';
import { parseBusinessRulesValidationResult } from './validation-result.parser';
import type { TaskQuality, ValidationResult } from './validation.types';
import {
    deriveStatus,
    readValidationArtifact,
    submitValidationTool,
    VALIDATION_RESULT_TOOL,
} from './validation-verdict';

const DEFAULT_LANGUAGE = 'en-US';
const PARSER_FALLBACK_FRAGMENT = 'error parsing validation result';
const MAX_OUTPUT_TOKENS = 20_000;
/** Verify passes per validation; requirements past this keep the analyzer's state. */
const MAX_VERIFIED_CLAIMS = 8;

export interface JudgePolicy {
    analyzerTimeoutMs: number;
    analyzerMaxIterations: number;
    verifyAnalyzerResult?: boolean;
}

export interface JudgeInput {
    /** SKILL.md and its references, plus the team's custom instructions. */
    instructions: string;
    task: Task;
    taskText: string;
    taskQuality: TaskQuality;
    diff: string;
    /** Changed files left out of `diff` because it was over budget. */
    unseenFiles?: string[];
    pullRequestBody?: string;
    userLanguage: string;
}

export interface JudgeTelemetry {
    organizationId?: string;
    teamId?: string;
    pullRequestId?: number;
    repositoryId?: string;
}

type Message = { role: 'system' | 'user'; content: string };

export type ModelErrorReporter = (input: {
    organizationId?: string;
    provider: string;
    errorMessage: string;
}) => void;

/**
 * Compares the code with the task and returns a structured verdict. Runs on
 * the agent harness: the analyzer submits its result through a result tool,
 * an optional verifier refutes over-flagged gaps, and a formatter rewrites
 * user-facing text in the team's language.
 */
export class IntentJudge {
    private readonly logger = createLogger(IntentJudge.name);

    constructor(
        private readonly model: NormalizedModel | undefined,
        private readonly policy: JudgePolicy,
        private readonly telemetry: JudgeTelemetry,
        private readonly onModelError?: ModelErrorReporter,
    ) {}

    /** The model this judge runs on, for helpers that run on the same one. */
    get modelSlot(): NormalizedModel | undefined {
        return this.model;
    }

    async judge(input: JudgeInput): Promise<ValidationResult> {
        const prompt = buildBusinessRulesAnalysisPrompt(input);
        const result = await this.analyzeWithRetries(
            input.instructions,
            prompt,
        );
        const verified = await this.maybeVerify(result, input);
        return {
            ...verified,
            mode:
                verified.mode ??
                (verified.needsMoreInfo
                    ? 'limitation_response'
                    : 'full_analysis'),
            reason:
                verified.reason ??
                (verified.needsMoreInfo ? undefined : 'analysis_ready'),
            taskContextStatus: verified.taskContextStatus ?? 'usable',
            prDiffStatus: verified.prDiffStatus ?? 'usable',
            confidence:
                verified.confidence ??
                (verified.needsMoreInfo ? 'low' : 'medium'),
        };
    }

    /** `message` in the team's language; English is returned as is. */
    async translate(message: string, userLanguage: string): Promise<string> {
        if (
            !message.trim() ||
            userLanguage.trim().toLowerCase() === DEFAULT_LANGUAGE.toLowerCase()
        ) {
            return message;
        }
        try {
            const { content } = await this.complete(
                [
                    {
                        role: 'system',
                        content:
                            'Rewrite the provided markdown for the end user in the requested USER LANGUAGE. Preserve markdown structure, tables, HTML tags, code spans, links, @mentions and bullet lists. Keep the uppercase state labels (MET, PARTIAL, MISSING, CHECK MANUALLY, NOT IN TASK, ACCEPTED) as they are. Preserve quoted requirement text exactly when it is explicitly quoted from task context. Do not add new information. Answer with the rewritten markdown only.',
                    },
                    {
                        role: 'user',
                        content: `USER LANGUAGE: ${userLanguage}\n\nMESSAGE:\n${message}`,
                    },
                ],
                // Room for the whole message: a requirement table runs long.
                {
                    maxTokens: Math.min(
                        8000,
                        Math.max(1200, Math.ceil(message.length / 2)),
                    ),
                },
                'businessRulesUserFacingFormatter',
            );
            return content.trim() ? content.trim() : message;
        } catch {
            return message;
        }
    }

    private async analyzeWithRetries(
        instructions: string,
        prompt: string,
    ): Promise<ValidationResult> {
        const attempts = Math.max(1, this.policy.analyzerMaxIterations);
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const result = await this.withTimeout(
                    this.complete(
                        [
                            { role: 'system', content: instructions },
                            { role: 'user', content: prompt },
                        ],
                        {
                            maxTokens: MAX_OUTPUT_TOKENS,
                            submitResultTool: true,
                        },
                        'businessRulesAnalyzer',
                    ),
                    this.policy.analyzerTimeoutMs,
                );
                // The result tool is the contract; text is the fallback for a
                // model that answered without calling it.
                const parsed = parseBusinessRulesValidationResult(
                    result.structured ?? result.content,
                );
                if (!isParserFallback(parsed) || attempt === attempts) {
                    return parsed;
                }
            } catch (error) {
                lastError = error;
            }
        }
        return {
            needsMoreInfo: true,
            mode: 'limitation_response',
            reason: 'analyzer_failure',
            confidence: 'low',
            missingInfo:
                lastError instanceof Error
                    ? `Analyzer execution failed: ${lastError.message}`
                    : 'Analyzer execution failed.',
            summary:
                '❌ **Error processing validation**\n\nAn error occurred while processing the system response. Please try again.',
        };
    }

    /**
     * Independent verify pass (doer≠checker): an LLM verifier refutes the
     * analyzer's claimed violation; a refuted claim is dropped. Opt-in through
     * SKILL.md and fail-open: an error keeps the analyzer's result.
     */
    private async maybeVerify(
        result: ValidationResult,
        input: JudgeInput,
    ): Promise<ValidationResult> {
        if (!shouldVerifyValidationResult(result, this.policy)) {
            return result;
        }
        try {
            const verifier = new BusinessRulesVerifier(this.runner(), {
                modelId: 'resolved',
                agentName: 'BusinessRulesValidation',
                phase: 'businessRulesVerify',
                runName: 'businessRulesVerify',
                spanName: 'BusinessRulesValidation::businessRulesVerify',
                diff: input.diff,
                taskContext: input.taskText,
                userLanguage: input.userLanguage,
                telemetryMetadata: {
                    organizationId: this.telemetry.organizationId,
                    teamId: this.telemetry.teamId,
                    provider: this.model?.provider,
                },
            });
            const verifyOne = async (claim: ValidationResult) => {
                const { ctx, cleanup } = createAgentRunContext({
                    runId: 'business-rules:verify',
                    timeoutMs: this.policy.analyzerTimeoutMs,
                });
                try {
                    return await verifier.verify(claim, ctx);
                } finally {
                    cleanup();
                }
            };
            if (!result.requirements) {
                return applyBusinessRulesVerdict(
                    result,
                    await verifyOne(result),
                );
            }
            // One claim per requirement: a refuted gap becomes MET, the rest stand.
            const requirements = await Promise.all(
                result.requirements.map(async (requirement, index) => {
                    if (
                        index >= MAX_VERIFIED_CLAIMS ||
                        (requirement.state !== 'missing' &&
                            requirement.state !== 'partial')
                    ) {
                        return requirement;
                    }
                    const verdict = await verifyOne({
                        ...result,
                        summary: [
                            `Requirement: "${requirement.requirement}"`,
                            `Claimed: ${requirement.state}`,
                            requirement.note
                                ? `Analyzer note: ${requirement.note}`
                                : '',
                        ]
                            .filter(Boolean)
                            .join('\n'),
                    }).catch(
                        () =>
                            ({ keep: true }) as {
                                keep: boolean;
                                rationale?: string;
                            },
                    );
                    return verdict.keep
                        ? requirement
                        : {
                              ...requirement,
                              state: 'met' as const,
                              note:
                                  verdict.rationale?.trim() || requirement.note,
                              action: undefined,
                          };
                }),
            );
            return {
                ...result,
                requirements,
                ...deriveStatus({ ...result, requirements }),
            };
        } catch (error) {
            this.logger.warn({
                message: `business-rules verify pass failed; keeping analyzer result: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                context: IntentJudge.name,
                metadata: this.telemetry,
            });
            return result;
        }
    }

    private runner(): AiSdkAgentRunner {
        return new AiSdkAgentRunner(this.model, {
            organizationId: this.telemetry.organizationId,
            provider: this.model?.provider,
            reporter: this.onModelError,
        });
    }

    /** One completion on the harness: no tools, or just the result tool. */
    private async complete(
        messages: Message[],
        options: { maxTokens?: number; submitResultTool?: boolean },
        phase: string,
    ): Promise<{ content: string; structured?: unknown }> {
        const system = messages.find((m) => m.role === 'system')?.content;
        const user = messages.filter((m) => m.role !== 'system');
        const spec: AgentSpec = {
            id: 'business-rules-analyzer',
            agentName: 'BusinessRulesValidation',
            phase,
            runName: phase,
            spanName: `BusinessRulesValidation::${phase}`,
            systemPrompt: system ?? '',
            tools: new InMemoryToolRegistry(
                options.submitResultTool ? [submitValidationTool] : [],
            ),
            ...(options.submitResultTool
                ? { resultToolName: VALIDATION_RESULT_TOOL }
                : {}),
            policies: [],
            maxSteps: 1,
            ...(options.maxTokens
                ? { maxOutputTokens: options.maxTokens }
                : {}),
        };
        const last = user[user.length - 1];
        const seedMessages = user
            .slice(0, -1)
            .map((m) => ({ role: 'user' as const, content: m.content }));

        const { ctx, cleanup } = createAgentRunContext({
            runId: `business-rules:${phase}`,
        });
        try {
            const state = await this.runner().run(
                spec,
                {
                    prompt: last?.content ?? '',
                    ...(seedMessages.length ? { seedMessages } : {}),
                    telemetryMetadata: {
                        ...this.telemetry,
                        provider: this.model?.provider,
                    },
                },
                ctx,
            );
            return {
                content: finalText(state),
                structured: options.submitResultTool
                    ? readValidationArtifact(state)
                    : undefined,
            };
        } finally {
            cleanup();
        }
    }

    private async withTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
    ): Promise<T> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `Timeout after ${timeoutMs}ms in business-rules analyzer`,
                        ),
                    ),
                timeoutMs,
            );
        });
        try {
            return await Promise.race([promise, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }
}

function isParserFallback(result: ValidationResult): boolean {
    if (!result.needsMoreInfo) {
        return false;
    }
    return (
        result.reason === 'parser_fallback' ||
        (result.missingInfo ?? '')
            .toLowerCase()
            .includes(PARSER_FALLBACK_FRAGMENT)
    );
}

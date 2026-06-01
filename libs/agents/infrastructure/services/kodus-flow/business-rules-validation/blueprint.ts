import { z } from 'zod';

import {
    CapabilityExecutionTrace,
    CapabilityExecutionHooks,
    SkillCapabilityRuntimeConfig,
    ToolCaller,
} from '@libs/agents/skills/runtime/skill-runtime.types';
import { asRecord } from '@libs/agents/skills/runtime/value-utils';
import { BlueprintStep } from '@libs/shared/blueprint/blueprint.types';



import { BusinessRulesContext } from './types';
import {
    buildBusinessLogicEligibility,
    getPullRequestDiffMissingInfoMessage,
    getTaskContextMissingInfoMessage,
} from './task-quality.rules';
import {
    SKILL_NAME,
    classifyTaskQualityFromSources,
    createBusinessRulesBlueprintTooling,
    resolvePullRequestDescription,
    resolveTaskContext,
} from './blueprint.tooling';

const baseContextSchema = z.looseObject({
    organizationAndTeamData: z.looseObject({
        organizationId: z.string().min(1),
        teamId: z.string().min(1),
    }),
    userLanguage: z.string().min(1),
});

const hasPrBodySchema = z.looseObject({
    prBody: z.string(),
});

const hasPrDiffSchema = z.looseObject({
    prDiff: z.string(),
});

const hasTaskContextSchema = z.looseObject({
    taskContext: z.string(),
});

const taskQualitySchema = z.enum(['EMPTY', 'MINIMAL', 'PARTIAL', 'COMPLETE']);

const hasTaskQualitySchema = z.looseObject({
    taskQuality: taskQualitySchema,
});

const validateTaskContextInputSchema = z.looseObject({
    taskQuality: taskQualitySchema,
});

const validateContextInputSchema = z.looseObject({
    taskQuality: taskQualitySchema,
    prDiff: z.string(),
});

const analyzeBusinessRulesInputSchema = z.looseObject({
    taskQuality: taskQualitySchema,
    prDiff: z.string().trim().min(1),
});

const validationResultPayloadSchema = z.looseObject({
    needsMoreInfo: z.boolean(),
    missingInfo: z.string().optional(),
    summary: z.string(),
    mode: z.enum(['full_analysis', 'limitation_response']).optional(),
    reason: z
        .enum([
            'analysis_ready',
            'task_context_missing',
            'task_context_weak',
            'pr_diff_missing',
            'analyzer_failure',
            'parser_fallback',
        ])
        .optional(),
    taskContextStatus: z.enum(['missing', 'weak', 'usable']).optional(),
    prDiffStatus: z.enum(['missing', 'usable']).optional(),
    confidence: z.enum(['low', 'medium', 'high']).optional(),
});

const analysisEligibilitySchema = z.looseObject({
    analysisEligibility: z.looseObject({
        mode: z.enum(['full_analysis', 'limitation_response']),
        reason: z.enum([
            'analysis_ready',
            'task_context_missing',
            'task_context_weak',
            'pr_diff_missing',
            'analyzer_failure',
            'parser_fallback',
        ]),
        taskContextStatus: z.enum(['missing', 'weak', 'usable']),
        prDiffStatus: z.enum(['missing', 'usable']),
    }),
});

const baseValidationResultSchema = z.looseObject({
    validationResult: validationResultPayloadSchema,
    formattedResponse: z.string(),
});

/**
 * Business Rules Validation Blueprint — factory function.
 *
 * Keeps skill orchestration declarative while shared runtime modules
 * handle capability resolution, deterministic MCP execution and payload parsing.
 */
export function createBusinessRulesBlueprint(
    fetcher: ToolCaller,
    capabilityRuntime: SkillCapabilityRuntimeConfig,
    hooks?: CapabilityExecutionHooks<BusinessRulesContext>,
): BlueprintStep<BusinessRulesContext>[] {
    const requiredInputPaths =
        capabilityRuntime.contracts?.input?.requiredContextFields;
    const requiredOutputPaths = normalizeOutputRequiredPaths(
        capabilityRuntime.contracts?.output?.requiredFields,
    );

    const taskContextInputSchema = withRequiredPaths(
        baseContextSchema,
        requiredInputPaths,
    );
    const hasValidationResultSchema = withRequiredPaths(
        baseValidationResultSchema,
        requiredOutputPaths,
    );
    const gateOutputSchema = z.union([
        hasTaskQualitySchema.and(analysisEligibilitySchema),
        hasTaskQualitySchema
            .and(analysisEligibilitySchema)
            .and(hasValidationResultSchema),
    ]);

    const tooling = createBusinessRulesBlueprintTooling(
        fetcher,
        capabilityRuntime,
        hooks,
    );

    return [
        {
            type: 'deterministic',
            name: 'fetchPullRequestMetadata',
            contract: {
                input: taskContextInputSchema,
                output: hasPrBodySchema,
            },
            fn: async (ctx): Promise<BusinessRulesContext> => {
                const cachedPrBody = resolvePullRequestDescription(ctx);
                const pullRequestNumber =
                    ctx.prepareContext?.pullRequest?.pullRequestNumber ??
                    ctx.prepareContext?.pullRequestNumber;
                if (cachedPrBody.trim().length > 0) {
                    return {
                        ...ctx,
                        prBody: cachedPrBody,
                    };
                }
                if (typeof pullRequestNumber !== 'number') {
                    return {
                        ...ctx,
                        prBody: cachedPrBody,
                    };
                }

                const metadata = await tooling.fetchPullRequestBody(ctx);
                const prBody = metadata.value ?? cachedPrBody;

                return {
                    ...ctx,
                    prBody,
                    capabilityExecutionTrace: appendCapabilityTraces(
                        ctx,
                        metadata.traces,
                    ),
                };
            },
        },
        {
            type: 'deterministic',
            name: 'fetchTaskContextFromMcp',
            contract: {
                input: taskContextInputSchema,
                output: hasTaskContextSchema,
            },
            fn: async (ctx): Promise<BusinessRulesContext> => {
                const fallbackTaskContext = resolveTaskContext(ctx);
                if (fallbackTaskContext.trim().length > 0) {
                    return {
                        ...ctx,
                        taskContext: fallbackTaskContext,
                    };
                }

                const fetched = await tooling.fetchTaskContext(ctx);
                const taskContext =
                    fetched.value &&
                    (fetched.value.title || fetched.value.description)
                        ? formatNormalizedTaskContext(fetched.value)
                        : fallbackTaskContext;

                return {
                    ...ctx,
                    taskContext,
                    taskContextNormalized: fetched.value,
                    capabilityExecutionTrace: appendCapabilityTraces(
                        ctx,
                        fetched.traces,
                    ),
                };
            },
        },
        {
            type: 'deterministic',
            name: 'classifyTaskContext',
            contract: {
                input: hasTaskContextSchema,
                output: hasTaskQualitySchema.and(analysisEligibilitySchema),
            },
            fn: async (ctx): Promise<BusinessRulesContext> => {
                const taskQuality = classifyTaskQualityFromSources({
                    taskContext: ctx.taskContext,
                    taskContextNormalized: ctx.taskContextNormalized,
                });
                const eligibility = buildBusinessLogicEligibility({
                    taskQuality,
                    taskContext: ctx.taskContext,
                    taskContextNormalized: ctx.taskContextNormalized,
                    prDiff: ctx.prDiff,
                });

                return {
                    ...ctx,
                    taskQuality,
                    analysisEligibility: eligibility,
                };
            },
        },
        {
            type: 'gate',
            name: 'validateTaskContext',
            contract: {
                input: validateTaskContextInputSchema,
                output: gateOutputSchema,
            },
            condition: (ctx) => {
                const eligibility =
                    ctx.analysisEligibility ??
                    buildBusinessLogicEligibility({
                        taskQuality: ctx.taskQuality,
                        taskContext: ctx.taskContext,
                        taskContextNormalized: ctx.taskContextNormalized,
                        prDiff: ctx.prDiff,
                    });
                return eligibility.taskContextStatus === 'usable';
            },
            onFail: (ctx): BusinessRulesContext => {
                const analysisEligibility =
                    ctx.analysisEligibility ??
                    buildBusinessLogicEligibility({
                        taskQuality: ctx.taskQuality,
                        taskContext: ctx.taskContext,
                        taskContextNormalized: ctx.taskContextNormalized,
                        prDiff: ctx.prDiff,
                    });
                const missingInfo = getTaskContextMissingInfoMessage(
                    ctx.taskQuality,
                );
                return {
                    ...ctx,
                    analysisEligibility,
                    validationResult: {
                        needsMoreInfo: true,
                        mode: 'limitation_response',
                        reason: analysisEligibility.reason,
                        taskContextStatus:
                            analysisEligibility.taskContextStatus,
                        prDiffStatus: analysisEligibility.prDiffStatus,
                        confidence: 'low',
                        missingInfo,
                        summary: missingInfo,
                    },
                };
            },
        },
        {
            type: 'deterministic',
            name: 'fetchPullRequestDiff',
            contract: {
                input: taskContextInputSchema,
                output: hasPrDiffSchema,
            },
            fn: async (ctx): Promise<BusinessRulesContext> => {
                const preloadedPrDiff = readPrepareContextPrDiff(ctx);
                if (preloadedPrDiff) {
                    return {
                        ...ctx,
                        prDiff: preloadedPrDiff,
                        analysisEligibility:
                            ctx.taskQuality !== undefined
                                ? buildBusinessLogicEligibility({
                                      taskQuality: ctx.taskQuality,
                                      taskContext: ctx.taskContext,
                                      taskContextNormalized:
                                          ctx.taskContextNormalized,
                                      prDiff: preloadedPrDiff,
                                  })
                                : ctx.analysisEligibility,
                    };
                }

                const diff = await tooling.fetchPullRequestDiff(ctx);
                return {
                    ...ctx,
                    prDiff: diff.value,
                    analysisEligibility:
                        ctx.taskQuality !== undefined
                            ? buildBusinessLogicEligibility({
                                  taskQuality: ctx.taskQuality,
                                  taskContext: ctx.taskContext,
                                  taskContextNormalized:
                                      ctx.taskContextNormalized,
                                  prDiff: diff.value,
                              })
                            : ctx.analysisEligibility,
                    capabilityExecutionTrace: appendCapabilityTraces(
                        ctx,
                        diff.traces,
                    ),
                };
            },
        },
        {
            type: 'gate',
            name: 'validatePullRequestDiff',
            contract: {
                input: validateContextInputSchema,
                output: gateOutputSchema,
            },
            condition: (ctx) =>
                (
                    ctx.analysisEligibility ??
                    buildBusinessLogicEligibility({
                        taskQuality: ctx.taskQuality,
                        taskContext: ctx.taskContext,
                        taskContextNormalized: ctx.taskContextNormalized,
                        prDiff: ctx.prDiff,
                    })
                ).mode === 'full_analysis',
            onFail: (ctx): BusinessRulesContext => {
                const analysisEligibility =
                    ctx.analysisEligibility ??
                    buildBusinessLogicEligibility({
                        taskQuality: ctx.taskQuality,
                        taskContext: ctx.taskContext,
                        taskContextNormalized: ctx.taskContextNormalized,
                        prDiff: ctx.prDiff,
                    });
                const missingInfo = getPullRequestDiffMissingInfoMessage();
                return {
                    ...ctx,
                    analysisEligibility,
                    validationResult: {
                        needsMoreInfo: true,
                        mode: 'limitation_response',
                        reason: analysisEligibility.reason,
                        taskContextStatus:
                            analysisEligibility.taskContextStatus,
                        prDiffStatus: analysisEligibility.prDiffStatus,
                        confidence: 'low',
                        missingInfo,
                        summary: missingInfo,
                    },
                };
            },
        },
        {
            type: 'llm',
            name: 'analyzeBusinessRules',
            contract: {
                input: analyzeBusinessRulesInputSchema,
                output: hasValidationResultSchema,
            },
            skill: SKILL_NAME,
            agentName: `kodus-${SKILL_NAME}-analyzer`,
        },
    ];
}

function normalizeOutputRequiredPaths(
    requiredFields: string[] | undefined,
): string[] | undefined {
    if (!requiredFields?.length) {
        return requiredFields;
    }

    return requiredFields.map((field) =>
        field.includes('.') ? field : `validationResult.${field}`,
    );
}

function withRequiredPaths<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    requiredPaths: string[] | undefined,
): TSchema {
    if (!requiredPaths?.length) {
        return schema;
    }

    const normalizedPaths = requiredPaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
    if (!normalizedPaths.length) {
        return schema;
    }

    return schema.superRefine((value, refinementCtx) => {
        const source = asRecord(value);
        for (const path of normalizedPaths) {
            if (readDotPath(source, path) !== undefined) {
                continue;
            }

            refinementCtx.addIssue({
                code: 'custom',
                path: path.split('.').filter((segment) => segment.length > 0),
                message: 'Required by skill contract',
            });
        }
    }) as TSchema;
}

function readDotPath(input: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
        if (!acc || typeof acc !== 'object') {
            return undefined;
        }

        return (acc as Record<string, unknown>)[key];
    }, input);
}

function appendCapabilityTraces(
    ctx: BusinessRulesContext,
    traces: CapabilityExecutionTrace[],
): CapabilityExecutionTrace[] {
    return [...(ctx.capabilityExecutionTrace ?? []), ...traces];
}

function readPrepareContextPrDiff(ctx: BusinessRulesContext): string {
    const preloadedDiff = ctx.prepareContext?.prDiff;
    return typeof preloadedDiff === 'string' ? preloadedDiff : '';
}

function formatNormalizedTaskContext(
    payload: NonNullable<BusinessRulesContext['taskContextNormalized']>,
): string {
    const sections: string[] = [];

    if (payload.id) {
        sections.push(`Task ID: ${payload.id}`);
    }
    if (payload.title) {
        sections.push(`Title: ${payload.title}`);
    }
    if (payload.description) {
        sections.push(`Description:\n${payload.description}`);
    }
    if (payload.acceptanceCriteria?.length) {
        sections.push(
            `Acceptance Criteria:\n${payload.acceptanceCriteria
                .map((item) => `- ${item}`)
                .join('\n')}`,
        );
    }
    if (payload.links?.length) {
        sections.push(
            `Links:\n${payload.links.map((item) => `- ${item}`).join('\n')}`,
        );
    }

    return sections.join('\n\n');
}

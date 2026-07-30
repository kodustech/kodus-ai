import { createLogger } from '@libs/core/log/logger';

import {
    DeterministicFallbackReason,
    executeDeterministicTool,
} from '../runtime/deterministic-tool-executor';
import {
    AgentCallOptions,
    CapabilityExecutionTrace,
    CapabilityStrategyScope,
    SkillCapabilityRuntimeConfig,
    ToolCaller,
} from '../runtime/skill-runtime.types';
import { asRecord, safeJsonParse } from '../runtime/value-utils';
import { normalizeParamName, uniqueNonEmpty } from './task-context/text-utils';

import {
    extractAris,
    extractIssueKeys,
    extractIssueNumbers,
    extractLinks,
    isLikelyTaskReferenceUrl,
} from './task-context/task-references';
import {
    isUsableTaskContext,
    scoreNormalizedContext,
} from './task-context/scoring';
import { extractTaskContextFromToolResult } from './task-context/result-normalization';
import { buildToolAliasKey } from './task-context/tool-aliases';
import { buildTaskContextArgsCandidates } from './task-context/arg-building';
import type {
    TaskContextHints,
    TaskContextReadParams,
    TaskContextToolSignature,
} from './task-context/task-context.types';
import { TaskContextNormalized } from './types';

// Public API kept stable: TaskContextReadParams now lives in the shared types
// module, re-exported here so index.ts (and callers) import it unchanged.
export type { TaskContextReadParams } from './task-context/task-context.types';

const TASK_CONTEXT_CAPABILITY = 'task.context.read';


export interface TaskContextReadResult {
    normalized: TaskContextNormalized | undefined;
    raw: string;
    traces: CapabilityExecutionTrace[];
}

export interface TaskContextReadHooks {
    getSeedTaskContextTools?: (
        provider: string,
        capability: string,
    ) => Promise<string[]>;
    getCachedTaskContextTools?: (
        scope: CapabilityStrategyScope,
    ) => Promise<string[]>;
    saveCachedTaskContextTools?: (
        scope: CapabilityStrategyScope,
        tools: string[],
    ) => Promise<void>;
    resolvePreferredTool?: (
        scope: CapabilityStrategyScope,
        candidates: string[],
    ) => Promise<string | undefined>;
    recordExecution?: (trace: CapabilityExecutionTrace) => Promise<void>;
}


interface ExecuteAndTraceParams<T> {
    params: TaskContextReadParams;
    toolCaller: ToolCaller;
    providerType: string;
    toolName: string | undefined;
    args: Record<string, unknown>;
    canExecute: boolean;
    extract: (payload: unknown) => T;
    fallback: T;
    isSuccessful: (value: T) => boolean;
    hooks?: TaskContextReadHooks;
    logger: ReturnType<typeof createLogger>;
}

interface AgentFallbackParams {
    toolCaller: ToolCaller;
    params: TaskContextReadParams;
    providerType: string;
    candidateTools: string[];
    hooks?: TaskContextReadHooks;
    logger: ReturnType<typeof createLogger>;
}

interface TaskContextDiscovery {
    scope: CapabilityStrategyScope;
    registeredTools: string[];
    candidateTools: string[];
    orderedTools: string[];
    cachedTools: string[];
}

interface DeterministicResolutionResult {
    value: TaskContextNormalized | undefined;
    raw: string;
    traces: CapabilityExecutionTrace[];
    learnedTools: string[];
}

export async function fetchTaskContext(
    toolCaller: ToolCaller,
    capabilityRuntime: SkillCapabilityRuntimeConfig,
    params: TaskContextReadParams,
    hooks?: TaskContextReadHooks,
): Promise<TaskContextReadResult> {
    const logger = createLogger('TaskContextReadCapability');
    const providerType = capabilityRuntime.providerType || 'external';
    const taskContextToolSignatures = getTaskContextToolSignatures(toolCaller);
    const hints = resolveTaskContextHints(params);
    const resolutionMode = params.taskContextResolutionMode ?? 'cache_first';
    const discovery = await resolveTaskContextDiscovery({
        toolCaller,
        capabilityRuntime,
        taskContextToolSignatures,
        params,
        providerType,
        hooks,
        logger,
    });
    const allowAgenticFallback =
        params.enableAgenticFallback !== false &&
        discovery.registeredTools.length > 0;

    const traces: CapabilityExecutionTrace[] = [];

    if (!discovery.orderedTools.length && !allowAgenticFallback) {
        const emptyCandidatesTrace: CapabilityExecutionTrace = {
            ...createBaseTrace(params, {
                capability: TASK_CONTEXT_CAPABILITY,
                mode: 'deterministic',
                provider: providerType,
            }),
            status: 'skipped',
            reason: 'no_candidate_tools',
            latencyMs: 0,
        };
        traces.push(emptyCandidatesTrace);
        await hooks?.recordExecution?.(emptyCandidatesTrace);

        return {
            normalized: undefined,
            raw: '',
            traces,
        };
    }

    if (resolutionMode === 'agent_first' && allowAgenticFallback) {
        const agenticFirst = await fetchTaskContextWithAgentFallback({
            toolCaller,
            params,
            providerType,
            candidateTools: discovery.orderedTools,
            hooks,
            logger,
        });

        traces.push(...agenticFirst.traces);
        await maybePersistLearnedTools(
            hooks,
            discovery.scope,
            agenticFirst.learnedTools,
            discovery.candidateTools,
            discovery.registeredTools,
            discovery.cachedTools,
        );

        if (agenticFirst.value) {
            return {
                normalized: agenticFirst.value,
                raw: agenticFirst.value.description ?? '',
                traces,
            };
        }
    }

    const deterministic = await resolveDeterministicTaskContext({
        params,
        toolCaller,
        providerType,
        orderedTools: discovery.orderedTools,
        taskContextToolSignatures,
        hints,
        hooks,
        logger,
    });
    traces.push(...deterministic.traces);

    if (deterministic.value && deterministic.learnedTools.length) {
        await maybePersistLearnedTools(
            hooks,
            discovery.scope,
            deterministic.learnedTools,
            discovery.candidateTools,
            discovery.registeredTools,
            discovery.cachedTools,
        );
    }
    if (deterministic.value) {
        return {
            normalized: deterministic.value,
            raw: deterministic.raw,
            traces,
        };
    }

    if (!allowAgenticFallback) {
        return {
            normalized: undefined,
            raw: '',
            traces,
        };
    }

    const agenticFallback = await fetchTaskContextWithAgentFallback({
        toolCaller,
        params,
        providerType,
        candidateTools: discovery.orderedTools,
        hooks,
        logger,
    });

    traces.push(...agenticFallback.traces);
    await maybePersistLearnedTools(
        hooks,
        discovery.scope,
        agenticFallback.learnedTools,
        discovery.candidateTools,
        discovery.registeredTools,
        discovery.cachedTools,
    );

    return {
        normalized: agenticFallback.value,
        raw: agenticFallback.value?.description ?? '',
        traces,
    };
}

async function resolveTaskContextDiscovery(input: {
    toolCaller: ToolCaller;
    capabilityRuntime: SkillCapabilityRuntimeConfig;
    taskContextToolSignatures: Map<string, TaskContextToolSignature>;
    params: TaskContextReadParams;
    providerType: string;
    hooks?: TaskContextReadHooks;
    logger: ReturnType<typeof createLogger>;
}): Promise<TaskContextDiscovery> {
    const scope: CapabilityStrategyScope = {
        organizationId: input.params.organizationId,
        teamId: input.params.teamId,
        skillName: input.params.skillName,
        capability: TASK_CONTEXT_CAPABILITY,
        provider: input.providerType,
    };
    const registeredTools = getRegisteredToolNames(input.toolCaller);
    const providerCandidates = resolveTaskContextProviders({
        providerType: input.providerType,
        allProviderTypes: input.capabilityRuntime.allProviderTypes,
    });
    const cachedTools =
        (await input.hooks?.getCachedTaskContextTools?.(scope)) ?? [];
    const seededTools = uniqueNonEmpty(
        (
            await Promise.all(
                providerCandidates.map(
                    async (provider) =>
                        (await input.hooks?.getSeedTaskContextTools?.(
                            provider,
                            TASK_CONTEXT_CAPABILITY,
                        )) ?? [],
                ),
            )
        ).flat(),
    );
    const resolvedCachedTools = resolveRegisteredToolAliases(
        cachedTools,
        registeredTools,
    );
    const resolvedSeededTools = resolveRegisteredToolAliases(
        seededTools,
        registeredTools,
    );
    const explorationTools = registeredTools.filter((toolName) =>
        input.taskContextToolSignatures.has(toolName),
    );
    const candidateTools = getTaskContextCandidateTools({
        registeredTools:
            seededTools.length && resolvedSeededTools.length
                ? registeredTools
                : explorationTools,
        allowlist: resolvedSeededTools,
        excludedTools: input.params.excludedTools ?? [],
        logger: input.logger,
    });
    const preferredTool = await input.hooks?.resolvePreferredTool?.(
        scope,
        candidateTools,
    );
    const orderedTools = orderCandidateTools({
        candidateTools,
        preferredTool,
        cachedTools: resolvedCachedTools,
        seededTools: resolvedSeededTools,
        includeExploration:
            preferredTool === undefined &&
            resolvedCachedTools.length === 0 &&
            resolvedSeededTools.length === 0,
    });

    return {
        scope,
        registeredTools,
        candidateTools,
        orderedTools,
        cachedTools: resolvedCachedTools,
    };
}

function resolveRegisteredToolAliases(
    desiredTools: string[],
    registeredTools: string[],
): string[] {
    const seen = new Set<string>();
    const resolved: string[] = [];

    for (const desiredTool of uniqueNonEmpty(desiredTools)) {
        const exactMatch = registeredTools.find(
            (toolName) => toolName === desiredTool,
        );
        if (exactMatch && !seen.has(exactMatch)) {
            seen.add(exactMatch);
            resolved.push(exactMatch);
            continue;
        }

        const desiredKey = buildToolAliasKey(desiredTool);
        if (!desiredKey) {
            continue;
        }

        for (const registeredTool of registeredTools) {
            if (buildToolAliasKey(registeredTool) !== desiredKey) {
                continue;
            }
            if (seen.has(registeredTool)) {
                continue;
            }
            seen.add(registeredTool);
            resolved.push(registeredTool);
        }
    }

    return resolved;
}

function resolveTaskContextHints(
    params: TaskContextReadParams,
): TaskContextHints {
    const candidates = [
        params.taskReference,
        params.taskId,
        params.taskUrl,
        params.taskContext,
        params.pullRequestDescription,
        params.prBody,
        params.userQuestion,
        params.headRef,
        ...(params.businessSignals?.ticketKeys ?? []),
        ...(params.businessSignals?.taskLinks ?? []),
        ...(params.businessSignals?.requirementKeywords ?? []),
    ]
        .filter((value): value is string => typeof value === 'string')
        .join('\n');

    const explicitTaskIds = uniqueNonEmpty([
        params.taskId ?? '',
        ...(params.businessSignals?.ticketKeys ?? []),
    ]);
    const explicitTaskLinks = uniqueNonEmpty([
        params.taskUrl ?? '',
        ...(params.businessSignals?.taskLinks ?? []),
    ]).filter(isLikelyTaskReferenceUrl);

    const issueKeys = uniqueNonEmpty([
        ...extractIssueKeys(candidates),
        ...explicitTaskIds,
    ]);
    const issueNumbers = extractIssueNumbers(candidates);
    const issueLinks = uniqueNonEmpty([
        ...extractLinks(candidates).filter(isLikelyTaskReferenceUrl),
        ...explicitTaskLinks,
    ]);
    const resourceIds = extractAris(candidates);

    const urlHosts = new Set<string>();
    const siteUrls = new Set<string>();
    for (const link of issueLinks) {
        try {
            const parsed = new URL(link);
            if (parsed.hostname.trim().length > 0) {
                urlHosts.add(parsed.hostname.toLowerCase());
                siteUrls.add(`${parsed.protocol}//${parsed.hostname}`);
            }
        } catch {
            // Ignore malformed URLs extracted from free-form text.
        }
    }

    return {
        issueKeys,
        issueNumbers,
        issueLinks,
        explicitIssueKeys: explicitTaskIds,
        explicitIssueLinks: explicitTaskLinks,
        queryText: [
            params.taskReference,
            params.taskId,
            params.taskUrl,
            params.userQuestion,
            params.pullRequestDescription,
            ...(params.businessSignals?.requirementKeywords ?? []),
            ...(params.businessSignals?.ticketKeys ?? []),
            ...(params.businessSignals?.taskLinks ?? []),
        ]
            .filter((value): value is string => typeof value === 'string')
            .join('\n'),
        urlHosts: [...urlHosts],
        siteUrls: [...siteUrls],
        resourceIds,
    };
}

function getRegisteredToolNames(toolCaller: ToolCaller): string[] {
    return toolCaller
        .getRegisteredTools()
        .map((tool) => tool.name ?? '')
        .filter((toolName) => toolName.trim().length > 0);
}

function getTaskContextToolSignatures(
    toolCaller: ToolCaller,
): Map<string, TaskContextToolSignature> {
    const signatures = new Map<string, TaskContextToolSignature>();
    const toolsForLLM = toolCaller.getToolsForLLM?.() ?? [];

    for (const tool of toolsForLLM) {
        const toolName =
            typeof tool?.name === 'string' && tool.name.trim().length > 0
                ? tool.name
                : undefined;
        if (!toolName) {
            continue;
        }

        const parameters = asRecord(tool.parameters);
        const requiredParams = Array.isArray(parameters.required)
            ? parameters.required.filter(
                  (item): item is string =>
                      typeof item === 'string' && item.trim().length > 0,
              )
            : [];
        const properties = asRecord(parameters.properties);
        const normalizedProperties = Object.entries(properties).reduce<
            Record<string, Record<string, unknown>>
        >((acc, [paramName, propertySchema]) => {
            acc[normalizeParamName(paramName)] = asRecord(propertySchema);
            return acc;
        }, {});

        signatures.set(toolName, {
            requiredParams,
            properties: Object.entries(properties).reduce<
                Record<string, Record<string, unknown>>
            >((acc, [paramName, propertySchema]) => {
                acc[paramName] = asRecord(propertySchema);
                return acc;
            }, {}),
            normalizedProperties,
        });
    }

    return signatures;
}

function getTaskContextCandidateTools(params: {
    registeredTools: string[];
    allowlist: string[];
    excludedTools: Array<string | undefined>;
    logger?: ReturnType<typeof createLogger>;
}): string[] {
    const allowlist = new Set(uniqueNonEmpty(params.allowlist));
    const excluded = new Set(
        params.excludedTools.filter(
            (toolName): toolName is string =>
                typeof toolName === 'string' && toolName.trim().length > 0,
        ),
    );

    const candidates: string[] = [];
    for (const toolName of params.registeredTools) {
        if (!toolName.trim().length) {
            continue;
        }
        if (allowlist.size > 0 && !allowlist.has(toolName)) {
            params.logger?.debug({
                message: '[task.context.read] tool excluded: not in allowlist',
                context: 'TaskContextReadCapability',
                metadata: { toolName },
            });
            continue;
        }
        if (excluded.has(toolName)) {
            params.logger?.debug({
                message:
                    '[task.context.read] tool excluded: in explicit exclusion list',
                context: 'TaskContextReadCapability',
                metadata: { toolName },
            });
            continue;
        }
        candidates.push(toolName);
    }

    return candidates;
}

async function resolveDeterministicTaskContext(input: {
    params: TaskContextReadParams;
    toolCaller: ToolCaller;
    providerType: string;
    orderedTools: string[];
    taskContextToolSignatures: Map<string, TaskContextToolSignature>;
    hints: TaskContextHints;
    hooks?: TaskContextReadHooks;
    logger: ReturnType<typeof createLogger>;
}): Promise<DeterministicResolutionResult> {
    const traces: CapabilityExecutionTrace[] = [];
    let bestValue: TaskContextNormalized | undefined;
    let bestTool: string | undefined;
    let bestScore = -1;

    for (const toolName of input.orderedTools) {
        const argsCandidates = buildTaskContextArgsCandidates(
            input.params,
            input.hints,
            input.taskContextToolSignatures.get(toolName),
        );

        for (const args of argsCandidates) {
            const result = await executeAndTrace({
                params: input.params,
                toolCaller: input.toolCaller,
                providerType: input.providerType,
                toolName,
                args,
                canExecute: true,
                extract: (payload) => extractTaskContextFromToolResult(payload),
                fallback: undefined,
                isSuccessful: (value) =>
                    Boolean(value?.description || value?.title),
                hooks: input.hooks,
                logger: input.logger,
            });

            traces.push(...result.traces);
            if (!result.value) {
                continue;
            }

            result.value.sourceProvider = input.providerType;
            const normalizedScore = scoreNormalizedContext(result.value);
            if (normalizedScore > bestScore) {
                bestValue = result.value;
                bestTool = toolName;
                bestScore = normalizedScore;
            }

            if (isUsableTaskContext(result.value)) {
                return {
                    value: result.value,
                    raw: result.value.description ?? '',
                    traces,
                    learnedTools: [toolName],
                };
            }
        }
    }

    return {
        value: bestValue,
        raw: bestValue?.description ?? '',
        traces,
        learnedTools: bestTool ? [bestTool] : [],
    };
}


function resolveTaskContextProviders(params: {
    providerType: string;
    allProviderTypes?: string[];
}): string[] {
    const declaredProviders = uniqueNonEmpty(params.allProviderTypes ?? []);
    if (!declaredProviders.length) {
        return uniqueNonEmpty([params.providerType]);
    }

    return uniqueNonEmpty([params.providerType, ...declaredProviders]);
}


async function executeAndTrace<T>(
    input: ExecuteAndTraceParams<T>,
): Promise<{ value: T; traces: CapabilityExecutionTrace[] }> {
    const startedAt = Date.now();
    const base = createBaseTrace(input.params, {
        capability: TASK_CONTEXT_CAPABILITY,
        mode: 'deterministic',
        provider: input.providerType,
        toolName: input.toolName,
    });

    let fallbackReason: DeterministicFallbackReason | undefined;
    let fallbackError: unknown;

    const value = await executeDeterministicTool({
        toolName: input.toolName,
        args: input.args,
        callTool: (toolName, args) => input.toolCaller.callTool(toolName, args),
        validate: () => (input.canExecute ? undefined : 'precondition_failed'),
        extract: (payload) => input.extract(payload),
        fallback: input.fallback,
        onError: 'fallback',
        onFallback: (reason, error) => {
            fallbackReason = reason;
            fallbackError = error;
        },
    });

    if (fallbackReason) {
        const trace: CapabilityExecutionTrace =
            fallbackReason === 'tool_unavailable' ||
            fallbackReason === 'precondition_failed'
                ? {
                      ...base,
                      status: 'skipped',
                      reason: fallbackReason,
                      latencyMs: Date.now() - startedAt,
                  }
                : {
                      ...base,
                      status: 'failed',
                      reason: fallbackReason,
                      latencyMs: Date.now() - startedAt,
                  };

        await input.hooks?.recordExecution?.(trace);

        if (fallbackReason === 'execution_error') {
            input.logger.warn({
                message: 'Capability execution failed',
                context: 'TaskContextReadCapability',
                metadata: {
                    capability: TASK_CONTEXT_CAPABILITY,
                    toolName: input.toolName,
                    errorMessage:
                        fallbackError instanceof Error
                            ? fallbackError.message
                            : String(fallbackError),
                },
            });
        }

        return { value: input.fallback, traces: [trace] };
    }

    const success = input.isSuccessful(value);
    const trace: CapabilityExecutionTrace = success
        ? {
              ...base,
              status: 'success',
              latencyMs: Date.now() - startedAt,
          }
        : {
              ...base,
              status: 'failed',
              reason: 'empty_result',
              latencyMs: Date.now() - startedAt,
          };

    await input.hooks?.recordExecution?.(trace);

    return {
        value: success ? value : input.fallback,
        traces: [trace],
    };
}

async function fetchTaskContextWithAgentFallback(
    input: AgentFallbackParams,
): Promise<
    {
        value: TaskContextNormalized | undefined;
        traces: CapabilityExecutionTrace[];
    } & {
        learnedTools: string[];
    }
> {
    const startedAt = Date.now();
    const base = createBaseTrace(input.params, {
        capability: TASK_CONTEXT_CAPABILITY,
        mode: 'agentic',
        provider: input.providerType,
    });

    if (!input.toolCaller.callAgent) {
        const unavailable: CapabilityExecutionTrace = {
            ...base,
            status: 'skipped',
            reason: 'agentic_unavailable',
            latencyMs: Date.now() - startedAt,
        };
        await input.hooks?.recordExecution?.(unavailable);

        return {
            value: undefined,
            traces: [unavailable],
            learnedTools: [],
        };
    }

    const hints = resolveTaskContextHints(input.params);
    const userLanguage =
        typeof input.params.userLanguage === 'string' &&
        input.params.userLanguage.trim().length > 0
            ? input.params.userLanguage.trim()
            : 'en-US';

    const prompt = `Resolve task context using available MCP tools.

AVAILABLE_TOOLS: ${input.candidateTools.join(', ') || '(none)'}
USER_QUESTION: ${input.params.userQuestion ?? ''}
PULL_REQUEST_DESCRIPTION:
${input.params.pullRequestDescription ?? ''}
KNOWN_TOKENS: ${[...hints.issueKeys, ...hints.issueLinks].join(', ') || '(none)'}
KNOWN_ISSUE_NUMBERS: ${hints.issueNumbers.join(', ') || '(none)'}
KNOWN_REPOSITORY_OWNER: ${input.params.repositoryOwner ?? '(unknown)'}
KNOWN_REPOSITORY_NAME: ${input.params.repositoryName ?? '(unknown)'}
USER_LANGUAGE: ${userLanguage}

When calling tools that require repository data, prioritize KNOWN_REPOSITORY_OWNER and KNOWN_REPOSITORY_NAME.

Return ONLY JSON:
{
  "taskContext": "string",
  "title": "optional",
  "id": "optional",
  "toolsUsed": ["toolName"]
}`;

    try {
        const agentOptions: AgentCallOptions = {
            thread: input.params.thread,
            userContext: {
                organizationAndTeamData: {
                    organizationId: input.params.organizationId,
                    teamId: input.params.teamId,
                },
            },
        };

        const response = await input.toolCaller.callAgent(
            `kodus-${input.params.skillName}-fetcher`,
            prompt,
            agentOptions,
        );

        const parsed = parseAgentTaskContextResult(response.result);
        const normalized =
            parsed.taskContext.trim().length > 0
                ? {
                      id: parsed.id,
                      title: parsed.title,
                      description: parsed.taskContext,
                      sourceProvider: input.providerType,
                  }
                : undefined;

        const traces: CapabilityExecutionTrace[] = [];
        for (const toolName of parsed.toolsUsed.length
            ? parsed.toolsUsed
            : [undefined]) {
            const trace: CapabilityExecutionTrace = normalized
                ? {
                      ...base,
                      toolName,
                      status: 'success',
                      latencyMs: Date.now() - startedAt,
                  }
                : {
                      ...base,
                      toolName,
                      status: 'failed',
                      reason: 'agentic_empty_result',
                      latencyMs: Date.now() - startedAt,
                  };

            traces.push(trace);
            await input.hooks?.recordExecution?.(trace);
        }

        return {
            value: normalized,
            traces,
            learnedTools: parsed.toolsUsed,
        };
    } catch (error) {
        input.logger.warn({
            message: 'Agentic fallback failed',
            context: 'TaskContextReadCapability',
            metadata: {
                errorMessage:
                    error instanceof Error ? error.message : String(error),
            },
        });

        const failed: CapabilityExecutionTrace = {
            ...base,
            status: 'failed',
            reason: 'agentic_execution_error',
            latencyMs: Date.now() - startedAt,
        };
        await input.hooks?.recordExecution?.(failed);

        return {
            value: undefined,
            traces: [failed],
            learnedTools: [],
        };
    }
}

function parseAgentTaskContextResult(value: unknown): {
    taskContext: string;
    title?: string;
    id?: string;
    toolsUsed: string[];
} {
    const parsed = asRecord(
        typeof value === 'string' ? safeJsonParse(value, {}) : value,
    );

    return {
        taskContext:
            typeof parsed.taskContext === 'string' ? parsed.taskContext : '',
        title: typeof parsed.title === 'string' ? parsed.title : undefined,
        id: typeof parsed.id === 'string' ? parsed.id : undefined,
        toolsUsed: Array.isArray(parsed.toolsUsed)
            ? parsed.toolsUsed.filter(
                  (item): item is string =>
                      typeof item === 'string' && item.trim().length > 0,
              )
            : [],
    };
}

function orderCandidateTools(params: {
    candidateTools: string[];
    preferredTool?: string;
    cachedTools: string[];
    seededTools: string[];
    includeExploration: boolean;
}): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];

    const pushIfCandidate = (tool: string | undefined) => {
        if (!tool) {
            return;
        }
        if (!params.candidateTools.includes(tool)) {
            return;
        }
        if (seen.has(tool)) {
            return;
        }
        seen.add(tool);
        ordered.push(tool);
    };

    pushIfCandidate(params.preferredTool);
    params.cachedTools.forEach(pushIfCandidate);
    params.seededTools.forEach(pushIfCandidate);
    if (params.includeExploration) {
        params.candidateTools.forEach(pushIfCandidate);
    }

    return ordered;
}

async function maybePersistLearnedTools(
    hooks: TaskContextReadHooks | undefined,
    scope: CapabilityStrategyScope,
    learnedTools: string[],
    candidateTools: string[],
    registeredTools: string[],
    cachedTools: string[],
): Promise<void> {
    if (!hooks?.saveCachedTaskContextTools) {
        return;
    }

    const deterministicBoundary = new Set(candidateTools);
    const registeredBoundary = new Set(registeredTools);
    const filteredLearned = learnedTools.filter((toolName) => {
        if (!registeredBoundary.has(toolName)) {
            return false;
        }

        if (!deterministicBoundary.size) {
            return true;
        }

        return deterministicBoundary.has(toolName);
    });

    if (!filteredLearned.length) {
        return;
    }

    const merged = [...new Set([...filteredLearned, ...cachedTools])];
    await hooks.saveCachedTaskContextTools(scope, merged);
}

function createBaseTrace(
    params: TaskContextReadParams,
    input: {
        capability: string;
        mode: 'deterministic' | 'agentic';
        provider: string;
        toolName?: string;
    },
): Omit<CapabilityExecutionTrace, 'status' | 'latencyMs' | 'reason'> {
    return {
        organizationId: params.organizationId,
        teamId: params.teamId,
        skillName: params.skillName,
        capability: input.capability,
        provider: input.provider,
        mode: input.mode,
        toolName: input.toolName,
        occurredAt: new Date().toISOString(),
    };
}



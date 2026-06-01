import { Thread, createLogger } from '@kodus/flow';

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
import { asRecord, safeJsonParse, safeStringify } from '../runtime/value-utils';

import { TaskContextNormalized } from './types';

const ISSUE_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const ISSUE_NUMBER_REGEX = /(?:#|\bissue\s*#?\s*|\bissues\s*#?\s*)(\d+)\b/gi;
const URL_REGEX = /https?:\/\/[^\s)]+/gi;
const ARI_REGEX = /\bari:[^\s,]+/gi;
const TASK_CONTEXT_CAPABILITY = 'task.context.read';

type ResolutionMode = 'cache_first' | 'agent_first';

interface TaskContextSignalHints {
    ticketKeys?: string[];
    taskLinks?: string[];
    requirementKeywords?: string[];
}

export interface TaskContextReadParams {
    skillName: string;
    organizationId: string;
    teamId: string;
    repositoryOwner?: string;
    repositoryName?: string;
    pullRequestNumber?: number;
    prBody?: string;
    headRef?: string;
    userQuestion?: string;
    pullRequestDescription?: string;
    taskContext?: string;
    taskId?: string;
    taskUrl?: string;
    taskReference?: string;
    userLanguage?: string;
    thread?: Thread;
    excludedTools?: string[];
    taskContextResolutionMode?: ResolutionMode;
    enableAgenticFallback?: boolean;
    businessSignals?: TaskContextSignalHints;
}

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

interface TaskContextHints {
    issueKeys: string[];
    issueNumbers: number[];
    issueLinks: string[];
    explicitIssueKeys: string[];
    explicitIssueLinks: string[];
    queryText: string;
    urlHosts: string[];
    siteUrls: string[];
    resourceIds: string[];
}

interface TaskContextToolSignature {
    requiredParams: string[];
    properties: Record<string, Record<string, unknown>>;
    normalizedProperties: Record<string, Record<string, unknown>>;
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

function extractIssueNumbers(text: string): number[] {
    const issueNumbers = new Set<number>();

    for (const match of text.matchAll(ISSUE_NUMBER_REGEX)) {
        const rawNumber = match[1];
        const parsed = Number.parseInt(rawNumber, 10);
        if (!Number.isNaN(parsed) && parsed > 0) {
            issueNumbers.add(parsed);
        }
    }

    return [...issueNumbers];
}

function extractIssueKeys(text: string): string[] {
    const issueKeys = new Set<string>();
    for (const match of text.matchAll(ISSUE_KEY_REGEX)) {
        if (match[1]) {
            issueKeys.add(match[1].toUpperCase());
        }
    }

    return [...issueKeys];
}

function extractLinks(text: string): string[] {
    const links: string[] = [];
    for (const match of text.matchAll(URL_REGEX)) {
        if (match[0]) {
            const normalized = normalizeLikelyUrl(match[0]);
            if (!normalized || !isLikelyUrl(normalized)) {
                continue;
            }
            links.push(normalized);
        }
    }

    return uniqueNonEmpty(links);
}

function extractAris(text: string): string[] {
    const resourceIds = new Set<string>();
    for (const match of text.matchAll(ARI_REGEX)) {
        if (match[0]) {
            resourceIds.add(match[0]);
        }
    }

    return [...resourceIds];
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

function buildTaskContextArgsCandidates(
    params: TaskContextReadParams,
    hints: TaskContextHints,
    signature?: TaskContextToolSignature,
): Record<string, unknown>[] {
    const allParams = signature?.properties
        ? Object.keys(signature.properties)
        : [];
    const requiredParams = signature?.requiredParams ?? [];

    if (!allParams.length) {
        if (!signature) {
            return buildGenericTaskContextArgsCandidates(hints);
        }

        const supportsMaxResults = Boolean(
            signature.normalizedProperties.maxresults,
        );

        return [supportsMaxResults ? { maxResults: 1 } : {}];
    }

    const valueByParam = new Map<string, unknown[]>();
    for (const paramName of allParams) {
        const candidates = getCandidateValuesForParam(
            paramName,
            params,
            hints,
            getParamSchema(signature, paramName),
        );

        if (candidates.length) {
            valueByParam.set(paramName, candidates);
            continue;
        }

        if (requiredParams.includes(paramName)) {
            return [];
        }
    }

    const paramsWithValues = [...valueByParam.keys()];

    if (!paramsWithValues.length) {
        const supportsMaxResults = Boolean(
            signature?.normalizedProperties?.maxresults,
        );

        if (requiredParams.length) {
            return [];
        }

        return [supportsMaxResults ? { maxResults: 1 } : {}];
    }

    const combinations = combineRequiredParamValues(
        paramsWithValues,
        valueByParam,
        16,
    );
    if (!combinations.length) {
        return [];
    }

    const supportsMaxResults = Boolean(
        signature?.normalizedProperties?.maxresults,
    );

    return combinations.map((args) =>
        supportsMaxResults ? { ...args, maxResults: 1 } : args,
    );
}

function getCandidateValuesForParam(
    paramName: string,
    params: TaskContextReadParams,
    hints: TaskContextHints,
    paramSchema?: Record<string, unknown>,
): unknown[] {
    const normalizedName = normalizeParamName(paramName);
    const staticCandidates = resolveStaticParamCandidates(
        normalizedName,
        params,
        hints,
        paramSchema,
    );
    if (staticCandidates.length) {
        return staticCandidates;
    }

    if (!supportsStringParam(paramSchema)) {
        return [];
    }

    const explicitIssueKeys = uniqueNonEmpty(hints.explicitIssueKeys).slice(
        0,
        4,
    );
    const explicitIssueLinks = uniqueNonEmpty(hints.explicitIssueLinks).slice(
        0,
        4,
    );
    const issueKeys = uniqueNonEmpty([
        ...explicitIssueKeys,
        ...hints.issueKeys,
    ]).slice(0, 4);
    const issueLinks = uniqueNonEmpty([
        ...explicitIssueLinks,
        ...hints.issueLinks,
    ]).slice(0, 4);
    const urlHosts = uniqueNonEmpty(hints.urlHosts).slice(0, 2);
    const siteUrls = uniqueNonEmpty(hints.siteUrls).slice(0, 2);
    const resourceIds = uniqueNonEmpty(hints.resourceIds).slice(0, 4);
    const queryTokens = uniqueNonEmpty([
        ...explicitIssueKeys,
        ...issueKeys,
        ...(explicitIssueKeys.length ? [] : issueLinks),
        ...(explicitIssueKeys.length ? [] : [hints.queryText]),
    ]).slice(0, 6);

    const intent = inferParamIntent(paramName, paramSchema);

    if (intent === 'issue') {
        return issueKeys.length ? issueKeys : queryTokens;
    }

    if (intent === 'query') {
        if (explicitIssueKeys.length) {
            return explicitIssueKeys;
        }
        if (issueKeys.length) {
            return issueKeys;
        }
        return queryTokens;
    }

    if (intent === 'context') {
        return siteUrls.length ? siteUrls : urlHosts.length ? urlHosts : [];
    }

    if (intent === 'url') {
        return issueLinks.length ? issueLinks : [];
    }

    if (intent === 'ari') {
        return resourceIds;
    }

    return queryTokens;
}

function getParamSchema(
    signature: TaskContextToolSignature | undefined,
    paramName: string,
): Record<string, unknown> | undefined {
    if (!signature) {
        return undefined;
    }

    const direct = signature.properties[paramName];
    if (direct) {
        return direct;
    }

    return signature.normalizedProperties[normalizeParamName(paramName)];
}

type ParamIntent = 'issue' | 'query' | 'context' | 'url' | 'ari' | 'generic';

function inferParamIntent(
    paramName: string,
    paramSchema: Record<string, unknown> | undefined,
): ParamIntent {
    const normalizedName = normalizeParamName(paramName);
    const descriptor = [
        paramName,
        readSchemaText(paramSchema, 'title'),
        readSchemaText(paramSchema, 'description'),
    ]
        .filter((value) => value.trim().length > 0)
        .join(' ')
        .toLowerCase();

    if (
        descriptor.includes('resource identifier') ||
        descriptor.includes('ari') ||
        normalizedName === 'ari' ||
        normalizedName.includes('resourceidentifier')
    ) {
        return 'ari';
    }

    if (
        normalizedName.includes('cloud') ||
        normalizedName.includes('host') ||
        normalizedName.includes('domain') ||
        normalizedName.includes('site') ||
        normalizedName.includes('workspace')
    ) {
        return 'context';
    }

    if (
        descriptor.includes('issue') ||
        descriptor.includes('ticket') ||
        descriptor.includes('task') ||
        normalizedName.includes('issue') ||
        normalizedName.includes('ticket') ||
        normalizedName.includes('task') ||
        normalizedName.includes('key') ||
        normalizedName.endsWith('id')
    ) {
        return 'issue';
    }

    if (
        descriptor.includes('query') ||
        descriptor.includes('search') ||
        normalizedName.includes('query') ||
        normalizedName.includes('search') ||
        normalizedName === 'text' ||
        normalizedName === 'input'
    ) {
        return 'query';
    }

    if (
        descriptor.includes('url') ||
        descriptor.includes('link') ||
        descriptor.includes('resource') ||
        normalizedName.includes('url') ||
        normalizedName.includes('link')
    ) {
        return 'url';
    }

    return 'generic';
}

function readSchemaText(
    schema: Record<string, unknown> | undefined,
    key: 'title' | 'description',
): string {
    if (!schema) {
        return '';
    }
    const value = schema[key];
    return typeof value === 'string' ? value : '';
}

function supportsStringParam(
    schema: Record<string, unknown> | undefined,
): boolean {
    if (!schema || !Object.keys(schema).length) {
        return true;
    }

    const expectedTypes = extractSchemaTypes(schema);
    if (!expectedTypes.size) {
        return true;
    }

    return expectedTypes.has('string');
}

function extractSchemaTypes(schema: Record<string, unknown>): Set<string> {
    const types = new Set<string>();
    const normalized = asRecord(schema);
    const typeNode = normalized.type;

    if (typeof typeNode === 'string') {
        types.add(typeNode.toLowerCase());
    } else if (Array.isArray(typeNode)) {
        for (const value of typeNode) {
            if (typeof value === 'string') {
                types.add(value.toLowerCase());
            }
        }
    }

    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const variants = normalized[key];
        if (!Array.isArray(variants)) {
            continue;
        }

        for (const variant of variants) {
            if (!variant || typeof variant !== 'object') {
                continue;
            }
            for (const type of extractSchemaTypes(
                variant as Record<string, unknown>,
            )) {
                types.add(type);
            }
        }
    }

    if (!types.size && normalized.properties) {
        types.add('object');
    }

    return types;
}

function combineRequiredParamValues(
    requiredParams: string[],
    valueByParam: Map<string, unknown[]>,
    limit: number,
): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const walk = (index: number, current: Record<string, unknown>) => {
        if (results.length >= limit) {
            return;
        }

        if (index >= requiredParams.length) {
            results.push({ ...current });
            return;
        }

        const param = requiredParams[index];
        const values = valueByParam.get(param) ?? [];
        for (const value of values) {
            current[param] = value;
            walk(index + 1, current);
            if (results.length >= limit) {
                return;
            }
        }
    };

    walk(0, {});
    return results;
}

function resolveStaticParamCandidates(
    normalizedParamName: string,
    params: TaskContextReadParams,
    hints: TaskContextHints,
    paramSchema?: Record<string, unknown>,
): unknown[] {
    if (normalizedParamName === 'organizationid') {
        return params.organizationId ? [params.organizationId] : [];
    }

    if (normalizedParamName === 'teamid') {
        return params.teamId ? [params.teamId] : [];
    }

    if (
        normalizedParamName === 'issuenumber' ||
        normalizedParamName === 'issueid'
    ) {
        return hints.issueNumbers.length ? hints.issueNumbers : [];
    }

    if (normalizedParamName === 'pullrequestnumber') {
        return typeof params.pullRequestNumber === 'number' &&
            params.pullRequestNumber > 0
            ? [params.pullRequestNumber]
            : [];
    }

    if (normalizedParamName === 'repository') {
        if (
            !hasObjectType(paramSchema) ||
            !params.repositoryOwner ||
            !params.repositoryName
        ) {
            return [];
        }

        return [
            {
                owner: params.repositoryOwner,
                name: params.repositoryName,
            },
        ];
    }

    if (
        normalizedParamName === 'owner' ||
        normalizedParamName === 'repositoryowner'
    ) {
        return params.repositoryOwner ? [params.repositoryOwner] : [];
    }

    if (
        normalizedParamName === 'repo' ||
        normalizedParamName === 'repositoryname'
    ) {
        return params.repositoryName ? [params.repositoryName] : [];
    }

    return [];
}

function hasObjectType(schema: Record<string, unknown> | undefined): boolean {
    if (!schema) {
        return false;
    }

    return extractSchemaTypes(schema).has('object');
}

function buildGenericTaskContextArgsCandidates(
    hints: TaskContextHints,
): Record<string, unknown>[] {
    const tokens = uniqueNonEmpty([
        ...hints.explicitIssueKeys,
        ...hints.explicitIssueLinks,
        ...(hints.explicitIssueKeys.length ? [] : hints.issueLinks),
        ...hints.issueKeys,
        ...(hints.explicitIssueKeys.length ? [] : [hints.queryText]),
    ]).slice(0, 4);
    const args: Record<string, unknown>[] = [];

    for (const token of tokens) {
        args.push(...buildArgsForToken(token));
    }

    const seen = new Set<string>();
    const deduped: Record<string, unknown>[] = [];
    for (const arg of args) {
        const key = JSON.stringify(arg);
        if (!seen.has(key)) {
            seen.add(key);
            deduped.push(arg);
        }
    }

    return deduped.slice(0, 16);
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

function buildArgsForToken(token: string): Record<string, unknown>[] {
    if (isLikelyUrl(token)) {
        return [
            { url: token },
            { resource: token },
            { link: token },
            { query: token },
            { input: token },
        ];
    }

    if (isLikelyIssueKey(token)) {
        return [
            { id: token },
            { key: token },
            { issueKey: token },
            { ticketId: token },
            { taskId: token },
            { query: token },
            { input: token },
        ];
    }

    return [
        { query: token },
        { text: token },
        { search: token },
        { input: token },
        { task: token },
        { issue: token },
    ];
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

function extractTaskContextFromToolResult(
    payload: unknown,
): TaskContextNormalized | undefined {
    const candidates = extractContextCandidates(payload);
    let best: TaskContextNormalized | undefined;
    let bestScore = -1;

    for (const candidate of candidates) {
        const normalized = normalizeContextCandidate(candidate);
        if (!normalized) {
            continue;
        }

        const score = scoreNormalizedContext(normalized);
        if (score > bestScore) {
            best = normalized;
            bestScore = score;
        }
    }

    return best;
}

function extractContextCandidates(payload: unknown): Record<string, unknown>[] {
    const candidates: Record<string, unknown>[] = [];
    const seen = new Set<string>();

    const addCandidate = (value: unknown): void => {
        const record = asRecord(value);
        if (!Object.keys(record).length) {
            return;
        }

        const fingerprint = safeStringify(record);
        if (seen.has(fingerprint)) {
            return;
        }
        seen.add(fingerprint);
        candidates.push(record);
    };

    const visit = (value: unknown, depth: number): void => {
        if (depth > 8 || value === null || value === undefined) {
            return;
        }

        if (typeof value === 'string') {
            const parsed = tryParseJsonString(value);
            if (parsed !== undefined) {
                visit(parsed, depth + 1);
            }
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value.slice(0, 25)) {
                visit(item, depth + 1);
            }
            return;
        }

        const record = asRecord(value);
        if (!Object.keys(record).length) {
            return;
        }
        addCandidate(record);

        const singletonKeys = [
            'result',
            'data',
            'payload',
            'item',
            'issue',
            'task',
            'ticket',
            'page',
            'record',
            'object',
            'fields',
            'properties',
            'attributes',
        ];
        const collectionKeys = [
            'items',
            'results',
            'records',
            'nodes',
            'content',
        ];

        for (const key of singletonKeys) {
            visit(record[key], depth + 1);
        }
        for (const key of collectionKeys) {
            visit(record[key], depth + 1);
        }
        if (typeof record.text === 'string') {
            visit(record.text, depth + 1);
        }
    };

    visit(payload, 0);
    return candidates;
}

function normalizeContextCandidate(
    candidate: Record<string, unknown>,
): TaskContextNormalized | undefined {
    if (looksLikeToolErrorCandidate(candidate)) {
        return undefined;
    }

    const fields = asRecord(candidate.fields);
    const properties = asRecord(candidate.properties);
    const attributes = asRecord(candidate.attributes);
    const data = asRecord(candidate.data);
    const spaces = [candidate, fields, properties, attributes, data];

    const id = firstNonEmptyString([
        ...pluckValues(spaces, [
            'key',
            'identifier',
            'code',
            'issueKey',
            'ticketKey',
            'taskKey',
            'id',
            'number',
            'issueId',
            'taskId',
            'ticketId',
            'pageId',
            'recordId',
        ]),
    ]);

    const title =
        firstNonEmptyString([
            ...pluckValues(spaces, ['summary', 'title', 'name', 'subject']),
        ]) ??
        extractPropertyText(properties, [
            'Name',
            'Title',
            'Summary',
            'Task',
            'Issue',
        ]);

    const descriptionRaw = firstNonEmptyValue([
        ...pluckValues(spaces, [
            'description',
            'body',
            'content',
            'text',
            'details',
            'overview',
            'context',
        ]),
    ]);

    const description = normalizeTextValue(descriptionRaw);

    const acceptanceCriteria = uniqueNonEmpty([
        ...(extractStringArray(
            firstNonEmptyValue([
                ...pluckValues(spaces, [
                    'acceptanceCriteria',
                    'acceptance_criteria',
                    'criteria',
                    'requirements',
                    'acceptance',
                ]),
            ]),
        ) ?? []),
        ...(extractStringArray(
            extractPropertyValue(properties, [
                'Acceptance Criteria',
                'Acceptance',
                'Criteria',
                'Requirements',
            ]),
        ) ?? []),
    ]);

    const links = uniqueNonEmpty([
        ...(extractStringArray(
            firstNonEmptyValue([
                ...pluckValues(spaces, ['links', 'references', 'urls']),
            ]),
        ) ?? []),
        ...[
            firstNonEmptyString([
                ...pluckValues(spaces, [
                    'url',
                    'webUrl',
                    'htmlUrl',
                    'permalink',
                    'href',
                    'uri',
                    'link',
                ]),
            ]),
        ].filter((value): value is string => typeof value === 'string'),
        ...(description ? extractLinks(description) : []),
    ]);

    const normalized: TaskContextNormalized = {
        id,
        title,
        description,
        acceptanceCriteria: acceptanceCriteria.length
            ? acceptanceCriteria
            : undefined,
        links: links.length ? links : undefined,
    };

    const hasCoreContent =
        Boolean(normalized.title?.trim()) ||
        Boolean(normalized.description?.trim());
    return hasCoreContent ? normalized : undefined;
}

function scoreNormalizedContext(value: TaskContextNormalized): number {
    let score = 0;
    if (value.id) {
        score += 1;
    }
    if (value.title) {
        score += 3;
    }
    if (value.description) {
        score += 4;
    }
    if (value.acceptanceCriteria?.length) {
        score += 2;
    }
    if (value.links?.length) {
        score += 1;
    }
    return score;
}

function isUsableTaskContext(value: TaskContextNormalized): boolean {
    if (value.acceptanceCriteria?.length) {
        return true;
    }

    if (!value.description?.trim()) {
        return false;
    }

    if (looksLikeTaskContextFailure(value)) {
        return false;
    }

    return !looksLikeStructuredMetadata(value.description);
}

function looksLikeStructuredMetadata(value: string): boolean {
    const trimmed = value.trim();
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
        return false;
    }

    return (
        trimmed.includes('"inlineCard"') ||
        trimmed.includes('"blockCard"') ||
        trimmed.includes('"application"') ||
        trimmed.includes('"attrs"') ||
        trimmed.includes('"url"')
    );
}

function looksLikeTaskContextFailure(value: TaskContextNormalized): boolean {
    const combined = [value.title, value.description]
        .filter((entry): entry is string => typeof entry === 'string')
        .join(' ')
        .toLowerCase();

    if (!combined) {
        return false;
    }

    const failureIndicators = [
        'failed to fetch',
        'status: 404',
        'status 404',
        'status: 403',
        'status 403',
        'status: 401',
        'status 401',
        'not found',
        'unauthorized',
        'forbidden',
        'tenant info',
    ];

    return failureIndicators.some((indicator) => combined.includes(indicator));
}

function looksLikeToolErrorCandidate(
    candidate: Record<string, unknown>,
): boolean {
    const statusCandidates = [
        candidate.status,
        candidate.statusCode,
        candidate.httpStatus,
    ];
    const status = statusCandidates.find(
        (value): value is number => typeof value === 'number',
    );
    const hasErrorStatus = typeof status === 'number' && status >= 400;

    const hasErrorFlag =
        candidate.error === true ||
        candidate.success === false ||
        candidate.ok === false;

    const errorValue = candidate.error;
    const errorRecord = asRecord(errorValue);
    const errorMessage =
        firstNonEmptyString([
            candidate.message,
            candidate.errorMessage,
            candidate.detail,
            typeof errorValue === 'string' ? errorValue : undefined,
            errorRecord.message,
        ]) ?? '';
    const normalizedErrorMessage = errorMessage.toLowerCase();

    const hasErrorMessage =
        normalizedErrorMessage.includes('failed to fetch') ||
        normalizedErrorMessage.includes('not found') ||
        normalizedErrorMessage.includes('unauthorized') ||
        normalizedErrorMessage.includes('forbidden') ||
        normalizedErrorMessage.includes('status: 404') ||
        normalizedErrorMessage.includes('status 404') ||
        normalizedErrorMessage.includes('status: 403') ||
        normalizedErrorMessage.includes('status 403') ||
        normalizedErrorMessage.includes('status: 401') ||
        normalizedErrorMessage.includes('status 401');

    return hasErrorFlag || hasErrorStatus || hasErrorMessage;
}

function pluckValues(
    spaces: Record<string, unknown>[],
    keys: string[],
): unknown[] {
    const values: unknown[] = [];
    for (const space of spaces) {
        for (const key of keys) {
            values.push(space[key]);
        }
    }
    return values;
}

function extractPropertyValue(
    properties: Record<string, unknown>,
    names: string[],
): unknown {
    for (const name of names) {
        if (properties[name] !== undefined) {
            return properties[name];
        }
    }
    return undefined;
}

function extractPropertyText(
    properties: Record<string, unknown>,
    names: string[],
): string | undefined {
    return normalizeTextValue(extractPropertyValue(properties, names));
}

function normalizeTextValue(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value.trim().length > 0 ? value : undefined;
    }

    // Handle Atlassian Document Format (ADF) — Jira returns description as
    // {type: "doc", content: [{type: "paragraph", content: [{type: "text", text: "..."}]}]}
    const adf = extractAdfText(value);
    if (adf) {
        return adf;
    }

    const rich = extractRichText(value);
    if (rich) {
        return rich;
    }

    if (value !== undefined && value !== null) {
        const serialized = safeStringify(value);
        return serialized && serialized.trim().length > 0
            ? serialized
            : undefined;
    }

    return undefined;
}

/**
 * Extract plain text from Atlassian Document Format (ADF).
 * ADF structure: {type: "doc", content: [{type: "paragraph"|"heading"|..., content: [{type: "text", text: "..."}]}]}
 */
function extractAdfText(value: unknown): string | undefined {
    const record = asRecord(value);
    if (
        record.type !== 'doc' ||
        !Array.isArray(record.content)
    ) {
        return undefined;
    }

    const lines: string[] = [];
    const visitAdfNode = (node: unknown): void => {
        const n = asRecord(node);
        if (!n.type) return;

        if (n.type === 'text' && typeof n.text === 'string') {
            lines.push(n.text);
            return;
        }

        if (Array.isArray(n.content)) {
            for (const child of n.content) {
                visitAdfNode(child);
            }
        }
    };

    for (const block of record.content as unknown[]) {
        visitAdfNode(block);
        lines.push('\n');
    }

    const result = lines.join('').replace(/\n{3,}/g, '\n\n').trim();
    return result.length > 0 ? result : undefined;
}

function extractRichText(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value.trim().length > 0 ? value : undefined;
    }

    if (Array.isArray(value)) {
        const combined = value
            .map((item) => extractRichText(item))
            .filter((item): item is string => typeof item === 'string')
            .join(' ')
            .trim();
        return combined.length > 0 ? combined : undefined;
    }

    const record = asRecord(value);
    if (!Object.keys(record).length) {
        return undefined;
    }

    const direct = firstNonEmptyString([
        record.plain_text,
        record.text,
        record.content,
        record.value,
        record.name,
        record.title,
    ]);
    if (direct) {
        return direct;
    }

    const nested = firstNonEmptyString([
        extractRichText(record.rich_text),
        extractRichText(record.title),
        extractRichText(record.description),
        extractRichText(record.content),
        extractRichText(record.text),
    ]);

    return nested;
}

function tryParseJsonString(value: string): unknown | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (
        !(
            (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
            (trimmed.startsWith('[') && trimmed.endsWith(']'))
        )
    ) {
        return undefined;
    }

    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

function extractStringArray(value: unknown): string[] | undefined {
    if (typeof value === 'string' && value.trim().length > 0) {
        return [value];
    }

    if (!Array.isArray(value)) {
        const nestedValue = extractRichText(value);
        return nestedValue ? [nestedValue] : undefined;
    }

    const values = value
        .map((item) => extractRichText(item))
        .filter((item): item is string => typeof item === 'string');

    return values.length ? values : undefined;
}

function firstNonEmptyString(values: unknown[]): string | undefined {
    for (const value of values) {
        if (typeof value === 'string' && value.trim().length > 0) {
            return value;
        }
    }
    return undefined;
}

function firstNonEmptyValue(values: unknown[]): unknown {
    for (const value of values) {
        if (typeof value === 'string') {
            if (value.trim().length > 0) {
                return value;
            }
            continue;
        }

        if (value !== undefined && value !== null) {
            return value;
        }
    }

    return undefined;
}

function normalizeParamName(value: string): string {
    return value.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function uniqueNonEmpty(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function buildToolAliasKey(value: string): string {
    const normalized = value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase();
    const tokens = normalized
        .split(/[^a-z0-9]+/i)
        .map((token) => normalizeToolAliasToken(token))
        .filter((token) => token.length > 0)
        .filter((token) => !isAliasNoiseToken(token));

    return tokens.sort().join(' ');
}

function normalizeToolAliasToken(token: string): string {
    if (token.length > 3 && token.endsWith('ies')) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.length > 3 && token.endsWith('s')) {
        return token.slice(0, -1);
    }
    return token;
}

function isAliasNoiseToken(token: string): boolean {
    return (
        token === 'provider' ||
        token === 'workspace' ||
        token === 'workspaces' ||
        token === 'plugin' ||
        token === 'integration'
    );
}

function isLikelyIssueKey(value: string): boolean {
    return /^[A-Z][A-Z0-9]+-\d+$/.test(value);
}

function isLikelyUrl(value: string): boolean {
    return /^https?:\/\//i.test(value);
}

function normalizeLikelyUrl(value: string): string {
    return value
        .trim()
        .replace(/^[("'`<]+/g, '')
        .replace(/[)\]'",.;:!?]+$/g, '');
}

function isLikelyTaskReferenceUrl(value: string): boolean {
    try {
        const parsed = new URL(value);
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname.toLowerCase();
        const query = parsed.search.toLowerCase();

        const knownTaskHosts = [
            'atlassian.net',
            'linear.app',
            'notion.so',
            'notion.site',
            'clickup.com',
            'trello.com',
            'asana.com',
            'dev.azure.com',
            'youtrack',
            'shortcut.com',
            'monday.com',
        ];

        if (knownTaskHosts.some((keyword) => host.includes(keyword))) {
            return true;
        }

        return (
            path.includes('/browse/') ||
            path.includes('/issue/') ||
            path.includes('/issues/') ||
            path.includes('/ticket/') ||
            path.includes('/tickets/') ||
            path.includes('/task/') ||
            path.includes('/tasks/') ||
            path.includes('/work-items/') ||
            path.startsWith('/t/') ||
            query.includes('selectedissue=')
        );
    } catch {
        return false;
    }
}

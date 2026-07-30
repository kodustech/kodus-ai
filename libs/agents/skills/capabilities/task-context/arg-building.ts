/**
 * task-context — MCP tool argument building.
 *
 * Extracted from the task-context-read monolith. Given a discovered task-context
 * tool's input schema (signature) and the reference hints mined from the PR/task,
 * produces the candidate argument objects to try against that tool — inferring,
 * per parameter, whether it wants an issue key, a free-text query, a URL, an ARI,
 * etc. Pure (no IO/LLM); the orchestrator executes the candidates.
 *
 * Public entry point: `buildTaskContextArgsCandidates`.
 */
import { asRecord } from '../../runtime/value-utils';
import { isLikelyIssueKey, isLikelyUrl } from './task-references';
import type {
    TaskContextHints,
    TaskContextReadParams,
    TaskContextToolSignature,
} from './task-context.types';
import { normalizeParamName, uniqueNonEmpty } from './text-utils';

export function buildTaskContextArgsCandidates(
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

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
            requiredParams.includes(paramName),
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
    isRequired?: boolean,
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

    // If the parameter has a closed enum, don't blindly stuff issue keys or
    // query tokens into it (e.g. responseContentFormat: 'markdown'|'adf' or
    // searchResultMode: 'issues'|'count'|'all'). Pick enum values that overlap
    // with our hints, or fall back to the first value when the param is
    // required so the call at least validates.
    const enumCandidates = resolveEnumParamCandidates(
        paramSchema,
        hints,
        isRequired,
    );
    if (enumCandidates) {
        return enumCandidates;
    }

    // A parameter fixed to a closed non-string value set (e.g. { const: 3 },
    // { enum: [1,2,3] }, { const: true }) yields no parseable string candidate
    // from extractEnumValues and would otherwise fall through to free-string
    // handling here — letting an issue key / query token be stuffed into it
    // (the -32602 / false-finding class the guard exists to prevent). Treat it
    // as "don't fill" instead of "free text".
    if (hasOnlyNonStringClosedConstraint(paramSchema)) {
        return [];
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
    // Kept above the 2 of other hint groups: an org can expose several tenants
    // and the ticket may live on any of them, so truncating drops valid targets.
    const siteUrls = uniqueNonEmpty(hints.siteUrls).slice(0, 4);
    const siteIds = uniqueNonEmpty(hints.siteIds ?? []).slice(0, 4);
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
        // Resolved tenant ids first: a host mined from PR prose is often from an
        // unrelated link, which the provider rejects outright. Bounded because
        // every candidate costs one sequential remote call downstream.
        return uniqueNonEmpty([...siteIds, ...siteUrls, ...urlHosts]).slice(
            0,
            6,
        );
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

/**
 * When a parameter declares a closed enum (e.g. responseContentFormat:
 * 'markdown'|'adf'), never push arbitrary issue keys or query tokens into it.
 * Return enum values that intersect with our hints, or a sensible default when
 * the parameter is required. Returns undefined when the schema has no enum so
 * the caller can apply normal intent-based resolution.
 */
function resolveEnumParamCandidates(
    paramSchema: Record<string, unknown> | undefined,
    hints: TaskContextHints,
    isRequired?: boolean,
): unknown[] | undefined {
    const enumValues = extractEnumValues(paramSchema);
    if (!enumValues.length) {
        return undefined;
    }

    const allTokens = uniqueNonEmpty([
        ...hints.explicitIssueKeys,
        ...hints.issueKeys,
        ...hints.explicitIssueLinks,
        ...hints.issueLinks,
        ...(hints.queryText ? [hints.queryText] : []),
    ]);

    const matching = enumValues.filter((value) =>
        allTokens.some(
            (token) =>
                typeof token === 'string' &&
                token.toLowerCase() === String(value).toLowerCase(),
        ),
    );

    if (matching.length) {
        return matching;
    }

    // Required enum parameter: pick the first declared value so the call can
    // still validate. The tool's default is the safest guess.
    if (isRequired && enumValues.length) {
        return [enumValues[0]];
    }

    // Optional enum parameter with no relevant hint: omit it and let the tool
    // use its default.
    return [];
}

/**
 * A parameter is only a *closed* enum when every possible value is fixed.
 * A `const` or an `anyOf`/`oneOf` of `const` branches is closed; but if any
 * `anyOf`/`oneOf` variant is an open `type: 'string'` (no `const`/`enum`),
 * the parameter accepts free-form text, so treating it as a closed enum
 * would replace a legitimate issue-key/query-token value with the const (or
 * drop it) — the exact class of bug we are guarding against.
 */
function hasOpenStringBranch(
    paramSchema: Record<string, unknown> | undefined,
): boolean {
    if (!paramSchema) {
        return false;
    }

    return (['anyOf', 'oneOf'] as const).some((key) => {
        const variants = paramSchema[key];
        return (
            Array.isArray(variants) &&
            variants.some((variant) => {
                if (!variant || typeof variant !== 'object') {
                    return false;
                }
                const branch = variant as Record<string, unknown>;
                return (
                    branch.type === 'string' &&
                    !('const' in branch) &&
                    !Array.isArray(branch.enum)
                );
            })
        );
    });
}

/**
 * Extract the concrete value set of a closed-enum parameter.
 *
 * Reads a top-level JSON-schema `enum` array AND the two other shapes a
 * tool's runtime schema (Zod-generated / MCP / Atlassian) commonly emits:
 *   - a lone `const` (frozen single value),
 *   - `anyOf` / `oneOf` where each branch is `{ const: 'x' }` (or has its own
 *     `enum`), e.g. `'markdown' | 'adf'` surfaced as
 *     `anyOf: [{ const: 'markdown' }, { const: 'adf' }]`.
 *
 * A top-level `enum` is always closed. `const` / `anyOf` / `oneOf` extraction
 * is skipped when any variant is an open `type: 'string'` — those params take
 * free-form values and must NOT be treated as closed (their value comes from
 * the issue-key/query-token pipeline, not a fixed set).
 *
 * Without this, a param declared via `const`/`anyOf`/`oneOf` evades the
 * closed-enum guard in `resolveEnumParamCandidates` and gets treated as a
 * generic string, so issue keys / query tokens are stuffed into it and the
 * tool's own validator rejects the call (#1760).
 */
function extractEnumValues(
    paramSchema: Record<string, unknown> | undefined,
): string[] {
    if (!paramSchema) {
        return [];
    }

    const collected: string[] = [];

    const pushConc = (value: unknown): void => {
        if (typeof value === 'string') {
            collected.push(value);
        }
    };

    // 1. Top-level `enum: ['a', 'b']` is always a closed set.
    const rawEnum = paramSchema.enum;
    if (Array.isArray(rawEnum)) {
        for (const value of rawEnum) {
            pushConc(value);
        }
    }

    const openStringBranch = hasOpenStringBranch(paramSchema);

    // 2. A lone `const: 'a'` is only a closed value set when the param has no
    //    open string branch; next to an open string it is a suggested default,
    //    not a restriction, so it must not narrow the free-form param.
    if (!openStringBranch) {
        pushConc(paramSchema.const);
    }

    // 3. `anyOf` / `oneOf` branches — each branch may declare `const` or a
    //    nested `enum`.
    for (const key of ['anyOf', 'oneOf'] as const) {
        const variants = paramSchema[key];
        if (!Array.isArray(variants)) {
            continue;
        }
        for (const variant of variants) {
            if (!variant || typeof variant !== 'object') {
                continue;
            }
            const branch = variant as Record<string, unknown>;
            if ('const' in branch) {
                // A const branch next to an open string sibling is just a
                // default suggestion — keep it out of the closed set so the
                // param stays free-form (e.g. anyOf:[{type:'string'},{const:'default'}]).
                if (!openStringBranch) {
                    pushConc(branch.const);
                }
                continue;
            }
            // An enum branch is ALWAYS a closed set, even when the param also
            // carries an open string branch. Collecting it keeps the
            // closed-enum guard active, so an issue key can't leak into a
            // format param like anyOf:[{enum:['markdown','adf']},{type:'string'}]
            // (#1760).
            if (Array.isArray(branch.enum)) {
                for (const value of branch.enum) {
                    pushConc(value);
                }
            }
        }
    }

    return [...new Set(collected)];
}

/**
 * Collect every value a schema fixes via `enum` / `const`, regardless of type,
 * using the same "closed" rules as extractEnumValues but WITHOUT the string
 * filter. This lets a closed non-string set (e.g. { const: 3 }) be detected
 * even though it yields no parseable string candidate.
 */
function collectClosedSchemaValues(
    paramSchema: Record<string, unknown> | undefined,
): unknown[] {
    if (!paramSchema) {
        return [];
    }

    const collected: unknown[] = [];

    const rawEnum = paramSchema.enum;
    if (Array.isArray(rawEnum)) {
        for (const value of rawEnum) {
            collected.push(value);
        }
    }

    if (!hasOpenStringBranch(paramSchema)) {
        if ('const' in paramSchema) {
            collected.push(paramSchema.const);
        }
        for (const key of ['anyOf', 'oneOf'] as const) {
            const variants = paramSchema[key];
            if (!Array.isArray(variants)) {
                continue;
            }
            for (const variant of variants) {
                if (!variant || typeof variant !== 'object') {
                    continue;
                }
                const branch = variant as Record<string, unknown>;
                if ('const' in branch) {
                    collected.push(branch.const);
                    continue;
                }
                if (Array.isArray(branch.enum)) {
                    for (const value of branch.enum) {
                        collected.push(value);
                    }
                }
            }
        }
    }

    return collected;
}

/**
 * True when the parameter is fixed to a closed `const`/`enum` set whose values
 * are all non-string (e.g. { const: 3 }, { enum: [1,2,3] }, { const: true }).
 * Such a parameter must never be treated as a free-form string via
 * supportsStringParam — stuffing an issue key into it is exactly the -32602
 * class of bug — so it should yield no candidates instead.
 */
function hasOnlyNonStringClosedConstraint(
    paramSchema: Record<string, unknown> | undefined,
): boolean {
    const closedValues = collectClosedSchemaValues(paramSchema);
    if (!closedValues.length) {
        return false;
    }
    return closedValues.every((value) => typeof value !== 'string');
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

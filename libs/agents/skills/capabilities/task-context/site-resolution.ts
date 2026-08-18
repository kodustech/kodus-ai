/**
 * task-context — site (tenant) resolution for provider-scoped tools.
 *
 * Some task-management MCPs scope every read to a tenant id that cannot be
 * mined from PR text: Atlassian's `getJiraIssue` / `searchJiraIssuesUsingJql`
 * both require `cloudId` ("UUID or site URL"). When the PR references the
 * ticket by bare key — the common case — there is no Atlassian URL to derive it
 * from, `buildTaskContextArgsCandidates` produces no candidates for the required
 * param, and those tools are dropped entirely; resolution then falls through to
 * whatever generic search tool has no tenant param, which returns weak context.
 *
 * This module resolves the tenant out-of-band by calling the provider's own
 * discovery tool once per organization, so the precise tools stay reachable.
 */
import { createLogger } from '@libs/core/log/logger';

import { executeDeterministicTool } from '../../runtime/deterministic-tool-executor';
import { BoundedMap } from '../../runtime/bounded-map';
import type { ToolCaller } from '../../runtime/skill-runtime.types';
import { asRecord } from '../../runtime/value-utils';
import { tryParseJsonString, uniqueNonEmpty } from './text-utils';

/** Discovery tools that list the tenants an integration can read. */
const SITE_RESOLVER_TOOLS = ['getAccessibleAtlassianResources'];

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_SITES = 4;

export interface TaskContextSiteHints {
    siteIds: string[];
    siteUrls: string[];
}

const EMPTY_SITE_HINTS: TaskContextSiteHints = { siteIds: [], siteUrls: [] };

const siteHintsCache = new BoundedMap<
    string,
    { hints: TaskContextSiteHints; expiresAt: number }
>(256);

export function resetTaskContextSiteHintsCache(): void {
    siteHintsCache.clear();
}

export async function resolveTaskContextSiteHints(input: {
    toolCaller: ToolCaller;
    registeredTools: string[];
    organizationId: string;
    providerType: string;
    logger: ReturnType<typeof createLogger>;
}): Promise<TaskContextSiteHints> {
    const resolverTool = SITE_RESOLVER_TOOLS.find((toolName) =>
        input.registeredTools.includes(toolName),
    );
    if (!resolverTool) {
        return EMPTY_SITE_HINTS;
    }

    const cacheKey = `${input.organizationId}:${input.providerType}:${resolverTool}`;
    const cached = siteHintsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.hints;
    }

    const hints = await executeDeterministicTool<TaskContextSiteHints>({
        toolName: resolverTool,
        args: {},
        callTool: (toolName, args) => input.toolCaller.callTool(toolName, args),
        extract: (payload) => extractSiteHints(payload),
        fallback: EMPTY_SITE_HINTS,
        onError: 'fallback',
        onFallback: (reason, error) => {
            input.logger.warn({
                message: `Task context site resolution failed via '${resolverTool}'`,
                context: 'TaskContextReadCapability',
                metadata: {
                    organizationId: input.organizationId,
                    providerType: input.providerType,
                    reason,
                    errorMessage:
                        error instanceof Error ? error.message : undefined,
                },
            });
        },
    });

    // Only cache a resolved tenant: caching the empty fallback would pin a
    // transient MCP failure for the whole TTL.
    if (hints.siteIds.length || hints.siteUrls.length) {
        siteHintsCache.set(cacheKey, {
            hints,
            expiresAt: Date.now() + CACHE_TTL_MS,
        });
    }

    return hints;
}

function extractSiteHints(payload: unknown): TaskContextSiteHints {
    const siteIds: string[] = [];
    const siteUrls: string[] = [];
    const seen = new Set<unknown>();

    const visit = (value: unknown, depth: number): void => {
        if (depth > 6 || value === null || value === undefined) {
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
            for (const item of value) {
                visit(item, depth + 1);
            }
            return;
        }

        if (typeof value !== 'object' || seen.has(value)) {
            return;
        }
        seen.add(value);

        const record = asRecord(value);
        const id = record.id;
        const url = record.url;
        if (typeof id === 'string' && id.trim().length > 0) {
            siteIds.push(id.trim());
        }
        if (typeof url === 'string' && url.trim().length > 0) {
            siteUrls.push(url.trim());
        }

        for (const nested of Object.values(record)) {
            visit(nested, depth + 1);
        }
    };

    visit(payload, 0);

    return {
        siteIds: uniqueNonEmpty(siteIds).slice(0, MAX_SITES),
        siteUrls: uniqueNonEmpty(siteUrls).slice(0, MAX_SITES),
    };
}

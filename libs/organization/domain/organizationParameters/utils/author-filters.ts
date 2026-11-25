import {
    AutoAssignConnectionFilters,
    OrganizationParametersAutoAssignConfig,
} from '../types/organizationParameters.types';

export type AuthorFilters = Required<AutoAssignConnectionFilters>;

const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((id) => String(id)) : [];

/**
 * The PR author filters that apply to one Git connection. A connection without
 * lists of its own keeps the organization's, which is what every connection
 * read before the lists moved per connection.
 */
export const authorFiltersFor = (
    config: Partial<OrganizationParametersAutoAssignConfig> | null | undefined,
    integrationId?: string,
): AuthorFilters => {
    const connections = config?.connections;
    const own =
        integrationId && connections && Object.hasOwn(connections, integrationId)
            ? connections[integrationId]
            : undefined;
    const source = own ?? config;
    return {
        ignoredUsers: list(source?.ignoredUsers),
        allowedUsers: list(source?.allowedUsers),
        seededBotIds: list(source?.seededBotIds),
    };
};

/** Applies a change to one connection's lists, or to the organization's when none is named. */
export const withConnectionAuthorFilters = <
    T extends Partial<OrganizationParametersAutoAssignConfig>,
>(
    config: T,
    integrationId: string | undefined,
    patch: AutoAssignConnectionFilters,
): T & { connections: Record<string, AutoAssignConnectionFilters> } => {
    const connections = { ...(config?.connections ?? {}) };
    if (!integrationId) {
        return { ...config, ...patch, connections };
    }
    connections[integrationId] = {
        ...authorFiltersFor(config, integrationId),
        ...patch,
    };
    return { ...config, connections };
};

import { CentralizedConfigParameter } from '../types/configValue.type';

/**
 * The team's CENTRALIZED_CONFIG holds the workspace's config at the top level,
 * stamped with the Git connection it belongs to, and every other connection's
 * config under `connections`. A config stored before connections existed has
 * no stamp and serves every connection.
 */
export type StoredCentralizedConfig = CentralizedConfigParameter & {
    connections?: Record<string, CentralizedConfigParameter>;
};

const DISABLED: CentralizedConfigParameter = {
    enabled: false,
    repository: null,
};

const strip = (
    value: CentralizedConfigParameter,
): CentralizedConfigParameter => {
    const {
        connections: _connections,
        connectionScoped: _scoped,
        ...rest
    } = value as StoredCentralizedConfig;
    return rest;
};

export const centralizedConfigFor = (
    stored: StoredCentralizedConfig | null | undefined,
    integrationId?: string,
): CentralizedConfigParameter | null | undefined => {
    if (!stored) return stored;
    const { connections, ...workspace } = stored;
    if (!integrationId) return workspace;
    const own = connections?.[integrationId];
    if (own) return { ...own, connectionScoped: true };
    if (!workspace.integrationId || workspace.integrationId === integrationId) {
        return workspace;
    }
    return { ...DISABLED, connectionScoped: true };
};

export const withCentralizedConfigFor = (
    stored: StoredCentralizedConfig | null | undefined,
    integrationId: string | undefined,
    value: CentralizedConfigParameter,
): StoredCentralizedConfig => {
    const next = strip(value);
    if (!stored) {
        return integrationId ? { ...next, integrationId } : next;
    }
    const { connections, ...workspace } = stored;
    const keep = connections ? { connections } : {};
    const writesWorkspace =
        !integrationId ||
        (!connections?.[integrationId] &&
            (!workspace.integrationId ||
                workspace.integrationId === integrationId));
    // A cleared config belongs to no connection: the next one to set it up
    // takes the workspace's slot, and a connection's own slot goes away.
    const cleared = !next.enabled && !next.repository?.id;
    if (writesWorkspace) {
        const owner = cleared
            ? undefined
            : (integrationId ?? workspace.integrationId);
        const { integrationId: _stamp, ...rest } = next;
        return { ...rest, ...(owner ? { integrationId: owner } : {}), ...keep };
    }
    const { integrationId: _id, ...own } = next;
    const others = { ...connections };
    if (cleared) {
        delete others[integrationId];
    } else {
        others[integrationId] = own;
    }
    return { ...workspace, connections: others };
};

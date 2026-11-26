import { IKodyRuleCentralizedConfig } from '../interfaces/kodyRules.interface';

/** Where a centralized-config sync reads its rules from. */
export type CentralizedRuleSource = {
    repositoryId: string;
    connectionId?: string;
    /** `PLATFORM|host` of the server holding the repository, when known. */
    serverKey?: string;
    connectionScoped: boolean;
};

const fileOf = (path?: string) => (path || '').split('#')[0];

/**
 * A repository id names one repository per server, so repository + server
 * is the source. Only a connection's own config records the connection: its
 * global rules review that connection alone. A sync that could not read the
 * server keeps the one the rule recorded from the same repository.
 */
export const centralizedSourceStamp = (
    source: CentralizedRuleSource,
    previous?: IKodyRuleCentralizedConfig | null,
): Pick<
    IKodyRuleCentralizedConfig,
    | 'sourceRepositoryId'
    | 'sourceServerKey'
    | 'sourceConnectionId'
    | 'connectionScoped'
> => {
    const serverKey =
        source.serverKey ??
        (previous?.sourceServerKey &&
        String(previous.sourceRepositoryId) === String(source.repositoryId)
            ? previous.sourceServerKey
            : undefined);
    return {
        sourceRepositoryId: source.repositoryId,
        ...(serverKey ? { sourceServerKey: serverKey } : {}),
        ...(source.connectionScoped && source.connectionId
            ? {
                  sourceConnectionId: source.connectionId,
                  connectionScoped: true,
              }
            : {}),
    };
};

/**
 * Whose sync a rule belongs to. Two teams reading one config repository on
 * one server share its rules. A connection settles it only for a
 * connection's own config, or when either side lacks the server, and then
 * only when both sides record one: syncs started without a connection (the
 * CLI on a single-connection workspace) stamp none.
 */
export const centralizedRuleOwner = (
    centralizedConfig: IKodyRuleCentralizedConfig | undefined | null,
    source: CentralizedRuleSource,
): 'own' | 'other' | 'unstamped' => {
    if (!centralizedConfig?.sourceRepositoryId) return 'unstamped';
    if (
        String(centralizedConfig.sourceRepositoryId) !==
        String(source.repositoryId)
    ) {
        return 'other';
    }
    const serversKnown = Boolean(
        centralizedConfig.sourceServerKey && source.serverKey,
    );
    if (
        serversKnown &&
        centralizedConfig.sourceServerKey !== source.serverKey
    ) {
        return 'other';
    }
    const connectionDecides =
        !serversKnown ||
        centralizedConfig.connectionScoped === true ||
        source.connectionScoped;
    if (
        connectionDecides &&
        centralizedConfig.sourceConnectionId &&
        source.connectionId &&
        centralizedConfig.sourceConnectionId !== source.connectionId
    ) {
        return 'other';
    }
    return 'own';
};

/**
 * Writers that move a rule through the centralized PR flow replace its
 * centralized fields with `{ path, status }`. The source stays while the
 * rule still points at the same file.
 */
export const keepCentralizedSource = (
    previous: IKodyRuleCentralizedConfig | undefined | null,
    next: IKodyRuleCentralizedConfig | undefined | null,
): IKodyRuleCentralizedConfig | undefined | null => {
    if (!next || next.sourceRepositoryId || !previous?.sourceRepositoryId) {
        return next;
    }
    if (fileOf(previous.path) !== fileOf(next.path)) return next;
    return {
        ...next,
        sourceRepositoryId: previous.sourceRepositoryId,
        ...(previous.sourceServerKey
            ? { sourceServerKey: previous.sourceServerKey }
            : {}),
        ...(previous.sourceConnectionId
            ? { sourceConnectionId: previous.sourceConnectionId }
            : {}),
        ...(previous.connectionScoped ? { connectionScoped: true } : {}),
    };
};

/** A global rule from a connection's own centralized config reviews only that connection's repositories. */
export const ruleAppliesToConnection = (
    rule: {
        repositoryId?: string;
        centralizedConfig?: IKodyRuleCentralizedConfig | null;
    },
    integrationId: string | undefined,
): boolean => {
    const centralized = rule.centralizedConfig;
    if (!integrationId || !centralized?.connectionScoped) return true;
    return (
        !centralized.sourceConnectionId ||
        centralized.sourceConnectionId === integrationId
    );
};

/**
 * A member granted only some Git connections reads a connection's own global
 * rules only when granted that connection; `null` reads every rule.
 */
export const ruleVisibleToConnections = (
    rule: {
        centralizedConfig?: Pick<
            IKodyRuleCentralizedConfig,
            'connectionScoped' | 'sourceConnectionId'
        > | null;
    },
    connectionIds: ReadonlySet<string> | null | undefined,
): boolean => {
    const centralized = rule.centralizedConfig;
    if (!connectionIds || !centralized?.connectionScoped) return true;
    return (
        !centralized.sourceConnectionId ||
        connectionIds.has(centralized.sourceConnectionId)
    );
};

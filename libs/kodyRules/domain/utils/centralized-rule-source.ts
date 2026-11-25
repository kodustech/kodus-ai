import { IKodyRuleCentralizedConfig } from '../interfaces/kodyRules.interface';

/** Where a centralized-config sync reads its rules from. */
export type CentralizedRuleSource = {
    repositoryId: string;
    connectionId?: string;
    connectionScoped: boolean;
};

const fileOf = (path?: string) => (path || '').split('#')[0];

export const centralizedSourceStamp = (
    source: CentralizedRuleSource,
): Pick<
    IKodyRuleCentralizedConfig,
    'sourceRepositoryId' | 'sourceConnectionId' | 'connectionScoped'
> => ({
    sourceRepositoryId: source.repositoryId,
    ...(source.connectionId ? { sourceConnectionId: source.connectionId } : {}),
    ...(source.connectionScoped ? { connectionScoped: true } : {}),
});

/**
 * Whose sync a rule belongs to. A connection recorded on only one side
 * proves nothing: syncs started without a connection (the CLI on a
 * single-connection workspace) stamp none.
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
    if (
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

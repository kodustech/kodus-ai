/**
 * What a centralized-config export holds for a call on one Git connection:
 * only that connection's repositories, and the workspace defaults only while
 * the config is the workspace's (a connection's own config never applies them).
 */
export const connectionDownloadScope = (
    integrationId: string | undefined,
    repositoryIds: string[],
    config: { connectionScoped?: boolean } | null | undefined,
): { repositoryIds?: string[]; includeWorkspaceDefaults?: boolean } =>
    integrationId
        ? {
              repositoryIds,
              includeWorkspaceDefaults: !config?.connectionScoped,
          }
        : {};

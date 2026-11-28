import { normalizeHost } from '@libs/common/utils/webhooks/webhook-source-host';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

const CLOUD_HOSTS: Partial<Record<PlatformType, string>> = {
    [PlatformType.GITHUB]: 'github.com',
    [PlatformType.GITLAB]: 'gitlab.com',
    [PlatformType.BITBUCKET]: 'bitbucket.org',
    // Azure DevOps repository ids are global GUIDs: one server for all.
    [PlatformType.AZURE_REPOS]: 'dev.azure.com',
};

/**
 * `PLATFORM|host` of the server a connection talks to. Repository ids are
 * unique per server, so two connections can only list the same repository
 * when their keys match.
 */
export function connectionServerKey(
    platform: PlatformType,
    authDetails?: { host?: string | null; [key: string]: unknown } | null,
): string {
    const host =
        platform === PlatformType.AZURE_REPOS
            ? CLOUD_HOSTS[platform]
            : (normalizeHost(authDetails?.host) ?? CLOUD_HOSTS[platform] ?? '');
    return `${platform}|${host}`;
}

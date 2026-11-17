import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { NamedApprovalPolicy } from '@libs/core/infrastructure/config/types/general/approval-policies';

export function approvalPolicyProviderError(
    policies: NamedApprovalPolicy[],
    provider: PlatformType | null | undefined,
): string | undefined {
    const hasLabels = policies.some((policy) => !!policy.labels?.length);
    const hasTeams = policies.some((policy) => !!policy.authorTeams?.length);
    if (!hasLabels && !hasTeams) return undefined;
    if (!provider)
        return 'Connect a code provider before adding label or team conditions.';
    if (
        hasLabels &&
        [PlatformType.BITBUCKET, PlatformType.AZURE_REPOS].includes(provider)
    )
        return 'PR label conditions are unavailable on this provider.';
    if (
        hasTeams &&
        ![
            PlatformType.GITHUB,
            PlatformType.GITLAB,
            PlatformType.AZURE_REPOS,
        ].includes(provider)
    )
        return 'Author team conditions are unavailable on this provider. Use provider usernames instead.';
    return undefined;
}

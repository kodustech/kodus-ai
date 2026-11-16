import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import type { CommentAuthorPort, OwnCommentAuthor } from '../domain/runtime-publish.ports';

/**
 * Who the integration posts as, from the product's own services: the
 * account its token belongs to (CodeManagementService.getCurrentUser,
 * normalized by each platform service) and, on GitHub, the App this
 * deployment authenticates as (API_GITHUB_APP_ID). An installation token
 * has no user, so a GitHub App integration is known by the App alone.
 */
export class PlatformCommentAuthor implements CommentAuthorPort {
    constructor(
        private readonly codeManagement: {
            getCurrentUser(params: { organizationAndTeamData: OrganizationAndTeamData }, type?: PlatformType): Promise<any | null>;
        },
        private readonly githubAppId: () => number | undefined,
    ) {}

    async ownAuthor(organizationAndTeamData: OrganizationAndTeamData, platformType: PlatformType): Promise<OwnCommentAuthor | null> {
        const githubAppId = platformType === PlatformType.GITHUB ? this.githubAppId() : undefined;
        const user = await this.codeManagement.getCurrentUser({ organizationAndTeamData }, platformType);
        const userIds = [...new Set([user?.id, user?.uuid, user?.account_id, user?.originId].filter((v) => v !== undefined && v !== null && v !== '').map(String))];
        if (!userIds.length && githubAppId === undefined) return null;
        return { userIds, ...(githubAppId !== undefined ? { githubAppId } : {}) };
    }
}

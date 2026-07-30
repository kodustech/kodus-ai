import { Inject, Injectable } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';

import {
    COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN,
    ICockpitReviewAnalyticsService,
} from '../../domain/contracts/cockpit-review-analytics.service.contract';
import {
    IReportRecipientsService,
    RepoAdminRecipient,
    ReportRecipient,
} from '../../domain/contracts/report-recipients.service.contract';

/**
 * Resolves report recipients from the identity layer. Org reports go to active
 * OWNERs; repo digests go to active REPO_ADMINs scoped to the repos they were
 * explicitly assigned (`permissions.assignedRepositoryIds`). The forward query
 * (user → repos) is all we need — no reverse "who admins repo X" lookup.
 */
@Injectable()
export class ReportRecipientsService implements IReportRecipientsService {
    constructor(
        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,
        @Inject(COCKPIT_REVIEW_ANALYTICS_SERVICE_TOKEN)
        private readonly review: ICockpitReviewAnalyticsService,
    ) {}

    async getOwners(organizationId: string): Promise<ReportRecipient[]> {
        const users = await this.usersService.find(
            { organization: { uuid: organizationId }, role: Role.OWNER },
            [STATUS.ACTIVE],
        );
        return (users ?? [])
            .filter((u) => Boolean(u?.email))
            .map((u) => ({ email: u.email, name: resolveDisplayName(u) }));
    }

    /**
     * Active repo admins with their assigned repos resolved to warehouse repo
     * names. Admins with no assigned repos are dropped — they have nothing to
     * report on.
     */
    async getRepoAdmins(
        organizationId: string,
    ): Promise<RepoAdminRecipient[]> {
        const users = await this.usersService.find(
            { organization: { uuid: organizationId }, role: Role.REPO_ADMIN },
            [STATUS.ACTIVE],
        );
        if (!users || users.length === 0) {
            return [];
        }

        const repoNames = await this.review.getRepositoryNames(organizationId);

        const recipients: RepoAdminRecipient[] = [];
        for (const user of users) {
            if (!user?.email) {
                continue;
            }
            const assignedIds: string[] =
                (user.permissions as any)?.permissions?.assignedRepositoryIds ??
                [];
            const repositories = assignedIds
                .map((id) => repoNames.get(id))
                .filter((name): name is string => Boolean(name));

            if (repositories.length === 0) {
                continue;
            }

            recipients.push({
                email: user.email,
                name: resolveDisplayName(user),
                repositories,
            });
        }
        return recipients;
    }
}

function resolveDisplayName(user: any): string {
    const teamName = user?.teamMember?.[0]?.name;
    if (typeof teamName === 'string' && teamName.trim()) {
        return teamName.trim().split(/\s+/)[0];
    }
    if (typeof user?.email === 'string') {
        return user.email.split('@')[0];
    }
    return 'there';
}

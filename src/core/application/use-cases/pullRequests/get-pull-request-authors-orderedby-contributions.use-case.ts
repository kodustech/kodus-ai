import { Inject, Injectable } from '@nestjs/common';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { PullRequestHandlerService } from '@/core/infrastructure/adapters/services/codeBase/pullRequestManager.service';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/PullRequestManagerService.contract';
import { ORGANIZATION_SERVICE_TOKEN } from '@/core/domain/organization/contracts/organization.service.contract';
import { IOrganizationService } from '@/core/domain/organization/contracts/organization.service.contract';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetPullRequestAuthorsUseCase {
    constructor(
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestHandlerService: PullRequestHandlerService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(organizationId?: string) {
        try {
            const orgId = organizationId ?? this.request.user.organization.uuid;

            const organizationAndTeamData = {
                organizationId: orgId,
            };

            const authors =
                await this.pullRequestHandlerService.getPullRequestsAuthorsOrderedByContributions(
                    organizationAndTeamData,
                );

            return authors;
        } catch (error) {
            throw error;
        }
    }
}

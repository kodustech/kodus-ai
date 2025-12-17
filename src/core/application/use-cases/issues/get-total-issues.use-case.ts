import { UserRequest } from '@/config/types/http/user-request.type';
import { KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/KodyIssuesManagement.contract';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@/core/domain/issues/contracts/issues.service.contract';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { KodyIssuesManagementService } from '@/core/infrastructure/adapters/services/kodyIssuesManagement/service/kodyIssuesManagement.service';
import { AuthorizationService } from '@/core/infrastructure/adapters/services/permissions/authorization.service';
import { GetIssuesByFiltersDto } from '@/core/infrastructure/http/dtos/get-issues-by-filters.dto';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetTotalIssuesUseCase implements IUseCase {
    constructor(
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,

        @Inject(KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN)
        private readonly kodyIssuesManagementService: KodyIssuesManagementService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(filters: GetIssuesByFiltersDto): Promise<number> {
        const newFilters: Parameters<
            typeof this.kodyIssuesManagementService.buildFilter
        >[0] = { ...filters };

        if (!newFilters?.organizationId) {
            newFilters.organizationId = this.request.user.organization.uuid;
        }

        const assignedRepositoryIds =
            await this.authorizationService.getRepositoryScope({
                user: this.request.user,
                action: Action.Read,
                resource: ResourceType.Issues,
            });

        if (assignedRepositoryIds !== null) {
            newFilters.repositoryIds = assignedRepositoryIds;
        }

        const filter =
            await this.kodyIssuesManagementService.buildFilter(newFilters);
        return this.issuesService.count(filter);
    }
}

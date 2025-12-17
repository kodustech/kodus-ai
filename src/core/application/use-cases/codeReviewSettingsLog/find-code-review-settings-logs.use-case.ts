import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@/core/infrastructure/adapters/services/permissions/authorization.service';
import { CodeReviewSettingsLogFiltersDto } from '@/core/infrastructure/http/dtos/code-review-settings-log-filters.dto';
import {
    CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN,
    ICodeReviewSettingsLogService,
} from '@/ee/codeReviewSettingsLog/domain/codeReviewSettingsLog/contracts/codeReviewSettingsLog.service.contract';
import { CodeReviewSettingsLogEntity } from '@/ee/codeReviewSettingsLog/domain/codeReviewSettingsLog/entities/codeReviewSettingsLog.entity';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export interface FindCodeReviewSettingsLogsResponse {
    logs: CodeReviewSettingsLogEntity[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
}

@Injectable()
export class FindCodeReviewSettingsLogsUseCase {
    constructor(
        @Inject(CODE_REVIEW_SETTINGS_LOG_SERVICE_TOKEN)
        private readonly codeReviewSettingsLogService: ICodeReviewSettingsLogService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { uuid: string; organization: { uuid: string } };
        },
        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(
        filters: CodeReviewSettingsLogFiltersDto,
    ): Promise<FindCodeReviewSettingsLogsResponse> {
        const { page = 1, limit = 100, skip, ...filterParams } = filters;

        const filter: any = {};

        filter.organizationId = this.request.user.organization.uuid;

        if (filterParams.teamId) {
            filter.teamId = filterParams.teamId;
        }

        if (filterParams.action) {
            filter.action = filterParams.action;
        }

        if (filterParams.configLevel) {
            filter.configLevel = filterParams.configLevel;
        }

        if (filterParams.userId) {
            filter['userInfo.userId'] = filterParams.userId;
        }

        if (filterParams.userEmail) {
            filter['userInfo.userEmail'] = filterParams.userEmail;
        }

        if (filterParams.repositoryId) {
            await this.authorizationService.ensure({
                user: this.request.user,
                action: Action.Read,
                resource: ResourceType.CodeReviewSettings,
                repoIds: [filterParams.repositoryId],
            });

            filter['repository.id'] = filterParams.repositoryId;
        }

        // Adicionar filtros de data se fornecidos
        if (filterParams.startDate || filterParams.endDate) {
            filter.createdAt = {};

            if (filterParams.startDate) {
                filter.createdAt.$gte = filterParams.startDate;
            }

            if (filterParams.endDate) {
                filter.createdAt.$lte = filterParams.endDate;
            }
        }

        const logs = await this.codeReviewSettingsLogService.find(filter);

        const assignedRepositoryIds =
            await this.authorizationService.getRepositoryScope({
                user: this.request.user,
                action: Action.Read,
                resource: ResourceType.Logs,
            });

        let filteredLogs = logs;
        if (assignedRepositoryIds !== null) {
            filteredLogs = logs.filter(
                (log) =>
                    log.repository?.id &&
                    assignedRepositoryIds.includes(log.repository.id),
            );
        }

        const total = filteredLogs.length;
        const totalPages = Math.ceil(total / limit);
        const startIndex = skip || (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedLogs = filteredLogs.slice(startIndex, endIndex);

        return {
            logs: paginatedLogs,
            total,
            page,
            limit,
            totalPages,
        };
    }
}

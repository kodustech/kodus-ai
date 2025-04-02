import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { ExecuteTeamArtifactsUseCase } from '../teamArtifacts/execute-teamArtifacts';
import { ExecuteOrganizationArtifactsUseCase } from '../organizationArtifacts/execute-organization-artifacts.use-case';
import { STATUS } from '@/config/types/database/status.type';
import { SaveCategoryWorkItemsTypesUseCase } from '../organizationParameters/save-category-workitems-types.use-case';
import { CreateOrUpdateParametersUseCase } from '../parameters/create-or-update-use-case';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { SaveAllTeamMetricsHistoryUseCase } from '../metrics/save-all-metrics-history.use-case';
import { SaveAllOrganizationMetricsHistoryUseCase } from '../organizationMetrics/save-metrics-history.use-case';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';

@Injectable()
export class FinishSetupUseCase {
    constructor(
        private readonly teamArtifactsUseCase: ExecuteTeamArtifactsUseCase,
        private readonly organizationArtifactsUseCase: ExecuteOrganizationArtifactsUseCase,
        private readonly saveCategoryWorkItemsTypesUseCase: SaveCategoryWorkItemsTypesUseCase,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly saveAllTeamMetricsHistoryUseCase: SaveAllTeamMetricsHistoryUseCase,
        private readonly saveAllOrganizationMetricsHistoryUseCase: SaveAllOrganizationMetricsHistoryUseCase,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(teamId: string): Promise<any> {
        const team = await this.teamService.findById(teamId);

        if (!team) {
            return {
                started: false,
                message: 'Team not found.',
            };
        }

        await this.teamService.update(
            { uuid: team.uuid },
            { status: STATUS.ACTIVE },
        );

        const organizationId = this.request.user?.organization?.uuid;

        await this.saveCategoryWorkItemsTypesUseCase
            .execute({
                organizationId: organizationId,
                teamId: teamId,
            })
            .then(async () => {
                await this.saveAllTeamMetricsHistoryUseCase
                    .execute(teamId)
                    .then(async () => {
                        await this.saveAllOrganizationMetricsHistoryUseCase
                            .execute(organizationId)
                            .then(async () => {
                                await Promise.all([
                                    this.teamArtifactsUseCase.execute({
                                        teamId: team?.uuid,
                                        organizationId: organizationId,
                                        type: 'daily',
                                    }),
                                    this.teamArtifactsUseCase.execute({
                                        teamId: team?.uuid,
                                        organizationId: organizationId,
                                        type: 'weekly',
                                    }),
                                ]).then(async () => {
                                    await Promise.all([
                                        this.organizationArtifactsUseCase.execute(
                                            {
                                                organizationId: organizationId,
                                                type: 'daily',
                                            },
                                        ),
                                        this.organizationArtifactsUseCase.execute(
                                            {
                                                organizationId: organizationId,
                                                type: 'weekly',
                                            },
                                        ),
                                    ]);
                                });
                            })
                            .then(async () => {
                                await this.createOrUpdateParametersUseCase.execute(
                                    ParametersKey.CODE_REVIEW_CONFIG,
                                    {
                                        ignorePaths: [
                                            'packages.json',
                                            'package-lock.json',
                                            '.env',
                                            'yarn.lock',
                                        ],
                                        reviewOptions: {
                                            security: true,
                                            code_style: true,
                                            refactoring: true,
                                            error_handling: true,
                                            maintainability: true,
                                            potential_issues: true,
                                            documentation_and_comments: true,
                                            performance_and_optimization: true,
                                            kody_rules: true,
                                        },
                                        limitationType: 'pr',
                                        maxSuggestions: 8,
                                        severityLevelFilter:
                                            SeverityLevel.MEDIUM,
                                    },
                                    {
                                        teamId: teamId,
                                        organizationId: organizationId,
                                    },
                                );
                            });

                        await this.createOrUpdateParametersUseCase.execute(
                            ParametersKey.CHECKIN_CONFIG,
                            this.prepareCheckinConfig(),
                            {
                                teamId: teamId,
                                organizationId: organizationId,
                            },
                        );
                    });
            });

        return {
            started: true,
            message: 'Setup completed successfully.',
        };
    }

    private prepareCheckinConfig() {
        return [
            {
                checkinId: 'weekly-checkin',
                checkinName: 'Weekly Check-in',
                frequency: {
                    sun: false,
                    mon: false,
                    tue: false,
                    wed: false,
                    thu: false,
                    fri: true,
                    sat: false,
                },
                sections: [
                    { id: 'teamDoraMetrics', order: 1, active: true },
                    { id: 'teamFlowMetrics', order: 2, active: true },
                    { id: 'releaseNotes', order: 3, active: true },
                    { id: 'lateWorkItems', order: 4, active: true },
                    { id: 'teamArtifacts', order: 5, active: true },
                    { id: 'pullRequestsOpened', order: 6, active: true },
                ],
                checkinTime: '14:00',
            },
            {
                checkinId: 'daily-checkin',
                checkinName: 'Daily Check-in',
                frequency: {
                    sun: false,
                    mon: true,
                    tue: true,
                    wed: true,
                    thu: true,
                    fri: true,
                    sat: false,
                },
                sections: [
                    { id: 'lateWorkItems', order: 1, active: true },
                    { id: 'pullRequestsOpened', order: 2, active: true },
                    { id: 'teamArtifacts', order: 3, active: true },
                    { id: 'releaseNotes', order: 4, active: false },
                    { id: 'teamDoraMetrics', order: 5, active: false },
                    { id: 'teamFlowMetrics', order: 6, active: false },
                ],
                checkinTime: '12:00',
            },
        ];
    }
}

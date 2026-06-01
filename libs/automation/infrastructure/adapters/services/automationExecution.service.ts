import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import {
    AUTOMATION_EXECUTION_REPOSITORY_TOKEN,
    IAutomationExecutionRepository,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.repository';
import { IAutomationExecutionService } from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationExecutionEntity } from '@libs/automation/domain/automationExecution/entities/automation-execution.entity';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';
import {
    CODE_REVIEW_EXECUTION_SERVICE,
    ICodeReviewExecutionService,
} from '@libs/automation/domain/codeReviewExecutions/contracts/codeReviewExecution.service.contract';
import { CodeReviewExecutionEntity } from '@libs/automation/domain/codeReviewExecutions/entities/codeReviewExecution.entity';
import { CodeReviewExecution } from '@libs/automation/domain/codeReviewExecutions/interfaces/codeReviewExecution.interface';
import { CacheService } from '@libs/core/cache/cache.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const PR_EXECUTION_UPDATED_EVENT = 'pr-execution.updated';

@Injectable()
export class AutomationExecutionService implements IAutomationExecutionService {
    private readonly logger = createLogger(AutomationExecutionService.name);
    constructor(
        @Inject(AUTOMATION_EXECUTION_REPOSITORY_TOKEN)
        private readonly automationExecutionRepository: IAutomationExecutionRepository,
        @Inject(CODE_REVIEW_EXECUTION_SERVICE)
        private readonly codeReviewExecutionService: ICodeReviewExecutionService<IAutomationExecution>,
        private readonly cacheService: CacheService,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    private emitExecutionUpdate(execution: AutomationExecutionEntity) {
        try {
            const orgId =
                execution?.dataExecution?.organizationAndTeamData
                    ?.organizationId;
            if (orgId) {
                this.eventEmitter.emit(PR_EXECUTION_UPDATED_EVENT, {
                    organizationId: orgId,
                    executionUuid: execution.uuid,
                    status: execution.status,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch {
            // fire-and-forget
        }
    }

    findLatestExecutionByFilters(
        filters?: Partial<any>,
    ): Promise<AutomationExecutionEntity | null> {
        return this.automationExecutionRepository.findLatestExecutionByFilters(
            filters,
        );
    }

    async findOneByOrganizationIdAndIssueId(
        organizationId: string,
        issueId: string,
    ): Promise<boolean> {
        const automation = await this.automationExecutionRepository.find();

        return automation?.some(
            (item) =>
                item?.dataExecution?.issueId === issueId &&
                item?.dataExecution?.organizationId === organizationId,
        );
    }

    async create(
        automationExecution: Omit<IAutomationExecution, 'uuid'>,
    ): Promise<AutomationExecutionEntity> {
        const result =
            await this.automationExecutionRepository.create(
                automationExecution,
            );

        try {
            await this.cacheService.deleteByKeyPattern(
                '/pull-requests/executions*',
            );
            this.logger.log({
                message:
                    'Cache invalidated after automation execution creation',
                context: AutomationExecutionService.name,
                metadata: { executionUuid: result?.uuid },
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to invalidate cache after automation execution creation',
                context: AutomationExecutionService.name,
                error,
                metadata: { executionUuid: result?.uuid },
            });
        }

        if (result) {
            this.emitExecutionUpdate(result);
        }

        return result;
    }

    async update(
        filter: Partial<IAutomationExecution>,
        data: Omit<
            Partial<IAutomationExecution>,
            'uuid' | 'createdAt' | 'updatedAt'
        >,
    ): Promise<AutomationExecutionEntity | null> {
        const result = await this.automationExecutionRepository.update(
            filter,
            data,
        );
        if (result) {
            this.emitExecutionUpdate(result);
        }
        return result;
    }

    delete(uuid: string): Promise<void> {
        return this.automationExecutionRepository.delete(uuid);
    }

    findById(uuid: string): Promise<AutomationExecutionEntity> {
        return this.automationExecutionRepository.findById(uuid);
    }

    find(
        filter?: Partial<IAutomationExecution>,
    ): Promise<AutomationExecutionEntity[]> {
        return this.automationExecutionRepository.find(filter);
    }

    findPullRequestExecutionsByOrganizationAndTeam(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds?: string[];
        repositoryName?: string;
        pullRequestNumber?: number;
        pullRequestTitle?: string;
        prFilters?: Array<{ number: number; repositoryId: string }>;
        skip?: number;
        take?: number;
        order?: 'ASC' | 'DESC';
        includeTotal?: boolean;
    }): Promise<{ data: AutomationExecutionEntity[]; total: number }> {
        return this.automationExecutionRepository.findPullRequestExecutionsByOrganizationAndTeam(
            params,
        );
    }

    findCliReviewExecutionsByOrganization(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        userEmail?: string;
        since?: Date;
        skip?: number;
        take?: number;
        order?: 'ASC' | 'DESC';
        includeTotal?: boolean;
    }): Promise<{ data: AutomationExecutionEntity[]; total: number }> {
        return this.automationExecutionRepository.findCliReviewExecutionsByOrganization(
            params,
        );
    }

    findByPeriodAndTeamAutomationId(
        startDate: Date,
        endDate: Date,
        teamAutomationId: string,
        status?: string | string[],
    ): Promise<AutomationExecutionEntity[]> {
        return this.automationExecutionRepository.findByPeriodAndTeamAutomationId(
            startDate,
            endDate,
            teamAutomationId,
            status,
        );
    }

    findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
        startDate: Date,
        endDate: Date,
        teamAutomationId: string,
    ): Promise<Array<{ repositoryId: string; pullRequestNumber: number }>> {
        return this.automationExecutionRepository.findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
            startDate,
            endDate,
            teamAutomationId,
        );
    }

    async createCodeReview(
        automationExecution: Omit<IAutomationExecution, 'uuid'>,
        message: string,
        stageName?: string,
        metadata?: Record<string, any>,
    ): Promise<{
        execution: AutomationExecutionEntity;
        stageLog?: CodeReviewExecutionEntity<IAutomationExecution>;
    } | null> {
        try {
            if (!automationExecution || !automationExecution.status) {
                this.logger.warn({
                    message: 'Invalid parameters provided to createCodeReview',
                    context: AutomationExecutionService.name,
                    metadata: { automationExecution, message, stageName },
                });
                return null;
            }

            const newAutomationExecution =
                await this.automationExecutionRepository.create(
                    automationExecution,
                );

            if (!newAutomationExecution) {
                this.logger.warn({
                    message:
                        'Failed to create automation execution before creating code review',
                    context: AutomationExecutionService.name,
                    metadata: { automationExecution, message, stageName },
                });
                return null;
            }

            const stageLog = await this.codeReviewExecutionService.create({
                automationExecution: {
                    uuid: newAutomationExecution.uuid,
                },
                status: automationExecution.status,
                message,
                stageName,
                metadata,
            });

            this.emitExecutionUpdate(newAutomationExecution);

            return {
                execution: newAutomationExecution,
                stageLog: stageLog || undefined,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error creating automation execution with code review',
                error,
                context: AutomationExecutionService.name,
                metadata: { automationExecution, message, stageName },
            });
            return null;
        }
    }

    async updateCodeReview(
        filter: Partial<IAutomationExecution>,
        automationExecution: Partial<
            Omit<IAutomationExecution, 'uuid' | 'createdAt' | 'updatedAt'>
        >,
        message: string,
        stageName?: string,
        metadata?: Record<string, any>,
    ): Promise<{
        execution: AutomationExecutionEntity;
        stageLog?: CodeReviewExecutionEntity<IAutomationExecution>;
    } | null> {
        try {
            if (
                !filter ||
                !automationExecution ||
                !automationExecution.status
            ) {
                this.logger.warn({
                    message: 'Invalid parameters provided to updateCodeReview',
                    context: AutomationExecutionService.name,
                    metadata: {
                        filter,
                        message,
                        automationExecution,
                        stageName,
                    },
                });
                return null;
            }

            const updatedAutomationExecution =
                await this.automationExecutionRepository.update(
                    filter,
                    automationExecution,
                );

            if (!updatedAutomationExecution) {
                this.logger.warn({
                    message:
                        'Failed to update automation execution before updating code review',
                    context: AutomationExecutionService.name,
                    metadata: {
                        filter,
                        message,
                        automationExecution,
                        stageName,
                    },
                });
                return null;
            }

            const stageLog = await this.codeReviewExecutionService.create({
                automationExecution: {
                    uuid: updatedAutomationExecution.uuid,
                },
                status: automationExecution.status,
                message,
                stageName,
                metadata,
            });

            this.emitExecutionUpdate(updatedAutomationExecution);

            return {
                execution: updatedAutomationExecution,
                stageLog: stageLog || undefined,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error updating automation execution with code review',
                error,
                context: AutomationExecutionService.name,
                metadata: {
                    filter,
                    message,
                    automationExecution,
                    stageName,
                },
            });
            return null;
        }
    }

    async updateStageLog(
        uuid: string,
        data: Partial<
            Omit<
                CodeReviewExecution<IAutomationExecution>,
                'uuid' | 'createdAt' | 'updatedAt'
            >
        >,
    ): Promise<void> {
        try {
            await this.codeReviewExecutionService.updateById(uuid, data);
        } catch (error) {
            this.logger.error({
                message: 'Error updating stage log',
                error,
                context: AutomationExecutionService.name,
                metadata: { uuid, data },
            });
        }
    }

    async findLatestStageLog(
        executionId: string,
        stageName: string,
    ): Promise<CodeReviewExecutionEntity<IAutomationExecution> | null> {
        return this.codeReviewExecutionService.findLatestInProgress(
            executionId,
            stageName,
        );
    }

    async hasStageWithStatus(
        executionId: string,
        stageNames: string[],
        statuses: AutomationStatus[],
    ): Promise<boolean> {
        if (!executionId || stageNames.length === 0 || statuses.length === 0) {
            return false;
        }

        return this.codeReviewExecutionService.existsByAutomationExecutionAndStageStatus(
            executionId,
            stageNames,
            statuses,
        );
    }
}

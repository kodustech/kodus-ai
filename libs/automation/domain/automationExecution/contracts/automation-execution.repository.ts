import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { AutomationExecutionEntity } from '../entities/automation-execution.entity';
import { IAutomationExecution } from '../interfaces/automation-execution.interface';

export const AUTOMATION_EXECUTION_REPOSITORY_TOKEN = Symbol(
    'AutomationExecutionRepository',
);

export interface IAutomationExecutionRepository {
    create(
        automationExecution: Omit<IAutomationExecution, 'uuid'>,
    ): Promise<AutomationExecutionEntity | null>;
    update(
        filter: Partial<IAutomationExecution>,
        data: Omit<
            Partial<IAutomationExecution>,
            'uuid' | 'createdAt' | 'updatedAt'
        >,
    ): Promise<AutomationExecutionEntity | null>;
    delete(uuid: string): Promise<void>;
    findById(uuid: string): Promise<AutomationExecutionEntity | null>;
    find(
        filter?: Partial<IAutomationExecution>,
    ): Promise<AutomationExecutionEntity[]>;
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
    }): Promise<{
        data: AutomationExecutionEntity[];
        total: number;
    }>;
    findCliReviewExecutionsByOrganization(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        userEmail?: string;
        since?: Date;
        skip?: number;
        take?: number;
        order?: 'ASC' | 'DESC';
        includeTotal?: boolean;
    }): Promise<{
        data: AutomationExecutionEntity[];
        total: number;
    }>;
    findLatestExecutionByFilters(
        filters?: Partial<any>,
    ): Promise<AutomationExecutionEntity | null>;
    findByPeriodAndTeamAutomationId(
        startDate: Date,
        endDate: Date,
        teamAutomationId: string,
        status?: string | string[],
    ): Promise<AutomationExecutionEntity[]>;
    findEligiblePullRequestRefsForApprovalByPeriodAndTeamAutomationId(
        startDate: Date,
        endDate: Date,
        teamAutomationId: string,
    ): Promise<Array<{ repositoryId: string; pullRequestNumber: number }>>;
}

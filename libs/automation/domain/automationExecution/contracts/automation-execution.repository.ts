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
        status?: string;
        createdAtFrom?: string;
        createdAtTo?: string;
        skip?: number;
        cursor?: { createdAt: string | Date; uuid: string };
        take?: number;
        order?: 'ASC' | 'DESC';
        includeTotal?: boolean;
    }): Promise<{
        data: AutomationExecutionEntity[];
        total: number;
        // Distinct PRs matching the DB-level filters (only with includeTotal).
        distinctPrTotal: number;
    }>;
    getDistinctReviewedPullRequestKeys(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds?: string[];
        createdAtFrom?: Date | string;
    }): Promise<
        Array<{
            repositoryId: string;
            pullRequestNumber: number;
            hasError: boolean;
        }>
    >;
    // Distinct PRs still awaiting their first review: every execution for the PR
    // was 'skipped' (no license, BYOK, manual/paused cadence, ignored user…) and
    // none ran a review. Drives the Awaiting facet, sourced from execution rows.
    getAwaitingReviewPullRequestKeys(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds?: string[];
        createdAtFrom?: Date | string;
    }): Promise<Array<{ repositoryId: string; pullRequestNumber: number }>>;
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
    findStaleInProgress(
        cutoffDate: Date,
        limit?: number,
        options?: { excludeOrigins?: string[] },
    ): Promise<AutomationExecutionEntity[]>;
    // Liveness heartbeat: bumps `updatedAt` of a still-IN_PROGRESS row so
    // the "review already running" gate can tell a live run from one whose
    // process died without a terminal update.
    touchInProgress(uuid: string): Promise<void>;
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
    ): Promise<
        Array<{
            repositoryId: string;
            pullRequestNumber: number;
            mayAllowNoComments: boolean;
        }>
    >;
}

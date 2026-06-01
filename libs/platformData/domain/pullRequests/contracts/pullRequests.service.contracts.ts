import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { IPullRequestsRepository } from './pullRequests.repository';
import { PullRequestsEntity } from '../entities/pullRequests.entity';
import {
    ICommit,
    IPullRequests,
    IPullRequestUser,
    IPullRequestUserMapping,
    ISuggestion,
    ISuggestionByPR,
} from '../interfaces/pullRequests.interface';

export const PULL_REQUESTS_SERVICE_TOKEN = Symbol.for('PullRequestsService');

export interface IPullRequestsService extends IPullRequestsRepository {
    create(
        suggestion: Omit<IPullRequests, 'uuid'>,
    ): Promise<PullRequestsEntity>;

    findById(uuid: string): Promise<PullRequestsEntity | null>;
    findOne(
        filter?: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null>;
    find(filter?: Partial<IPullRequests>): Promise<PullRequestsEntity[]>;

    updateSuggestion(
        suggestionId: string,
        updateData: Partial<ISuggestion>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;

    aggregateAndSaveDataStructure(
        pullRequest: any,
        repository: any,
        changedFiles: Array<any>,
        prioritizedSuggestions: Partial<ISuggestion>[],
        unusedSuggestions: Partial<ISuggestion>[],
        platformType: string,
        organizationAndTeamData: OrganizationAndTeamData,
        commits: ICommit[],
    ): Promise<IPullRequests | null>;

    extractUser(
        data: any,
        organizationAndTeamData: OrganizationAndTeamData,
        platformType: PlatformType,
        prNumber: number,
    ): Promise<IPullRequestUser | null>;
    extractUsers(
        data: any,
        organizationAndTeamData: OrganizationAndTeamData,
        platformType: PlatformType,
        prNumber: number,
    ): Promise<Array<IPullRequestUser>>;

    addPrLevelSuggestions(
        pullRequestNumber: number,
        repositoryName: string,
        prLevelSuggestions: ISuggestionByPR[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;

    findManyByNumbersAndRepositoryIds(
        criteria: Array<{
            number: number;
            repositoryId: string;
        }>,
        organizationId: string,
    ): Promise<PullRequestsEntity[]>;

    /**
     * PERF: Batch fetch PRs by organization and PR numbers only.
     * Used for token usage by developer queries where repositoryId is not available.
     * Returns only fields needed for developer mapping (number, user, organizationId).
     */
    findManyByNumbers(
        prNumbers: number[],
        organizationId: string,
    ): Promise<IPullRequestUserMapping[]>;

    getOnboardingReviewModeSignals(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds: string[];
        limit?: number;
    }): Promise<
        Array<{
            repositoryId: string;
            sampleSize: number;
            metrics: Record<string, number>;
            recommendation: {
                mode: 'Safety' | 'Speed' | 'Coach' | 'Default';
                reasons: string[];
            };
        }>
    >;
}

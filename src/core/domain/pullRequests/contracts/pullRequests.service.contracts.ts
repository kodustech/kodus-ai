import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { PullRequestsEntity } from '../entities/pullRequests.entity';
import {
    ICommit,
    IPullRequests,
    IPullRequestUser,
    ISuggestion,
    ISuggestionByPR,
} from '../interfaces/pullRequests.interface';
import { IPullRequestsRepository } from './pullRequests.repository';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export const PULL_REQUESTS_SERVICE_TOKEN = Symbol('PullRequestsService');

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

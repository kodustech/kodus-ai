import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { PullRequestsEntity } from '../entities/pullRequests.entity';
import {
    ICommit,
    IPullRequests,
    IPullRequestUser,
    ISuggestion,
} from '../interfaces/pullRequests.interface';
import { IPullRequestsRepository } from './pullRequests.repository';
import { Repository } from '@/config/types/general/codeReview.type';

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
        organizationId: string,
        commits: ICommit[],
    ): Promise<IPullRequests | null>;

    extractUser(
        data: any,
        organizationId: string,
        platformType: PlatformType,
        prNumber: number,
    ): Promise<IPullRequestUser | null>;
    extractUsers(
        data: any,
        organizationId: string,
        platformType: PlatformType,
        prNumber: number,
    ): Promise<Array<IPullRequestUser>>;
}

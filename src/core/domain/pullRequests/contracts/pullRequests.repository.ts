import { PullRequestsEntity } from '../entities/pullRequests.entity';
import {
    IPullRequests,
    IFile,
    ISuggestion,
} from '../interfaces/pullRequests.interface';
import { DeliveryStatus } from '../enums/deliveryStatus.enum';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import { Repository } from '@/config/types/general/codeReview.type';

export const PULL_REQUESTS_REPOSITORY_TOKEN = Symbol('PullRequestsRepository');

export interface IPeriodFilter {
    startDate: Date;
    endDate: Date;
    dateType: 'created' | 'updated';
}

export interface IPullRequestsRepository {
    getNativeCollection(): any;

    create(
        suggestion: Omit<IPullRequests, 'uuid'>,
    ): Promise<PullRequestsEntity>;

    findById(uuid: string): Promise<PullRequestsEntity | null>;
    findOne(
        filter?: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null>;
    find(filter?: Partial<IPullRequests>): Promise<PullRequestsEntity[]>;
    findByNumberAndRepository(
        prNumber: number,
        repositoryName: string,
    ): Promise<PullRequestsEntity | null>;
    findFileWithSuggestions(
        prnumber: number,
        repositoryName: string,
        filePath: string,
    ): Promise<IFile | null>;
    findSuggestionsByPRAndFilename(
        prNumber: number,
        repoFullName: string,
        filename: string,
    ): Promise<ISuggestion[]>;
    findSuggestionsByPR(
        organizationId: string,
        prNumber: number,
        deliveryStatus: DeliveryStatus,
    ): Promise<ISuggestion[]>;
    findByOrganizationAndRepositoryWithStatusAndSyncedFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
    ): Promise<IPullRequests[]>;

    addFileToPullRequest(
        pullRequestNumber: number,
        repositoryName: string,
        newFile: Omit<IFile, 'id'>,
    ): Promise<PullRequestsEntity | null>;
    addSuggestionToFile(
        fileId: string,
        newSuggestion: Omit<ISuggestion, 'id'>,
        pullRequestNumber: number,
        repositoryName: string,
    ): Promise<PullRequestsEntity | null>;

    update(
        pullRequest: PullRequestsEntity,
        updateData: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null>;
    updateFile(
        fileId: string,
        updateData: Partial<IFile>,
    ): Promise<PullRequestsEntity | null>;
    updateSuggestion(
        suggestionId: string,
        updateData: Partial<ISuggestion>,
    ): Promise<PullRequestsEntity | null>;
    updateSyncedSuggestionsFlag(
        pullRequestNumber: number,
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<PullRequestsEntity | null>;
}

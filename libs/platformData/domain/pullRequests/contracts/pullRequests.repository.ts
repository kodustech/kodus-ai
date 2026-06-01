import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { Repository } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { PullRequestsEntity } from '../entities/pullRequests.entity';
import { DeliveryStatus } from '../enums/deliveryStatus.enum';
import {
    IPullRequests,
    IFile,
    ISuggestion,
    IPullRequestWithDeliveredSuggestions,
    IPullRequestUserMapping,
} from '../interfaces/pullRequests.interface';

export const PULL_REQUESTS_REPOSITORY_TOKEN = Symbol.for(
    'PullRequestsRepository',
);

export interface IPeriodFilter {
    startDate: Date;
    endDate: Date;
    dateType: 'created' | 'updated';
}

/**
 * Domain-level operation accepted by `bulkApplyFileChanges`.
 *
 * The repository translates each variant into a Mongo `bulkWrite`
 * op. Variants are intentionally narrow:
 *  - `addFile` pushes a new file onto `files`.
 *  - `updateFile` updates the matched file's primitive fields
 *    in-place via positional `$` operator (no suggestion mutation).
 *  - `addSuggestions` pushes one or more suggestions onto an
 *    existing file's `suggestions` array.
 *
 * The caller is responsible for pre-computing ids (see
 * `newSubDocumentId`) so that downstream reads can reference them.
 */
export type FileBulkOp =
    | { kind: 'addFile'; file: IFile }
    | {
          kind: 'updateFile';
          fileId: string;
          data: Partial<Omit<IFile, 'id' | 'suggestions'>>;
      }
    | { kind: 'addSuggestions'; fileId: string; suggestions: ISuggestion[] };

export interface BulkApplyError {
    opIndex: number;
    code?: number;
    message: string;
}

export interface BulkApplyResult {
    attempted: number;
    modified: number;
    errors: BulkApplyError[];
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
    findPRNumbersByTitleAndOrganization(
        title: string,
        organizationId: string,
        repositoryIds?: string[],
    ): Promise<Array<{ number: number; repositoryId: string }>>;
    findByNumberAndRepositoryName(
        prNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    findByNumberAndRepositoryId(
        prNumber: number,
        repositoryId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    findByNumberAndRepositoryIdOptimized(
        prNumber: number,
        repositoryId: string,
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

    /**
     * PERF: Aggregation query that returns only suggestion counts.
     * Reduces data transfer from ~180k objects to just counts per PR.
     *
     * @returns Map keyed by `${repositoryId}_${prNumber}` with counts
     */
    findSuggestionCountsByNumbersAndRepositoryIds(
        criteria: Array<{
            number: number;
            repositoryId: string;
        }>,
        organizationId: string,
    ): Promise<Map<string, { sent: number; filtered: number }>>;
    findFileWithSuggestions(
        prnumber: number,
        repositoryName: string,
        filePath: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IFile | null>;
    findSuggestionsByPRAndFilename(
        prNumber: number,
        repoFullName: string,
        filename: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ISuggestion[]>;
    findSuggestionsByPR(
        organizationId: string,
        prNumber: number,
        deliveryStatus: DeliveryStatus,
    ): Promise<ISuggestion[]>;
    findSuggestionsByRuleId(
        ruleId: string,
        organizationId: string,
    ): Promise<ISuggestion[]>;
    findPullRequestsWithDeliveredSuggestions(
        organizationId: string,
        prNumbers: number[],
        status: string | string[],
    ): Promise<IPullRequestWithDeliveredSuggestions[]>;
    findByOrganizationAndRepositoryWithStatusAndSyncedFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
    ): Promise<IPullRequests[]>;
    findByOrganizationAndRepositoryWithStatusAndSyncedWithIssuesFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
    ): Promise<IPullRequests[]>;

    addFileToPullRequest(
        pullRequestNumber: number,
        repositoryName: string,
        newFile: Omit<IFile, 'id'>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;

    /**
     * Issue #1107: collapse the N+1 file/suggestion loop into a
     * single set of chunked `bulkWrite` calls. See impl for details.
     *
     * `organizationId` is part of the filter on every chunked op so
     * a stale or malformed `prUuid` from one tenant can never write
     * to another tenant's document.
     */
    bulkApplyFileChanges(
        prUuid: string,
        organizationId: string,
        ops: FileBulkOp[],
    ): Promise<BulkApplyResult>;

    /**
     * Server-side aggregation over `files.added/deleted/changes`.
     * Used to recompute PR totals from ground truth without reading
     * the full sub-document array. Tenant-scoped — see
     * `bulkApplyFileChanges` for the rationale.
     */
    computeFileTotals(
        prUuid: string,
        organizationId: string,
    ): Promise<{
        totalAdded: number;
        totalDeleted: number;
        totalChanges: number;
    }>;


    /** Generates a stable id for file/suggestion sub-documents. */
    newSubDocumentId(): string;

    addSuggestionToFile(
        fileId: string,
        newSuggestion: Omit<ISuggestion, 'id'>,
        pullRequestNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    findRecentByRepositoryId(
        organizationId: string,
        repositoryId: string,
        limit?: number,
    ): Promise<PullRequestsEntity[]>;

    update(
        pullRequest: PullRequestsEntity,
        updateData: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null>;
    updateFile(
        fileId: string,
        updateData: Partial<IFile>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    updateSuggestion(
        suggestionId: string,
        updateData: Partial<ISuggestion>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    updateSyncedSuggestionsFlag(
        pullRequestNumbers: number[],
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void>;
    updateSyncedWithIssuesFlag(
        prNumber: number,
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void>;
}

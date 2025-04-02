import { Entity } from '@/shared/domain/interfaces/entity';
import {
    ICommit,
    IFile,
    IPullRequests,
    IPullRequestUser,
    IRepository,
} from '../interfaces/pullRequests.interface';

export class PullRequestsEntity implements Entity<IPullRequests> {
    private readonly _uuid: string;
    private readonly _createdAt: string;
    private readonly _updatedAt: string;
    private readonly _title: string;
    private readonly _status: string;
    private readonly _merged: boolean;
    private readonly _number: number;
    private readonly _url: string;
    private readonly _baseBranchRef: string;
    private readonly _headBranchRef: string;
    private readonly _repository: {
        id: string;
        name: string;
        fullName: string;
        language: string;
        url: string;
        createdAt: string;
        updatedAt: string;
    };
    private readonly _openedAt: string;
    private readonly _closedAt: string;
    private readonly _files: Array<IFile>;
    private readonly _totalAdded: number;
    private readonly _totalDeleted: number;
    private readonly _totalChanges: number;
    private readonly _provider: string;
    private readonly _user: IPullRequestUser;
    private readonly _reviewers: Array<IPullRequestUser>;
    private readonly _assignees: Array<IPullRequestUser>;
    private readonly _organizationId: string;
    private readonly _commits: Array<ICommit>;
    private readonly _syncedEmbeddedSuggestions: boolean;

    constructor(pullRequest: IPullRequests) {
        this._uuid = pullRequest.uuid;
        this._createdAt = pullRequest.createdAt;
        this._updatedAt = pullRequest.updatedAt;
        this._title = pullRequest.title;
        this._status = pullRequest.status;
        this._merged = pullRequest.merged;
        this._number = pullRequest.number;
        this._url = pullRequest.url;
        this._baseBranchRef = pullRequest.baseBranchRef;
        this._headBranchRef = pullRequest.headBranchRef;
        this._repository = pullRequest.repository;
        this._openedAt = pullRequest.openedAt;
        this._closedAt = pullRequest.closedAt;
        this._files = pullRequest.files;
        this._totalAdded = pullRequest.totalAdded;
        this._totalDeleted = pullRequest.totalDeleted;
        this._totalChanges = pullRequest.totalChanges;
        this._provider = pullRequest.provider;
        this._user = pullRequest.user;
        this._reviewers = pullRequest.reviewers;
        this._assignees = pullRequest.assignees;
        this._organizationId = pullRequest.organizationId;
        this._commits = Array.isArray(pullRequest.commits) ? [...pullRequest.commits] : [];
        this._syncedEmbeddedSuggestions = pullRequest.syncedEmbeddedSuggestions;
    }

    toJson(): IPullRequests {
        return {
            uuid: this._uuid,
            title: this._title,
            status: this._status,
            merged: this._merged,
            number: this._number,
            url: this._url,
            baseBranchRef: this._baseBranchRef,
            headBranchRef: this._headBranchRef,
            repository: this._repository,
            openedAt: this._openedAt,
            closedAt: this._closedAt,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
            files: this._files,
            totalAdded: this._totalAdded,
            totalDeleted: this._totalDeleted,
            totalChanges: this._totalChanges,
            provider: this._provider,
            user: this._user,
            reviewers: this._reviewers,
            assignees: this._assignees,
            organizationId: this._organizationId,
            commits: this._commits,
            syncedEmbeddedSuggestions: this._syncedEmbeddedSuggestions,
        };
    }

    toObject(): IPullRequests {
        return {
            uuid: this._uuid,
            createdAt: this._createdAt,
            updatedAt: this._updatedAt,
            title: this._title,
            status: this._status,
            merged: this._merged,
            number: this._number,
            url: this._url,
            baseBranchRef: this._baseBranchRef,
            headBranchRef: this._headBranchRef,
            repository: this._repository,
            openedAt: this._openedAt,
            closedAt: this._closedAt,
            files: this._files,
            totalAdded: this._totalAdded,
            totalDeleted: this._totalDeleted,
            totalChanges: this._totalChanges,
            provider: this._provider,
            user: this._user,
            reviewers: this._reviewers,
            assignees: this._assignees,
            organizationId: this._organizationId,
            commits: this._commits,
            syncedEmbeddedSuggestions: this._syncedEmbeddedSuggestions,
        };
    }

    public static create(pullRequest: IPullRequests): PullRequestsEntity {
        return new PullRequestsEntity(pullRequest);
    }

    get uuid(): string {
        return this._uuid;
    }

    get createdAt(): string {
        return this._createdAt;
    }

    get updatedAt(): string {
        return this._updatedAt;
    }

    get title(): string {
        return this._title;
    }

    get status(): string {
        return this._status;
    }

    get merged(): boolean {
        return this._merged;
    }

    get number(): number {
        return this._number;
    }

    get url(): string {
        return this._url;
    }

    get baseBranchRef(): string {
        return this._baseBranchRef;
    }

    get headBranchRef(): string {
        return this._headBranchRef;
    }

    get repository(): IRepository {
        return this._repository;
    }

    get files(): Array<IFile> {
        return [...this._files];
    }

    get openedAt(): string {
        return this._openedAt;
    }

    get closedAt(): string {
        return this._closedAt;
    }

    get totalAdded(): number {
        return this._totalAdded;
    }

    get totalDeleted(): number {
        return this._totalDeleted;
    }

    get totalChanges(): number {
        return this._totalChanges;
    }

    get provider(): string {
        return this._provider;
    }

    get user(): IPullRequestUser {
        return this._user;
    }

    get reviewers(): Array<IPullRequestUser> {
        return [...this._reviewers];
    }

    get assignees(): Array<IPullRequestUser> {
        return [...this._assignees];
    }

    get organizationId(): string {
        return this._organizationId;
    }

    get commits(): Array<ICommit> {
        return [...this._commits];
    }

    get syncedEmbeddedSuggestions(): boolean {
        return this._syncedEmbeddedSuggestions;
    }

}

import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { IssuesEntity } from '../entities/issues.entity';
import { IIssue } from '../interfaces/issues.interface';
import { IContributingSuggestion } from '../interfaces/kodyIssuesManagement.interface';

export const ISSUES_REPOSITORY_TOKEN = Symbol.for('IssuesRepository');

/**
 * What a security scan did to the issue behind one finding: opened it, found
 * it still open, reopened one a later change had resolved, or left alone one a
 * person dismissed.
 */
/**
 * `merged`: a second finding with the same identity in the same scan (two
 * injections in one function), added to the issue as another occurrence.
 */
export type ScanFindingOutcome =
    | 'created'
    | 'still_open'
    | 'reopened'
    | 'dismissed'
    | 'merged';

export type ScanFindingUpsert = Omit<
    IIssue,
    | 'uuid'
    | 'status'
    | 'contributingSuggestions'
    | 'createdAt'
    | 'updatedAt'
    | 'source'
    | 'lastSeenAt'
    | 'resolvedAt'
> & {
    fingerprint: string;
    lastSeenScanId: string;
};

/** One repository, as a scan names it: an id is only unique on its platform. */
export interface ScanRepositoryScope {
    organizationId: string;
    repositoryPlatform: PlatformType;
    repositoryId: string;
}

/** A file and a class an open scan finding sits at. */
export interface OpenScanFindingArea {
    filePath: string;
    vulnerabilityClass: string;
}

export interface ResolveUnseenScanFindingsParams extends ScanRepositoryScope {
    scanId: string;
    /**
     * What this scan examined, class by class. A scan stopped by its budget
     * never looked at the other files, and a lens that failed never looked
     * for its class: an issue there was not "gone", just unseen.
     */
    examined: Array<{ vulnerabilityClass: string; filePaths: string[] }>;
    /**
     * Every file the scanned branch tracks, when the scan read the whole list:
     * an open finding in a file outside it is resolved, the file is gone.
     */
    trackedFiles?: string[];
    /**
     * When this scan started. A finding another scan sighted after it is not
     * resolved by this one, even if their runs overlapped.
     */
    scanStartedAt: string;
}

export interface IIssuesRepository {
    getNativeCollection(): any;

    create(issue: Omit<IIssue, 'uuid'>): Promise<IssuesEntity>;

    findById(uuid: string): Promise<IssuesEntity | null>;
    findOne(filter?: Partial<IIssue>): Promise<IssuesEntity | null>;
    findByFileAndStatus(
        organizationId: string,
        repositoryId: string,
        filePath: string,
        status?: IssueStatus,
    ): Promise<IssuesEntity[] | null>;
    find(organizationId: string): Promise<IssuesEntity[]>;
    findByFilters(filter?: Partial<IIssue>): Promise<IssuesEntity[]>;

    count(filter?: Partial<IIssue>): Promise<number>;

    update(
        issue: IssuesEntity,
        updateData: Partial<IIssue>,
    ): Promise<IssuesEntity | null>;

    updateLabel(uuid: string, label: LabelType): Promise<IssuesEntity | null>;

    updateSeverity(
        uuid: string,
        severity: SeverityLevel,
    ): Promise<IssuesEntity | null>;

    updateStatus(
        uuid: string,
        status: IssueStatus,
    ): Promise<IssuesEntity | null>;

    updateStatusByIds(
        uuids: string[],
        status: IssueStatus,
    ): Promise<IssuesEntity[] | null>;

    addContributingSuggestions(
        uuid: string,
        suggestions: IContributingSuggestion[],
        organizationId: string,
    ): Promise<IssuesEntity | null>;

    upsertScanFinding(
        finding: ScanFindingUpsert,
    ): Promise<{ issue: IssuesEntity; outcome: ScanFindingOutcome }>;

    /**
     * Where the repository's open scan findings sit. A scan reads these again
     * even when nothing there draws the pattern scan any more: a fix that
     * removed the dangerous operation is how a finding gets resolved.
     */
    findOpenScanFindingAreas(
        params: ScanRepositoryScope,
    ): Promise<OpenScanFindingArea[]>;

    resolveUnseenScanFindings(
        params: ResolveUnseenScanFindingsParams,
    ): Promise<number>;
}

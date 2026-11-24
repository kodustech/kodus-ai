import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { IssuesEntity } from '../entities/issues.entity';
import {
    IIssue,
    IIssueExport,
    IIssueOccurrence,
} from '../interfaces/issues.interface';
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

/**
 * One repository, as a scan names it: an id is only unique on its platform
 * and instance (repositoryHost).
 */
export interface ScanRepositoryScope {
    organizationId: string;
    repositoryPlatform: PlatformType;
    repositoryHost: string;
    repositoryId: string;
}

export interface MarkScanFindingsSeenParams extends ScanRepositoryScope {
    fingerprints: string[];
    scanId: string;
    /**
     * The scan found these again (a fresh finding the dedup folded into
     * them): one resolved since is reopened, as a stored sighting would.
     * Without it, only open findings are marked.
     */
    foundAgain?: boolean;
}

/** A file and a class an open scan finding sits at. */
export interface OpenScanFindingArea {
    filePath: string;
    vulnerabilityClass: string;
}

/**
 * An open scan finding as a later scan compares a fresh one with: the same
 * bug found again keeps this identity, whichever place the new scan's dedup
 * would have kept.
 */
export interface OpenScanFinding extends OpenScanFindingArea {
    fingerprint: string;
    title: string;
    description: string;
    severity: string;
    cwe?: string;
    startLine: number;
    endLine: number;
    attackPath?: { file: string; line: number; note: string }[];
    symbol?: string;
    /** Places folded into this issue: found again, they are this issue. */
    fingerprintAliases?: string[];
    /** Last compared with the other open issues for a shared root cause. */
    consolidatedAt?: string;
    lastSeenAt?: string;
}

/** One more place of an issue's root cause, found by a scan. */
export interface AddScanOccurrenceParams extends ScanRepositoryScope {
    /** The issue the place belongs to. */
    holderFingerprint: string;
    occurrence: IIssueOccurrence;
    scanId: string;
}

/** An open issue found to be another's root cause, folded into it. */
export interface FoldScanIssueParams extends ScanRepositoryScope {
    fingerprint: string;
    /** The issue that stays. */
    into: string;
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
    /**
     * Whether any of the organization's issues changed after `since`: a
     * process holding a list in memory reads it before trusting it, since
     * another process (a worker) may have written in between.
     */
    changedSince(organizationId: string, since: Date): Promise<boolean>;
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

    /** The repository's open scan findings, with what identifies each. */
    findOpenScanFindings(
        params: ScanRepositoryScope,
    ): Promise<OpenScanFinding[]>;

    /**
     * Marks the repository's open scan findings with these fingerprints as
     * seen by this scan. A scan that carries on an earlier one's plan holds
     * its findings without reading their areas again: they are this scan's
     * sightings too, and not resolved as unseen.
     */
    markScanFindingsSeen(params: MarkScanFindingsSeenParams): Promise<{
        sighted: number;
        reopened: number;
    }>;

    resolveUnseenScanFindings(
        params: ResolveUnseenScanFindingsParams,
    ): Promise<number>;

    /**
     * Records a place of the same root cause on the issue that holds it, and
     * that the scan saw the issue there. Null when no such issue exists.
     */
    addScanFindingOccurrence(
        params: AddScanOccurrenceParams,
    ): Promise<{ issue: IssuesEntity; outcome: ScanFindingOutcome } | null>;

    /**
     * Folds an open issue into the one it shares a root cause with: its place
     * becomes an occurrence there, and it is dismissed as a duplicate.
     */
    foldScanIssueInto(params: FoldScanIssueParams): Promise<boolean>;

    /** Records where an issue was filed through a plugin. */
    recordIssueExport(
        organizationId: string,
        issueId: string,
        exported: IIssueExport,
    ): Promise<void>;

    /**
     * Open scan issues of a repository opened between `since` and `until`
     * (one scan runs on a repository at a time: that scan's new issues), at
     * or above a severity, not yet filed through this plugin: what a
     * schedule exports when its scan ends.
     */
    findScanIssuesToExport(
        params: ScanRepositoryScope & {
            since: string;
            until: string;
            severities: string[];
            integrationId: string;
            limit: number;
        },
    ): Promise<IssuesEntity[]>;

    /** Records that these issues were compared with the others just now. */
    markScanIssuesConsolidated(
        params: ScanRepositoryScope & { fingerprints: string[]; at: string },
    ): Promise<void>;
}

import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import {
    IContributingSuggestion,
    IRepositoryToIssues,
} from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';

/**
 * Where an issue came from. Absent on every issue written before the security
 * scan existed, which all came from closed pull requests.
 */
export enum IssueSource {
    CODE_REVIEW = 'code_review',
    SECURITY_SCAN = 'security_scan',
}

export interface IIssueOwner {
    gitId: string;
    username: string;
    email?: string;
    /** How the owner was decided; absent = the PR author (the only way before the scan). */
    origin?: 'pr_author' | 'codeowners' | 'last_author';
}

export interface IIssueReproduction {
    /** Repository-relative path the test was written to. */
    path: string;
    content: string;
    command: string;
    /** False when the sandbox could not run code (self-hosted without E2B). */
    executed: boolean;
    exitCode?: number;
    /** True only when the test ran and its result shows the vulnerability. */
    reproduced?: boolean;
    /**
     * It ran but could not exercise the code (a dependency it could not
     * install offline, a missing runner): no verdict either way.
     */
    inconclusive?: boolean;
    output?: string;
}

export interface IIssueEvidence {
    attackPath: { file: string; line: number; note: string }[];
    reproduction?: IIssueReproduction;
    /**
     * The deployment or configuration fact the finding depends on, when the
     * scan's verifier could not read it in the code.
     */
    assumption?: string;
}

export interface IIssue {
    uuid?: string;
    title: string;
    description: string;
    filePath: string;
    language: string;
    label: LabelType;
    severity: SeverityLevel;
    contributingSuggestions: IContributingSuggestion[];
    repository: IRepositoryToIssues;
    organizationId: string;
    age?: string;
    status?: IssueStatus;
    createdAt: string;
    updatedAt: string;
    prNumbers?: string[];
    owner?: IIssueOwner;
    reporter?: {
        gitId: string;
        username: string;
    };
    source?: IssueSource;
    /**
     * Stable identity of a security-scan finding across scans (see
     * computeScanFingerprint). Never set on code-review issues.
     */
    fingerprint?: string;
    cwe?: string;
    vulnerabilityClass?: string;
    /** The function or method that holds the vulnerable operation. */
    symbol?: string;
    startLine?: number;
    endLine?: number;
    evidence?: IIssueEvidence;
    lastSeenScanId?: string;
    /**
     * The commit the scan that last saw it read: the issue's lines and its
     * link point there, whatever branch was scanned.
     */
    lastSeenCommitSha?: string;
    lastSeenAt?: string;
    resolvedAt?: string;
    consecutiveScanMisses?: number;
    lastMissedScanId?: string;
    /**
     * Other places of the same root cause a scan folded into this issue: the
     * route, the handler and the query of one missing check, or the same
     * unsafe setting repeated. One fix, one issue.
     */
    occurrences?: IIssueOccurrence[];
    /**
     * The severity of the issue's own finding, without its occurrences:
     * `severity` is the worst of this and theirs, so a place that leaves
     * takes its severity with it.
     */
    ownSeverity?: SeverityLevel;
    /**
     * The identities of those places: a scan that finds one again sights
     * this issue instead of opening another.
     */
    fingerprintAliases?: string[];
    /**
     * Set on an issue a scan found to be another issue's root cause and
     * folded into it: the fingerprint of the issue that holds it now.
     */
    duplicateOf?: string;
    /** When this issue was last compared with the others for a shared root cause. */
    consolidatedAt?: string;
}

export interface IIssueOccurrence {
    fingerprint: string;
    title: string;
    cwe?: string;
    filePath: string;
    startLine: number;
    endLine: number;
    symbol?: string;
    severity?: string;
    vulnerabilityClass?: string;
    lastSeenScanId?: string;
    /** When a scan last saw this place: a scan that started later prunes it. */
    lastSeenAt?: string;
}

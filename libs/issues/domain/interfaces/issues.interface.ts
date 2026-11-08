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
    output?: string;
}

export interface IIssueEvidence {
    attackPath: { file: string; line: number; note: string }[];
    reproduction?: IIssueReproduction;
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
    lastSeenAt?: string;
    resolvedAt?: string;
}

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IssueStatus } from '@libs/core/infrastructure/config/types/general/issues.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

import type { IIssueEvidence, IIssueOwner } from './issues.interface';

export interface IIssueDetails {
    id: string;
    title: string;
    description: string;
    age: string;
    label: LabelType;
    severity: SeverityLevel;
    status: IssueStatus;
    contributingSuggestions: IContributingSuggestion[];
    fileLink: {
        label: string;
        url: string;
    };
    prLinks: {
        label: string;
        url: string;
    }[];
    repositoryLink: {
        label: string;
        url: string;
    };
    language: string;
    reactions: {
        thumbsUp: number;
        thumbsDown: number;
    };
    gitOrganizationName: string;
    repository: {
        id: string;
        name: string;
    };
    /** Only on issues a security scan opened. */
    source?: string;
    security?: {
        cwe?: string;
        vulnerabilityClass?: string;
        symbol?: string;
        startLine?: number;
        endLine?: number;
        evidence?: IIssueEvidence;
        lastSeenAt?: string;
    };
    owner?: IIssueOwner;
}

export interface IContributingSuggestion {
    id: string;
    prNumber: number;
    prAuthor: {
        id: string;
        name: string;
    };
    suggestionContent?: string;
    oneSentenceSummary?: string;
    relevantFile?: string;
    language?: string;
    existingCode?: string;
    improvedCode?: string;
    startLine?: number;
    endLine?: number;
    brokenKodyRulesIds?: string[];
}

export interface IRepositoryToIssues {
    id: string;
    name: string;
    full_name: string;
    platform: PlatformType;
    url?: string;
}

export type contextToGenerateIssues = {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: IRepositoryToIssues;
    pullRequest: any;
    prFiles?: any[];
};

export interface IRepresentativeSuggestion {
    id: string;
    language: string;
    relevantFile: string;
    suggestionContent: string;
    existingCode: string;
    improvedCode: string;
    oneSentenceSummary: string;
}

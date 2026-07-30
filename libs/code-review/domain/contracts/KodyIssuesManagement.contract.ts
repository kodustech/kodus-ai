import type { BYOKConfig } from '@libs/llm/byok-config';

import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { contextToGenerateIssues } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';

export const KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN = Symbol(
    'KodyIssuesManagementService',
);

export interface IKodyIssuesManagementService {
    processClosedPr(params: contextToGenerateIssues): Promise<void>;

    mergeSuggestionsIntoIssues(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        filePath: string,
        newSuggestions: Partial<CodeSuggestion>[],
        byokConfig: BYOKConfig | null,
    ): Promise<any>;

    createNewIssues(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        unmatchedSuggestions: Partial<CodeSuggestion>[],
    ): Promise<void>;

    resolveExistingIssues(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        files: any[],
        byokConfig: BYOKConfig | null,
    ): Promise<void>;
}

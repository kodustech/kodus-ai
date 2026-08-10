import { createLogger } from '@libs/core/log/logger';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import { environment } from '../configs/environment';
import {
    prompt_kodyissues_merge_suggestions_into_issues_system,
    prompt_kodyissues_resolve_issues_system,
} from '@libs/common/utils/langchainCommon/prompts/kodyIssuesManagement';
import { contextToGenerateIssues } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';

export const KODY_ISSUES_ANALYSIS_SERVICE_TOKEN = Symbol(
    'KodyIssuesAnalysisService',
);

// Output shapes are fixed by the prompts (see kodyIssuesManagement.ts). Kept
// as strict schemas so the v5 structured call (generateObject) validates and
// the callers can read `.matches` / `.issueVerificationResults` directly.
export const MERGE_MATCHES_SCHEMA = z.object({
    matches: z.array(
        z.object({
            suggestionId: z.string(),
            existingIssueId: z.string().nullable(),
        }),
    ),
});

export const ISSUE_VERIFICATION_SCHEMA = z.object({
    issueVerificationResults: z.array(
        z.object({
            issueId: z.string(),
            issueTitle: z.string(),
            contributingSuggestionIds: z.array(z.string()),
            isIssuePresentInCode: z.boolean(),
            verificationConfidence: z.enum(['high', 'medium', 'low']),
            reasoning: z.string(),
        }),
    ),
});

@Injectable()
export class KodyIssuesAnalysisService {
    private readonly logger = createLogger(KodyIssuesAnalysisService.name);
    public readonly isCloud: boolean;
    public readonly isDevelopment: boolean;

    constructor(private readonly observabilityService: ObservabilityService) {
        this.isCloud = environment.API_CLOUD_MODE;
        this.isDevelopment = environment.API_DEVELOPMENT_MODE;
    }

    async mergeSuggestionsIntoIssues(
        organizationAndTeamData: OrganizationAndTeamData,
        pullRequest: any,
        promptData: any,
        byokConfig: BYOKConfig | null,
    ): Promise<z.infer<typeof MERGE_MATCHES_SCHEMA>> {
        try {
            return await runStructuredReviewCall({
                byokConfig: byokConfig ?? undefined,
                schema: MERGE_MATCHES_SCHEMA,
                system: prompt_kodyissues_merge_suggestions_into_issues_system(),
                user: JSON.stringify(promptData),
                runName: 'mergeSuggestionsIntoIssues',
                organizationId: organizationAndTeamData?.organizationId,
                attrs: { prNumber: pullRequest?.number },
                observabilityService: this.observabilityService,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error in mergeSuggestionsIntoIssues',
                context: KodyIssuesAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    prNumber: pullRequest?.number,
                },
            });
            throw error;
        }
    }

    async resolveExistingIssues(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        promptData: any,
        byokConfig: BYOKConfig | null,
    ): Promise<z.infer<typeof ISSUE_VERIFICATION_SCHEMA>> {
        try {
            return await runStructuredReviewCall({
                byokConfig: byokConfig ?? undefined,
                schema: ISSUE_VERIFICATION_SCHEMA,
                system: prompt_kodyissues_resolve_issues_system(),
                user: JSON.stringify(promptData),
                runName: 'resolveExistingIssues',
                organizationId: context.organizationAndTeamData?.organizationId,
                attrs: { prNumber: context.pullRequest?.number },
                observabilityService: this.observabilityService,
            });
        } catch (error) {
            this.logger.error({
                message: 'Error in resolveExistingIssues',
                context: KodyIssuesAnalysisService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest?.number,
                },
            });
            throw error;
        }
    }
}

import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import { environment } from '../configs/environment';
import {
    prompt_kodyissues_merge_suggestions_into_issues_system,
    prompt_kodyissues_resolve_issues_system,
} from '@libs/common/utils/prompts/kodyIssuesManagement';
import { contextToGenerateIssues } from '@libs/issues/domain/interfaces/kodyIssuesManagement.interface';

export const KODY_ISSUES_ANALYSIS_SERVICE_TOKEN = Symbol(
    'KodyIssuesAnalysisService',
);

// Structured-output schemas mirror the JSON shapes the prompts instruct the
// model to return. Leaf fields are kept lenient (`.optional()`, per the
// strict-wire-schema `.nullable()`→absent invariant) so the migration preserves
// the previous lenient STRING-parser behavior: downstream consumers already
// guard on `?.matches` / `?.issueVerificationResults` and per-field presence.
export const kodyIssuesMergeSchema = z.object({
    matches: z.array(
        z.object({
            suggestionId: z.string(),
            // `null` in the prompt means "no existing match"; strict-wire
            // normalizes null→absent, and the consumer treats absent as null.
            existingIssueId: z.string().optional(),
        }),
    ),
});

export const kodyIssuesResolveSchema = z.object({
    issueVerificationResults: z.array(
        z.object({
            issueId: z.string(),
            issueTitle: z.string().optional(),
            contributingSuggestionIds: z.array(z.string()).optional(),
            isIssuePresentInCode: z.boolean(),
            verificationConfidence: z
                .enum(['high', 'medium', 'low'])
                .optional(),
            reasoning: z.string().optional(),
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
        byokConfig: NormalizedModel | null,
    ): Promise<any> {
        try {
            const runName = 'mergeSuggestionsIntoIssues';

            const result = await runStructuredReviewCall({
                byokConfig: byokConfig ?? undefined,
                schema: kodyIssuesMergeSchema,
                system: prompt_kodyissues_merge_suggestions_into_issues_system(),
                user: JSON.stringify(promptData),
                runName: `${KodyIssuesAnalysisService.name}::${runName}`,
                organizationId: organizationAndTeamData?.organizationId,
                attrs: {
                    prNumber: pullRequest?.number,
                    fallback: false,
                },
                observabilityService: this.observabilityService,
            });

            if (!result) {
                const message = `No response from LLM for PR#${pullRequest.number}`;
                this.logger.warn({
                    message,
                    context: KodyIssuesAnalysisService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber: pullRequest.number,
                    },
                });
                throw new Error(message);
            }

            return result;
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
        byokConfig: NormalizedModel | null,
    ): Promise<any> {
        try {
            const runName = 'resolveExistingIssues';

            const result = await runStructuredReviewCall({
                byokConfig: byokConfig ?? undefined,
                schema: kodyIssuesResolveSchema,
                system: prompt_kodyissues_resolve_issues_system(),
                user: JSON.stringify(promptData),
                runName: `${KodyIssuesAnalysisService.name}::${runName}`,
                organizationId: context.organizationAndTeamData?.organizationId,
                attrs: {
                    prNumber: context.pullRequest?.number,
                    fallback: false,
                },
                observabilityService: this.observabilityService,
            });

            if (!result) {
                const message = `No response from LLM for PR#${context.pullRequest.number}`;
                this.logger.warn({
                    message,
                    context: KodyIssuesAnalysisService.name,
                    metadata: {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                    },
                });
                throw new Error(message);
            }

            return result;
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

import { Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { BaseCodeReviewAgentProvider } from '@libs/code-review/infrastructure/agents/providers/base-code-review-agent.provider';
import {
    ReviewAgentIdentity,
    ReviewAgentInput,
    ReviewFindingLabel,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { buildGeneralistReviewPrompt } from '@libs/code-review/infrastructure/agents/prompts/review-prompt-blocks';
import { finderRunSettings } from '@libs/code-review/infrastructure/agents/core/finder-model-profile';
import type { NormalizedModel } from '@libs/llm/byok-config';

const logger = createLogger('GeneralistAgentProvider');

const hasRepoInstructions = (input: ReviewAgentInput): boolean =>
    (input.repoInstructions?.files?.length ?? 0) > 0;

@Injectable()
export class GeneralistAgentProvider extends BaseCodeReviewAgentProvider {
    constructor(
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        @Optional()
        documentationSearchService?: DocumentationSearchExaService,
        @Optional()
        byokErrorCounter?: ByokErrorCounter,
    ) {
        super(
            permissionValidationService,
            observabilityService,
            documentationSearchService,
            byokErrorCounter,
        );
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'kodus-generalist-review-agent',
            description:
                'Senior code reviewer specialized in finding correctness, security, and performance issues in one pass. Investigates the diff and surrounding code before reporting.',
            goal: 'Find the highest-signal bugs, security vulnerabilities, and material performance regressions introduced by the diff with one investigation loop.',
            expertise: [
                'Bug and regression analysis',
                'Authentication and authorization flows',
                'Hot-path and database performance analysis',
                'Call-chain tracing',
                'Risk prioritization across categories',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'generalist';
    }

    /** Step cap and synthesis rescue of the model's family
     *  (finder-model-profile.ts). Read from the primary model: a fallback
     *  model that serves a call keeps the primary's settings. */
    protected applyModelSettings(
        input: ReviewAgentInput,
        modelName: string,
        byokConfig?: NormalizedModel,
    ): ReviewAgentInput {
        const { profile, maxSteps, skipSynthesisRescue } = finderRunSettings(
            input,
            modelName,
        );
        if (!profile) return input;
        logger.log({
            message: `[AGENT] Generalist finder settings for ${modelName}: family=${profile.family}, maxSteps=${maxSteps ?? 'default'}, synthesisRescue=${!skipSynthesisRescue}`,
            context: GeneralistAgentProvider.name,
            metadata: {
                organizationId: input.organizationAndTeamData?.organizationId,
                teamId: input.organizationAndTeamData?.teamId,
                prNumber: input.prNumber,
                primaryModelName: modelName,
                fallbackModelName: byokConfig?.fallback?.model,
                family: profile.family,
                maxSteps,
                skipSynthesisRescue,
            },
        });
        return { ...input, maxSteps, skipSynthesisRescue };
    }

    protected supportsMixedLabels(): boolean {
        return true;
    }

    protected getAllowedSuggestionLabels(
        input: ReviewAgentInput,
    ): ReviewFindingLabel[] {
        const categories: ReviewFindingLabel[] = input.requestedCategories
            ?.length
            ? [...input.requestedCategories]
            : ['bug', 'security', 'performance'];

        // Only a run that was given the repository's coding-agent
        // instructions may report against them.
        return hasRepoInstructions(input)
            ? [...categories, 'repo_instruction']
            : categories;
    }

    protected getCategoryPrompt(input: ReviewAgentInput): string {
        return buildGeneralistReviewPrompt({
            repoInstructions: hasRepoInstructions(input),
        });
    }
}

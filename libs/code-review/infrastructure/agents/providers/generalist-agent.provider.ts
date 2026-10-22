import { Injectable, Optional } from '@nestjs/common';

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

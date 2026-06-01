import { Injectable, Optional } from '@nestjs/common';
import { PromptRunnerService } from '@kodus/kodus-common/llm';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import {
    BaseCodeReviewAgentProvider,
    ReviewAgentIdentity,
    ReviewAgentInput,
} from './base-code-review-agent.provider';
import { buildGeneralistReviewPrompt } from './review-prompt-blocks';

@Injectable()
export class GeneralistAgentProvider extends BaseCodeReviewAgentProvider {
    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
        @Optional()
        documentationSearchService?: DocumentationSearchExaService,
        @Optional()
        byokErrorCounter?: ByokErrorCounter,
    ) {
        super(
            promptRunnerService,
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
    ): Array<'bug' | 'security' | 'performance'> {
        if (input.requestedCategories?.length) {
            return input.requestedCategories;
        }

        return ['bug', 'security', 'performance'];
    }

    protected getCategoryPrompt(): string {
        return buildGeneralistReviewPrompt();
    }
}

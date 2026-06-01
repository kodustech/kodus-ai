import { Injectable, Optional } from '@nestjs/common';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import {
    BaseCodeReviewAgentProvider,
    ReviewAgentIdentity,
} from './base-code-review-agent.provider';
import { buildCategoryReviewPrompt } from './review-prompt-blocks';

@Injectable()
export class PerformanceAgentProvider extends BaseCodeReviewAgentProvider {
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
            name: 'kodus-performance-review-agent',
            description:
                'Performance engineering expert specialized in finding N+1 queries, ' +
                'unnecessary loops, memory leaks, missing caching opportunities, ' +
                'and hot path allocations in code changes.',
            goal:
                'Find real performance issues that would cause noticeable degradation ' +
                'in production. Verify impact by investigating the codebase context.',
            expertise: [
                'Database query optimization (N+1, missing indexes)',
                'Algorithm complexity analysis',
                'Memory leak detection',
                'Caching strategy evaluation',
                'I/O bottleneck identification',
                'Hot path optimization',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'performance';
    }

    protected getCategoryPrompt(): string {
        return buildCategoryReviewPrompt('performance');
    }
}

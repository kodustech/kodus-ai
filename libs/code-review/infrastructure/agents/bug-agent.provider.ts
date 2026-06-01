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
export class BugAgentProvider extends BaseCodeReviewAgentProvider {
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
            name: 'kodus-bug-review-agent',
            description:
                'Senior software engineer specialized in finding bugs, logic errors, ' +
                'edge cases, error handling issues, data flow problems, and race conditions ' +
                'in code changes. Investigates the codebase before making any suggestion.',
            goal:
                'Find real, impactful bugs in the code changes by investigating the codebase. ' +
                'Only report issues backed by concrete evidence from the code.',
            expertise: [
                'Bug detection and logic analysis',
                'Edge case identification',
                'Error handling verification',
                'Data flow and state management analysis',
                'Race condition detection',
                'Null/undefined safety',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'bug';
    }

    protected getCategoryPrompt(): string {
        return buildCategoryReviewPrompt('bug');
    }
}

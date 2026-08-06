import { Injectable, Optional } from '@nestjs/common';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';
import { BaseCodeReviewAgentProvider } from './base-code-review-agent.provider';
import { ReviewAgentIdentity } from '../review-agent.contract';
import { buildCategoryReviewPrompt } from '../prompts/review-prompt-blocks';

@Injectable()
export class DuplicateLogicAgentProvider extends BaseCodeReviewAgentProvider {
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
            name: 'kodus-duplicate-logic-agent',
            description:
                'Senior software engineer specialized in detecting duplicate logic, ' +
                'redundant implementations, and structurally similar functions or business ' +
                'rules. Focuses on ensuring that updates to one copy do not leave siblings stale.',
            goal:
                'Find structurally or semantically similar duplicates of changed functions. ' +
                'Only report issues backed by concrete code copies that are left un-updated.',
            expertise: [
                'Clone detection and structural comparison',
                'Identifying duplicated business rules',
                'Refactoring to shared modules/functions',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'duplicate_logic';
    }

    protected getCategoryPrompt(): string {
        return buildCategoryReviewPrompt('duplicate_logic');
    }
}

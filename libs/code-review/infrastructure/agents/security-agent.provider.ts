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
export class SecurityAgentProvider extends BaseCodeReviewAgentProvider {
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
            name: 'kodus-security-review-agent',
            description:
                'Application security expert specialized in finding vulnerabilities, ' +
                'auth issues, injection flaws, data exposure, and secrets in code changes. ' +
                'Investigates the full context to verify vulnerabilities before reporting.',
            goal:
                'Find real security vulnerabilities in the code changes by verifying ' +
                'attack vectors, sanitization, and auth flows in the codebase.',
            expertise: [
                'OWASP Top 10 vulnerabilities',
                'Authentication and authorization flows',
                'Input validation and sanitization',
                'Injection attack vectors (SQL, XSS, command, SSRF)',
                'Data exposure and secrets detection',
                'Cryptographic misuse',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'security';
    }

    protected getCategoryPrompt(): string {
        return buildCategoryReviewPrompt('security');
    }
}

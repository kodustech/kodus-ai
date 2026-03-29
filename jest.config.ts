import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export default {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/test/jest.setup.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    testMatch: ['**/*.spec.ts', '**/*.integration.spec.ts', '**/*.e2e-spec.ts'],
    transform: {
        '^.+\\.(t|j)s$': [
            '@swc/jest',
            {
                jsc: {
                    parser: {
                        syntax: 'typescript',
                        decorators: true,
                    },
                    transform: {
                        legacyDecorator: true,
                        decoratorMetadata: true,
                    },
                },
            },
        ],
    },
    moduleNameMapper: {
        // e2b SDK mock — the real package depends on chalk v5+ (ESM-only)
        // which Jest cannot parse. Map to a stub to prevent ESM parse errors.
        '^e2b$': '<rootDir>/test/__mocks__/e2b.ts',

        // Web app aliases
        '^@enums$': '<rootDir>/apps/web/src/core/enums',
        '^@services$': '<rootDir>/apps/web/src/lib/services',
        '^@services/(.*)$': '<rootDir>/apps/web/src/lib/services/$1',
        '^src/(.*)$': '<rootDir>/apps/web/src/$1',

        // Shared domain enums
        '^@/shared/domain/enums/(.*)$': '<rootDir>/libs/core/domain/enums/$1',

        // Issues domain
        '^@/core/domain/issues/(.*)$': '<rootDir>/libs/issues/domain/$1',
        '^@/core/infrastructure/adapters/services/issues/(.*)$':
            '<rootDir>/libs/issues/infrastructure/adapters/service/$1',

        // Auth domain
        '^@/core/domain/auth/(.*)$': '<rootDir>/libs/identity/domain/auth/$1',

        // Automation domain
        '^@/core/domain/automation/enums/(.*)$':
            '<rootDir>/libs/automation/domain/automation/enum/$1',
        '^@/core/domain/automation/contracts/(.*)$':
            '<rootDir>/libs/automation/domain/automationExecution/contracts/$1',
        '^@/core/domain/automation/entities/(.*)$':
            '<rootDir>/libs/automation/domain/automationExecution/entities/$1',
        '^@/core/domain/automation/(.*)$':
            '<rootDir>/libs/automation/domain/$1',
        '^@/core/domain/codeReviewExecutions/(.*)$':
            '<rootDir>/libs/automation/domain/codeReviewExecutions/$1',
        '^@/core/infrastructure/adapters/services/automation/(.*)$':
            '<rootDir>/libs/automation/domain/automationExecution/contracts/$1',
        '^@/core/infrastructure/adapters/repositories/typeorm/automationExecution\\.repository$':
            '<rootDir>/libs/automation/infrastructure/adapters/repositories/automationExecution.repository',
        '^@/core/infrastructure/adapters/repositories/typeorm/schema/automationExecution\\.model$':
            '<rootDir>/libs/automation/infrastructure/adapters/repositories/schemas/automationExecution.model',
        '^@/core/infrastructure/adapters/repositories/typeorm/schema/automation\\.model$':
            '<rootDir>/libs/automation/infrastructure/adapters/repositories/schemas/automation.model',
        '^@/core/infrastructure/adapters/repositories/typeorm/schema/teamAutomation\\.model$':
            '<rootDir>/libs/automation/infrastructure/adapters/repositories/schemas/teamAutomation.model',
        '^@/core/infrastructure/adapters/repositories/typeorm/schema/organization\\.model$':
            '<rootDir>/libs/organization/infrastructure/adapters/repositories/schemas/organization.model',
        '^@/core/infrastructure/adapters/repositories/typeorm/schema/team\\.model$':
            '<rootDir>/libs/organization/infrastructure/adapters/repositories/schemas/team.model',
        '^@/core/infrastructure/adapters/services/permissions/(.*)$':
            '<rootDir>/libs/identity/infrastructure/adapters/services/permissions/$1',

        // Organization domain
        '^@/core/domain/organization/(.*)$':
            '<rootDir>/libs/organization/domain/$1',
        '^@/core/domain/organizationParameters/(.*)$':
            '<rootDir>/libs/organization/domain/organizationParameters/$1',
        '^@/core/application/use-cases/organizationParameters/(.*)$':
            '<rootDir>/libs/organization/application/use-cases/organizationParameters/$1',
        '^@/core/domain/parameters/(.*)$':
            '<rootDir>/libs/organization/domain/parameters/$1',
        '^@/core/infrastructure/adapters/services/parameters\\.service$':
            '<rootDir>/libs/organization/infrastructure/adapters/services/parameters.service',

        // KodyRules domain
        '^@/core/domain/kodyRules/(.*)$': '<rootDir>/libs/kodyRules/domain/$1',
        '^@/core/application/use-cases/kodyRules/(.*)$':
            '<rootDir>/libs/kodyRules/application/use-cases/$1',
        '^@/core/infrastructure/adapters/services/kodyRules/(.*)$':
            '<rootDir>/libs/kodyRules/infrastructure/adapters/services/$1',

        // Code Review domain (was codeBase)
        '^@/core/domain/codeBase/(.*)$': '<rootDir>/libs/code-review/domain/$1',
        '^@libs/core/domain/codeBase/(.*)$':
            '<rootDir>/libs/code-review/domain/$1',
        '^@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/pipeline/pipeline-state-manager\\.service$':
            '<rootDir>/libs/core/workflow/engine/state/pipeline-state-manager.service',
        '^@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/pipeline/(.*)$':
            '<rootDir>/libs/core/infrastructure/pipeline/services/$1',
        '^@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/stages/(.*)$':
            '<rootDir>/libs/code-review/pipeline/stages/$1',
        '^@/core/infrastructure/adapters/services/codeBase/(.*)$':
            '<rootDir>/libs/code-review/infrastructure/adapters/services/$1',
        '^@libs/core/infrastructure/adapters/services/codeBase/(.*)$':
            '<rootDir>/libs/code-review/infrastructure/adapters/services/$1',
        '^@/core/application/use-cases/pullRequests/(.*)$':
            '<rootDir>/libs/code-review/application/use-cases/dashboard/$1',
        '^@/core/application/use-cases/parameters/(.*)$':
            '<rootDir>/libs/code-review/application/use-cases/configuration/$1',

        // PullRequests domain (platformData)
        '^@/core/domain/pullRequests/(.*)$':
            '<rootDir>/libs/platformData/domain/pullRequests/$1',

        // AI Engine / Prompts domain
        '^@/core/domain/prompts/(.*)$':
            '<rootDir>/libs/ai-engine/domain/prompt/$1',
        '^@/core/infrastructure/adapters/services/prompts/(.*)$':
            '<rootDir>/libs/ai-engine/infrastructure/adapters/services/prompt/$1',
        '^@/core/infrastructure/adapters/services/context/(.*)$':
            '<rootDir>/libs/ai-engine/infrastructure/adapters/services/context/$1',

        // Integrations domain
        '^@/core/domain/integrations/(.*)$':
            '<rootDir>/libs/integrations/domain/integrations/$1',
        '^@/core/domain/integrationConfigs/(.*)$':
            '<rootDir>/libs/integrations/domain/integrationConfigs/$1',

        // Workflow domain
        '^@/core/domain/workflowQueue/(.*)$':
            '<rootDir>/libs/core/workflow/domain/$1',
        '^@/core/infrastructure/adapters/repositories/typeorm/workflow-job\\.repository$':
            '<rootDir>/libs/core/workflow/infrastructure/repositories/workflow-job.repository',

        // Logger / Observability
        '^@/core/infrastructure/adapters/services/logger/pino\\.service$':
            '<rootDir>/test/__mocks__/pino.service',
        '^@/core/infrastructure/adapters/services/logger/observability\\.service$':
            '<rootDir>/libs/core/log/observability.service',
        '^@/core/infrastructure/adapters/services/logger/loggerWrapper\\.service$':
            '<rootDir>/libs/core/log/loggerWrapper.service',

        // LLM (legacy alias)
        '^@/llm$': '<rootDir>/packages/kodus-common/src/llm',
        '^@/llm/(.*)$': '<rootDir>/packages/kodus-common/src/llm/$1',

        // Utils
        '^@/utils/json$': '<rootDir>/libs/common/utils/transforms/json',
        '^@/shared/utils/cache/(.*)$': '<rootDir>/libs/core/cache/$1',
        '^@/shared/infrastructure/repositories/(.*)$':
            '<rootDir>/libs/core/infrastructure/repositories/model/$1',

        // Config
        '^@/config/(.*)$': '<rootDir>/libs/core/infrastructure/config/$1',
        '^@libs/core/infrastructure/config/(.*)$':
            '<rootDir>/libs/core/infrastructure/config/$1',
        '^@/shared/utils/(.*)$': '<rootDir>/libs/common/utils/$1',

        // HTTP Controllers (apps)
        '^@/core/infrastructure/http/controllers/(.*)$':
            '<rootDir>/apps/api/src/controllers/$1',
        '^@/core/infrastructure/http/dtos/(.*)$':
            '<rootDir>/apps/api/src/dtos/$1',

        // Platform services
        '^@libs/platform/infrastructure/services/(.*)$':
            '<rootDir>/libs/platform/infrastructure/adapters/services/$1',

        // Enterprise Edition (ee) - specific mappings first
        '^@/ee/kodyIssuesManagement/(.*)$':
            '<rootDir>/libs/issues/infrastructure/adapters/$1',

        // Enterprise Edition (ee) - generic fallback
        '^@/ee/(.*)$': '<rootDir>/libs/ee/$1',

        // Common enums (legacy paths)
        '^@libs/common/enums/(.*)$': '<rootDir>/libs/common/utils/enums/$1',

        // Fallback patterns (should be last)
        '^@/(.*)$': '<rootDir>/libs/$1',
        '^@libs/(.*)$': '<rootDir>/libs/$1',
        '^@apps/(.*)$': '<rootDir>/apps/$1/src',
        '^@kodus/kodus-common/(.*)$': '<rootDir>/packages/kodus-common/src/$1',
        '^@kodus/kodus-common$': '<rootDir>/packages/kodus-common/src',
        '^@kodus/flow/(.*)$': '<rootDir>/packages/kodus-flow/src/$1',
        '^@kodus/flow$': '<rootDir>/packages/kodus-flow/src',
    },
    transformIgnorePatterns: [
        'node_modules/(?!(@octokit|universal-user-agent|p-limit|@kodus/flow|uuid|universal-github-app-jwt|before-after-hook|yocto-queue)/)',
    ],
    modulePathIgnorePatterns: [
        '<rootDir>/dist',
        '<rootDir>/.yalc',
        '<rootDir>/.worktrees',
        '<rootDir>/worktrees',
    ],
    // Resolve ESM-style .js imports to .ts files in packages
    resolver: '<rootDir>/jest-resolver.cjs',
};

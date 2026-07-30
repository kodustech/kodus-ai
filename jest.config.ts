import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export default {
    preset: 'ts-jest',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/test/jest.setup.ts'],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
    // Web app deps (e.g. tiny-invariant, @radix-ui/*, class-variance-authority)
    // live in apps/web/node_modules, not at the root — pnpm only hoists a
    // workspace member's direct deps into ITS OWN node_modules, not
    // necessarily the workspace root's. moduleDirectories resolves its
    // path-like entry per-ancestor-directory (works, but only once upward
    // walking happens to reach a level whose join lands exactly on this
    // path — brittle and, in practice, inconsistent between this dev
    // machine's node_modules and a clean CI install). modulePaths is the
    // unambiguous version: an absolute location always searched directly,
    // like NODE_PATH.
    moduleDirectories: ['node_modules', 'apps/web/node_modules'],
    modulePaths: ['<rootDir>/apps/web/node_modules'],
    testMatch: [
        '**/*.spec.ts',
        '**/*.spec.tsx',
        '**/*.integration.spec.ts',
        '**/*.e2e-spec.ts',
    ],
    transform: {
        '^.+\\.(t|j)sx?$': [
            '@swc/jest',
            {
                jsc: {
                    parser: {
                        syntax: 'typescript',
                        tsx: true,
                        decorators: true,
                    },
                    transform: {
                        legacyDecorator: true,
                        decoratorMetadata: true,
                        react: {
                            runtime: 'automatic',
                        },
                    },
                },
            },
        ],
    },
    moduleNameMapper: {
        // e2b SDK mock — the real package depends on chalk v5+ (ESM-only)
        // which Jest cannot parse. Map to a stub to prevent ESM parse errors.
        '^e2b$': '<rootDir>/test/__mocks__/e2b.ts',

        // Force a single React copy for component specs. Locally, root and
        // apps/web can end up with two separately-installed React copies
        // (different patch versions) — without this, `next/link` (built
        // against apps/web's copy) and @testing-library/react (resolved
        // from root) end up with two React instances in the same render,
        // which React detects as an "Invalid hook call". A clean/CI
        // install dedupes to a single root copy instead, so apps/web's
        // path won't exist there — list it first with root as the
        // fallback (Jest tries each array entry in order and uses the
        // first that resolves).
        '^react$': [
            '<rootDir>/apps/web/node_modules/react',
            '<rootDir>/node_modules/react',
        ],
        '^react-dom$': [
            '<rootDir>/apps/web/node_modules/react-dom',
            '<rootDir>/node_modules/react-dom',
        ],
        '^react-dom/(.*)$': [
            '<rootDir>/apps/web/node_modules/react-dom/$1',
            '<rootDir>/node_modules/react-dom/$1',
        ],
        '^react/jsx-runtime$': [
            '<rootDir>/apps/web/node_modules/react/jsx-runtime',
            '<rootDir>/node_modules/react/jsx-runtime',
        ],
        '^react/jsx-dev-runtime$': [
            '<rootDir>/apps/web/node_modules/react/jsx-dev-runtime',
            '<rootDir>/node_modules/react/jsx-dev-runtime',
        ],

        // Web app aliases
        '^@enums$': '<rootDir>/apps/web/src/core/enums',
        '^@services$': '<rootDir>/apps/web/src/lib/services',
        '^@services/(.*)$': '<rootDir>/apps/web/src/lib/services/$1',
        '^@hooks/(.*)$': '<rootDir>/apps/web/src/core/hooks/$1',
        '^@components/(.*)$': '<rootDir>/apps/web/src/core/components/$1',
        '^@providers/(.*)$': '<rootDir>/apps/web/src/core/providers/$1',
        '^@config/(.*)$': '<rootDir>/apps/web/src/core/config/$1',
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
    },
    transformIgnorePatterns: [
        // `jose` (used by apps/web's helpers.ts for JWT decoding) ships
        // ESM-only — any component spec that transitively imports
        // helpers.ts (even for an unrelated export like `greeting()`)
        // needs it transformed too, or Jest chokes on its `export` syntax.
        // The Vercel AI SDK stack (`ai` + every `@ai-sdk/*` provider) is also
        // ESM-only; the code-review/agents/llm specs import it transitively, so
        // it must be transformed too or Jest chokes on its `import` syntax.
        'node_modules/(?!(@octokit|universal-user-agent|p-limit|uuid|universal-github-app-jwt|before-after-hook|yocto-queue|jose|@ai-sdk|ai|@workflow)/)',
    ],
    modulePathIgnorePatterns: [
        '<rootDir>/dist',
        '<rootDir>/.yalc',
        '<rootDir>/.worktrees',
        '<rootDir>/worktrees',
        // Claude Code agent worktrees: isolated checkouts under here carry a
        // second copy of the local packages and test/__mocks__, which collide
        // in jest's Haste map ("looked up in the Haste module map ... several
        // different files") and break every suite. Never load modules from them.
        '<rootDir>/.claude/worktrees',
    ],
    // The mcp-manager e2e spec imports the full AppModule and needs a
    // dedicated e2e setup to run; excluded here as a focused follow-up (would
    // move to a dedicated e2e jest config like apps/api uses). Unit tests for
    // the same module run normally.
    testPathIgnorePatterns: [
        '/node_modules/',
        '<rootDir>/apps/mcp-manager/test/e2e/',
    ],
    // Resolve ESM-style .js imports to .ts files in packages
    resolver: '<rootDir>/jest-resolver.cjs',
};

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CrossFileContextSnippet } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';

// ─── FileChange ────────────────────────────────────────────────────────────────

export function createSampleFileChange(
    overrides: Partial<FileChange> = {},
): FileChange {
    return {
        content:
            'export function greet(name: string) { return `Hello ${name}`; }',
        sha: 'abc123',
        filename: 'src/utils/greet.ts',
        status: 'modified',
        additions: 5,
        deletions: 2,
        changes: 7,
        blob_url: 'https://github.com/org/repo/blob/main/src/utils/greet.ts',
        raw_url: 'https://github.com/org/repo/raw/main/src/utils/greet.ts',
        contents_url:
            'https://api.github.com/repos/org/repo/contents/src/utils/greet.ts',
        patch: `@@ -1,5 +1,8 @@\n-export function greet(name) {\n+export function greet(name: string) {\n   return \`Hello \${name}\`;\n }`,
        patchWithLinesStr: `1: -export function greet(name) {\n1: +export function greet(name: string) {\n2:   return \`Hello \${name}\`;\n3: }`,
        ...overrides,
    };
}

// ─── Planner Query ─────────────────────────────────────────────────────────────

export function createSamplePlannerQuery(
    overrides: Partial<{
        symbolName: string;
        pattern: string;
        rationale: string;
        riskLevel: 'low' | 'medium' | 'high';
        fileGlob: string;
        sourceFile: string;
    }> = {},
) {
    return {
        symbolName: 'greet',
        pattern: 'greet\\(',
        rationale: 'Callers of greet may break with the new type signature',
        riskLevel: 'high' as const,
        fileGlob: '**/*.ts',
        sourceFile: 'src/utils/greet.ts',
        ...overrides,
    };
}

// ─── Codebase Search Result ───────────────────────────────────────────────────

export function createSampleCodebaseSearchResult(
    overrides: Partial<{
        success: boolean;
        contexts: Array<{
            file: string;
            content: string;
            lines: [number, number][];
        }>;
        error?: string;
    }> = {},
) {
    return {
        success: true,
        contexts: [
            {
                file: 'src/controllers/hello.controller.ts',
                content:
                    'import { greet } from "../utils/greet";\n\napp.get("/hello", (req, res) => {\n  res.send(greet(req.query.name));\n});',
                lines: [[1, 5]] as [number, number][],
            },
        ],
        ...overrides,
    };
}

// ─── CrossFileContextSnippet ───────────────────────────────────────────────────

export function createSampleSnippet(
    overrides: Partial<CrossFileContextSnippet> = {},
): CrossFileContextSnippet {
    return {
        filePath: 'src/controllers/hello.controller.ts',
        content:
            'import { greet } from "../utils/greet";\n\napp.get("/hello", (req, res) => {\n  res.send(greet(req.query.name));\n});',
        rationale: 'Callers of greet may break with the new type signature',
        relevanceScore: 80,
        relatedSymbol: 'greet',
        relationship: 'consumer of greet',
        hop: 1,
        riskLevel: 'high',
        startLine: 1,
        endLine: 5,
        ...overrides,
    };
}

// ─── Pipeline Context (cross-file fields) ──────────────────────────────────────

export function createCrossFileBaseContext(
    overrides: Partial<CodeReviewPipelineContext> = {},
): CodeReviewPipelineContext {
    return {
        dryRun: { enabled: false },
        organizationAndTeamData: {
            organizationId: 'org-123',
            teamId: 'team-456',
        } as any,
        repository: {
            id: 'repo-1',
            name: 'test-repo',
            fullName: 'org/test-repo',
            language: 'typescript',
            platform: 'github',
            defaultBranch: 'main',
        },
        branch: 'feat/test',
        pullRequest: {
            number: 42,
            title: 'Test PR',
            base: { repo: { fullName: 'org/test-repo' }, ref: 'main' },
            head: { sha: 'abc123', ref: 'feat/test' },
            repository: { id: 'repo-1', name: 'test-repo' } as any,
            isDraft: false,
            stats: {
                total_additions: 10,
                total_deletions: 5,
                total_files: 2,
                total_lines_changed: 15,
            },
        },
        teamAutomationId: 'team-auto-1',
        origin: 'github',
        action: 'opened',
        platformType: PlatformType.GITHUB,
        codeReviewConfig: {
            reviewOptions: {
                cross_file: true,
                bug: true,
                performance: true,
                security: true,
            },
            languageResultPrompt: 'en-US',
        } as any,
        changedFiles: [createSampleFileChange()],
        batches: [],
        preparedFileContexts: [],
        validSuggestions: [],
        discardedSuggestions: [],
        correlationId: 'test-correlation-id',
        crossFileContexts: undefined,
        ...overrides,
    } as CodeReviewPipelineContext;
}

// ─── CLI Pipeline Context ───────────────────────────────────────────────────────

export function createCliCrossFileBaseContext(
    overrides: Partial<CliReviewPipelineContext> = {},
): CliReviewPipelineContext {
    const base = createCrossFileBaseContext({
        origin: 'cli',
        branch: 'feat/cli-test',
        platformType: PlatformType.GITHUB,
    });

    return {
        ...base,
        isTrialMode: false,
        startTime: Date.now(),
        correlationId: 'cli-correlation-id',
        gitContext: {
            remote: 'https://github.com/org/test-repo.git',
            branch: 'feat/cli-test',
            commitSha: 'def456',
            inferredPlatform: PlatformType.GITHUB,
        },
        ...overrides,
    } as CliReviewPipelineContext;
}

// ─── Organization And Team Data ────────────────────────────────────────────────

export const mockOrganizationAndTeamData = {
    organizationId: 'org-123',
    teamId: 'team-456',
};

// ─── Sufficiency Result ─────────────────────────────────────────────────────────

export function createSampleSufficiencyResult(
    overrides: Partial<{
        sufficient: boolean;
        gaps: string[];
        additionalQueries: Array<{
            pattern: string;
            rationale: string;
            riskLevel: 'low' | 'medium' | 'high';
            symbolName: string;
            fileGlob?: string;
            sourceFile: string;
        }>;
    }> = {},
) {
    return {
        sufficient: false,
        gaps: ['Missing consumer of validateInput'],
        additionalQueries: [
            {
                pattern: 'validateInput\\(',
                rationale: 'Need to find callers of validateInput',
                riskLevel: 'high' as const,
                symbolName: 'validateInput',
                sourceFile: 'src/utils/validate.ts',
            },
        ],
        ...overrides,
    };
}

// ─── Remote Commands Mock ──────────────────────────────────────────────────────

export function createMockRemoteCommands() {
    return {
        grep: jest.fn().mockResolvedValue(''),
        read: jest.fn().mockResolvedValue(''),
        listDir: jest.fn().mockResolvedValue('src/index.ts\nsrc/app.ts\n'),
    };
}

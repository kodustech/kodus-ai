import { ExecuteCliReviewUseCase } from '../execute-cli-review.use-case';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    }),
    IdGenerator: {
        correlationId: () => 'test-correlation-id',
    },
}));

/**
 * We test the private helpers via the public execute() path and
 * via direct access using (useCase as any) for unit-level coverage.
 */

// ---------------------------------------------------------------------------
// Helpers & Mocks
// ---------------------------------------------------------------------------

function createMocks() {
    const converter = {
        convertToFileChanges: jest.fn().mockReturnValue([
            {
                filename: 'src/index.ts',
                patch: '+ hello',
                status: 'modified',
                additions: 1,
                deletions: 0,
                changes: 1,
                sha: 'abc',
            },
        ]),
    };

    const pipelineStrategy = {
        configureStages: jest.fn().mockReturnValue([]),
        getPipelineName: jest.fn().mockReturnValue('CliReviewPipeline'),
    };

    const parametersService = {
        findByKey: jest.fn(),
    };

    const automationExecutionService = {
        create: jest
            .fn()
            .mockResolvedValue({ uuid: 'exec-1', dataExecution: {} }),
        update: jest.fn().mockResolvedValue(undefined),
    };

    const teamAutomationService = {
        find: jest.fn().mockResolvedValue([{ uuid: 'ta-1' }]),
    };

    const kodyRulesService = {
        findByOrganizationId: jest.fn().mockResolvedValue(null),
    };

    const kodyRulesValidationService = {
        filterKodyRules: jest.fn().mockReturnValue({
            standardRules: [],
            memoryRules: [],
        }),
    };

    const pipelineObserver = {
        onPipelineStart: jest.fn().mockResolvedValue(undefined),
        onPipelineFinish: jest.fn().mockResolvedValue(undefined),
        onStageStart: jest.fn().mockResolvedValue(undefined),
        onStageFinish: jest.fn().mockResolvedValue(undefined),
        onStageError: jest.fn().mockResolvedValue(undefined),
        onStageSkipped: jest.fn().mockResolvedValue(undefined),
    };

    const useCase = new ExecuteCliReviewUseCase(
        converter as any,
        pipelineStrategy as any,
        parametersService as any,
        automationExecutionService as any,
        teamAutomationService as any,
        kodyRulesService as any,
        kodyRulesValidationService as any,
        pipelineObserver as any,
    );

    return {
        useCase,
        converter,
        pipelineStrategy,
        parametersService,
        automationExecutionService,
        teamAutomationService,
        kodyRulesService,
        kodyRulesValidationService,
        pipelineObserver,
    };
}

function makeRule(overrides: Record<string, any> = {}) {
    return {
        uuid: 'rule-1',
        title: 'Test Rule',
        rule: 'Do not use var',
        status: KodyRulesStatus.ACTIVE,
        severity: 'high',
        repositoryId: 'global',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests: resolveRepositoryFromRemote
// ---------------------------------------------------------------------------

describe('ExecuteCliReviewUseCase', () => {
    describe('resolveRepositoryFromRemote', () => {
        let useCase: any;

        beforeEach(() => {
            const { useCase: uc } = createMocks();
            useCase = uc;
        });

        it('should return "global" when remote is undefined', () => {
            const result = useCase.resolveRepositoryFromRemote(undefined, []);
            expect(result).toEqual({ id: 'global', name: null });
        });

        it('should return "global" when repositories list is empty', () => {
            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/repo.git',
                [],
            );
            expect(result).toEqual({ id: 'global', name: null });
        });

        it('should return "global" when repositories is undefined', () => {
            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/repo.git',
                undefined,
            );
            expect(result).toEqual({ id: 'global', name: null });
        });

        it('should match HTTPS remote to http_url', () => {
            const repos = [
                {
                    id: '123',
                    name: 'my-repo',
                    http_url: 'https://github.com/org/my-repo',
                },
            ];

            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/my-repo.git',
                repos,
            );
            expect(result).toEqual({ id: '123', name: 'my-repo' });
        });

        it('should match SSH remote to http_url', () => {
            const repos = [
                {
                    id: '456',
                    name: 'backend',
                    http_url: 'https://github.com/company/backend',
                },
            ];

            const result = useCase.resolveRepositoryFromRemote(
                'git@github.com:company/backend.git',
                repos,
            );
            expect(result).toEqual({ id: '456', name: 'backend' });
        });

        it('should match case-insensitively', () => {
            const repos = [
                {
                    id: '789',
                    name: 'MyRepo',
                    http_url: 'https://github.com/Org/MyRepo',
                },
            ];

            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/myrepo.git',
                repos,
            );
            expect(result).toEqual({ id: '789', name: 'MyRepo' });
        });

        it('should fallback to name matching when http_url does not match', () => {
            const repos = [
                {
                    id: '999',
                    name: 'my-project',
                    http_url: 'https://gitlab.com/other-org/my-project',
                },
            ];

            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/my-project.git',
                repos,
            );
            expect(result).toEqual({ id: '999', name: 'my-project' });
        });

        it('should fallback to name matching (case-insensitive)', () => {
            const repos = [
                {
                    id: '111',
                    name: 'MyProject',
                    http_url: 'https://gitlab.com/other/something-else',
                },
            ];

            const result = useCase.resolveRepositoryFromRemote(
                'git@github.com:org/myproject.git',
                repos,
            );
            expect(result).toEqual({ id: '111', name: 'MyProject' });
        });

        it('should return "global" when no match is found', () => {
            const repos = [
                {
                    id: '222',
                    name: 'unrelated',
                    http_url: 'https://github.com/org/unrelated',
                },
            ];

            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/totally-different.git',
                repos,
            );
            expect(result).toEqual({ id: 'global', name: null });
        });

        it('should handle repos without http_url and fallback to name', () => {
            const repos = [{ id: '333', name: 'no-url-repo' }];

            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/no-url-repo.git',
                repos,
            );
            expect(result).toEqual({ id: '333', name: 'no-url-repo' });
        });

        it('should match with trailing slashes in remote', () => {
            const repos = [
                {
                    id: '444',
                    name: 'repo',
                    http_url: 'https://github.com/org/repo',
                },
            ];

            const result = useCase.resolveRepositoryFromRemote(
                'https://github.com/org/repo/',
                repos,
            );
            expect(result).toEqual({ id: '444', name: 'repo' });
        });
    });

    // -----------------------------------------------------------------------
    // Tests: normalizeGitUrl
    // -----------------------------------------------------------------------

    describe('normalizeGitUrl', () => {
        let useCase: any;

        beforeEach(() => {
            const { useCase: uc } = createMocks();
            useCase = uc;
        });

        it('should strip https protocol', () => {
            expect(useCase.normalizeGitUrl('https://github.com/org/repo')).toBe(
                'github.com/org/repo',
            );
        });

        it('should strip http protocol', () => {
            expect(useCase.normalizeGitUrl('http://github.com/org/repo')).toBe(
                'github.com/org/repo',
            );
        });

        it('should strip git@ prefix and convert colon to slash', () => {
            expect(useCase.normalizeGitUrl('git@github.com:org/repo.git')).toBe(
                'github.com/org/repo',
            );
        });

        it('should strip .git suffix', () => {
            expect(
                useCase.normalizeGitUrl('https://github.com/org/repo.git'),
            ).toBe('github.com/org/repo');
        });

        it('should strip trailing slashes', () => {
            expect(
                useCase.normalizeGitUrl('https://github.com/org/repo///'),
            ).toBe('github.com/org/repo');
        });

        it('should lowercase', () => {
            expect(useCase.normalizeGitUrl('https://GitHub.com/Org/Repo')).toBe(
                'github.com/org/repo',
            );
        });
    });

    // -----------------------------------------------------------------------
    // Tests: extractRepoNameFromRemote
    // -----------------------------------------------------------------------

    describe('extractRepoNameFromRemote', () => {
        let useCase: any;

        beforeEach(() => {
            const { useCase: uc } = createMocks();
            useCase = uc;
        });

        it('should extract name from HTTPS URL', () => {
            expect(
                useCase.extractRepoNameFromRemote(
                    'https://github.com/org/my-repo.git',
                ),
            ).toBe('my-repo');
        });

        it('should extract name from SSH URL', () => {
            expect(
                useCase.extractRepoNameFromRemote(
                    'git@github.com:org/my-repo.git',
                ),
            ).toBe('my-repo');
        });

        it('should extract name without .git suffix', () => {
            expect(
                useCase.extractRepoNameFromRemote(
                    'https://github.com/org/my-repo',
                ),
            ).toBe('my-repo');
        });

        it('should return null for invalid URL', () => {
            expect(useCase.extractRepoNameFromRemote('not-a-url')).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // Tests: loadUserConfigWithRules
    // -----------------------------------------------------------------------

    describe('loadUserConfigWithRules', () => {
        const orgAndTeam = {
            organizationId: 'org-1',
            teamId: 'team-1',
        };

        it('should return default config when params not found', async () => {
            const { useCase, parametersService } = createMocks();
            parametersService.findByKey.mockResolvedValue(null);

            const result = await (useCase as any).loadUserConfigWithRules(
                orgAndTeam,
            );

            expect(result.repositoryId).toBe('global');
            expect(result.repositoryName).toBeNull();
            expect(result.config).toBeDefined();
        });

        it('should load kody rules and filter by resolved repositoryId', async () => {
            const {
                useCase,
                parametersService,
                kodyRulesService,
                kodyRulesValidationService,
            } = createMocks();

            const globalRule = makeRule({
                uuid: 'r1',
                repositoryId: 'global',
            });
            const repoRule = makeRule({
                uuid: 'r2',
                repositoryId: '123',
                title: 'Repo Rule',
            });

            parametersService.findByKey.mockResolvedValue({
                toObject: () => ({
                    configValue: {
                        configs: { reviewOptions: { bug: true } },
                        repositories: [
                            {
                                id: '123',
                                name: 'my-repo',
                                http_url: 'https://github.com/org/my-repo',
                            },
                        ],
                    },
                }),
            });

            kodyRulesService.findByOrganizationId.mockResolvedValue({
                toObject: () => ({
                    rules: [globalRule, repoRule],
                }),
            });

            kodyRulesValidationService.filterKodyRules.mockReturnValue({
                standardRules: [globalRule, repoRule],
                memoryRules: [],
            });

            const result = await (useCase as any).loadUserConfigWithRules(
                orgAndTeam,
                { remote: 'https://github.com/org/my-repo.git' },
            );

            expect(result.repositoryId).toBe('123');
            expect(result.repositoryName).toBe('my-repo');
            expect(result.config.kodyRules).toHaveLength(2);
            expect(
                kodyRulesValidationService.filterKodyRules,
            ).toHaveBeenCalledWith([globalRule, repoRule], '123');
        });

        it('should use "global" repositoryId when no git context', async () => {
            const {
                useCase,
                parametersService,
                kodyRulesService,
                kodyRulesValidationService,
            } = createMocks();

            parametersService.findByKey.mockResolvedValue({
                toObject: () => ({
                    configValue: {
                        configs: {},
                        repositories: [
                            {
                                id: '123',
                                name: 'my-repo',
                                http_url: 'https://github.com/org/my-repo',
                            },
                        ],
                    },
                }),
            });

            kodyRulesService.findByOrganizationId.mockResolvedValue({
                toObject: () => ({ rules: [] }),
            });

            const result = await (useCase as any).loadUserConfigWithRules(
                orgAndTeam,
                undefined,
            );

            expect(result.repositoryId).toBe('global');
            expect(result.repositoryName).toBeNull();
            expect(
                kodyRulesValidationService.filterKodyRules,
            ).toHaveBeenCalledWith([], 'global');
        });

        it('should return default config on error', async () => {
            const { useCase, parametersService } = createMocks();
            parametersService.findByKey.mockRejectedValue(
                new Error('DB connection failed'),
            );

            const result = await (useCase as any).loadUserConfigWithRules(
                orgAndTeam,
            );

            expect(result.repositoryId).toBe('global');
            expect(result.repositoryName).toBeNull();
            expect(result.config).toBeDefined();
        });
    });

    // -----------------------------------------------------------------------
    // Tests: execute (integration-level with mocks)
    // -----------------------------------------------------------------------

    describe('execute', () => {
        const orgAndTeam = {
            organizationId: 'org-1',
            teamId: 'team-1',
        };

        it('should use global repositoryId in trial mode', async () => {
            const { useCase, pipelineStrategy, kodyRulesService } =
                createMocks();

            // Mock pipeline execution to return a valid cliResponse
            const mockExecute = jest
                .spyOn(
                    require('@libs/core/infrastructure/pipeline/services/pipeline-executor.service')
                        .PipelineExecutor.prototype,
                    'execute',
                )
                .mockResolvedValue({
                    cliResponse: {
                        summary: 'No issues',
                        issues: [],
                        filesAnalyzed: 1,
                        duration: 100,
                    },
                });

            const result = await useCase.execute({
                organizationAndTeamData: orgAndTeam,
                input: { diff: '+ hello' },
                isTrialMode: true,
            });

            // In trial mode, should NOT load kody rules
            expect(
                kodyRulesService.findByOrganizationId,
            ).not.toHaveBeenCalled();
            expect(result.issues).toHaveLength(0);

            mockExecute.mockRestore();
        });

        it('should pass resolved repositoryId to pipeline context', async () => {
            const {
                useCase,
                parametersService,
                kodyRulesService,
                kodyRulesValidationService,
            } = createMocks();

            parametersService.findByKey.mockResolvedValue({
                toObject: () => ({
                    configValue: {
                        configs: {},
                        repositories: [
                            {
                                id: 'repo-555',
                                name: 'my-app',
                                http_url: 'https://github.com/team/my-app',
                            },
                        ],
                    },
                }),
            });

            kodyRulesService.findByOrganizationId.mockResolvedValue({
                toObject: () => ({
                    rules: [makeRule({ repositoryId: 'repo-555' })],
                }),
            });

            kodyRulesValidationService.filterKodyRules.mockReturnValue({
                standardRules: [makeRule({ repositoryId: 'repo-555' })],
                memoryRules: [],
            });

            const mockExecute = jest
                .spyOn(
                    require('@libs/core/infrastructure/pipeline/services/pipeline-executor.service')
                        .PipelineExecutor.prototype,
                    'execute',
                )
                .mockImplementation(async (context: any) => {
                    // Verify the context has the correct repositoryId
                    expect(context.repository.id).toBe('repo-555');
                    expect(context.codeReviewConfig.kodyRules).toHaveLength(1);

                    return {
                        cliResponse: {
                            summary: '1 issue found',
                            issues: [{ file: 'test.ts' }],
                            filesAnalyzed: 1,
                            duration: 200,
                        },
                    };
                });

            const result = await useCase.execute({
                organizationAndTeamData: orgAndTeam,
                input: { diff: '+ hello' },
                gitContext: {
                    remote: 'https://github.com/team/my-app.git',
                    branch: 'main',
                },
            });

            expect(result.issues).toHaveLength(1);
            expect(
                kodyRulesValidationService.filterKodyRules,
            ).toHaveBeenCalledWith(expect.any(Array), 'repo-555');

            mockExecute.mockRestore();
        });
    });
});

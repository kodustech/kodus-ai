import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';

import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CommentAnalysisService } from '@libs/code-review/infrastructure/adapters/services/commentAnalysis.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { SendRulesNotificationUseCase } from './send-rules-notification.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { ParametersKey } from '@libs/core/domain/enums';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

import {
    GenerateKodyRulesUseCase,
    MAX_PULL_REQUESTS_SCANNED,
    PR_FETCH_CONCURRENCY,
    TARGET_SAMPLED_COMMENTS,
    countSubstantiveComments,
    orderPullRequestsNewestFirst,
} from './generate-kody-rules.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('GenerateKodyRulesUseCase.fetchPullRequestComments', () => {
    /**
     * Builds a codeManagementService stub that records how many calls are
     * in flight simultaneously, so the tests can assert real parallelism.
     */
    const buildCodeManagementMock = () => {
        let inFlight = 0;
        let maxInFlight = 0;

        const track =
            (resultFactory: (args: any) => unknown) =>
            async (args: any): Promise<unknown> => {
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await delay(15);
                inFlight--;
                return resultFactory(args);
            };

        return {
            getAllCommentsInPullRequest: jest.fn(
                track((a) => [`general-${a.prNumber}`]),
            ),
            getPullRequestReviewComment: jest.fn(
                track((a) => [`review-${a.filters.pullRequestNumber}`]),
            ),
            getFilesByPullRequestId: jest.fn(
                track((a) => [`file-${a.prNumber}`]),
            ),
            get maxInFlight() {
                return maxInFlight;
            },
        };
    };

    const buildUseCase = (codeManagementService: any) =>
        new GenerateKodyRulesUseCase(
            {} as any, // integrationService
            {} as any, // integrationConfigService
            {} as any, // parametersService
            {} as any, // createOrUpdateParametersUseCase
            codeManagementService,
            {} as any, // commentAnalysisService
            {} as any, // moduleRef
            {} as any, // sendRulesNotificationUseCase
            {} as any, // codeBaseConfigService
            {} as any, // permissionValidationService
            {} as any, // telemetry
        );

    const repository = { id: 'repo-1', name: 'repo-1' } as any;
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
    const makePRs = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ pull_number: i + 1 }));

    it("collects each PR's comments, reviews and files, preserving order", async () => {
        const cms = buildCodeManagementMock();
        const useCase = buildUseCase(cms);
        const prs = makePRs(6);

        const result = await (useCase as any).fetchPullRequestComments(
            repository,
            prs,
            orgTeam,
        );

        expect(result).toHaveLength(6);
        result.forEach((entry: any, i: number) => {
            expect(entry.pr).toBe(prs[i]);
            expect(entry.generalComments).toEqual([`general-${i + 1}`]);
            expect(entry.reviewComments).toEqual([`review-${i + 1}`]);
            expect(entry.files).toEqual([`file-${i + 1}`]);
        });
    });

    it('fetches in parallel, bounded by PR_FETCH_CONCURRENCY', async () => {
        const cms = buildCodeManagementMock();
        const useCase = buildUseCase(cms);

        await (useCase as any).fetchPullRequestComments(
            repository,
            makePRs(20),
            orgTeam,
        );

        // The 3 calls per PR run together and multiple PRs overlap, so well
        // more than one request is in flight at a time...
        expect(cms.maxInFlight).toBeGreaterThan(3);
        // ...but never more than (PR concurrency × 3 calls per PR).
        expect(cms.maxInFlight).toBeLessThanOrEqual(PR_FETCH_CONCURRENCY * 3);
    });

    it('degrades a failed fetch to empty instead of aborting the batch', async () => {
        const cms = buildCodeManagementMock();
        const useCase = buildUseCase(cms);
        const prs = makePRs(3);

        // PR #2's files fetch fails (e.g. a flaky Bitbucket 5xx).
        cms.getFilesByPullRequestId.mockImplementation(async (a: any) => {
            if (a.prNumber === 2) {
                throw new Error('bitbucket 500');
            }
            return [`file-${a.prNumber}`];
        });

        const result = await (useCase as any).fetchPullRequestComments(
            repository,
            prs,
            orgTeam,
        );

        // The batch is not aborted — all 3 PRs still come back.
        expect(result).toHaveLength(3);

        const pr2 = result.find((e: any) => e.pr.pull_number === 2);
        expect(pr2.files).toEqual([]); // failed fetch → empty fallback
        expect(pr2.generalComments).toEqual(['general-2']); // siblings unaffected

        const pr1 = result.find((e: any) => e.pr.pull_number === 1);
        expect(pr1.files).toEqual(['file-1']);
    });
});

describe('GenerateKodyRulesUseCase — excluded reviewers inheritance', () => {
    const resolve = (configValue: unknown) => {
        const deps: any[] = new Array(GenerateKodyRulesUseCase.length).fill({});
        deps[2] = { findByKey: jest.fn().mockResolvedValue({ configValue }) };
        const useCase = new (GenerateKodyRulesUseCase as any)(...deps);
        return useCase.resolveExcludedReviewersByRepo({
            organizationId: 'org-1',
            teamId: 'team-1',
        });
    };

    it('applies the global list to repos without their own and lets a repo list replace it', async () => {
        const { forRepo } = await resolve({
            configs: { kodyLearningExcludedReviewers: ['bot'] },
            repositories: [
                { id: 'inherits', configs: {} },
                {
                    id: 'own',
                    configs: { kodyLearningExcludedReviewers: ['alice'] },
                },
                { id: 'none', configs: { kodyLearningExcludedReviewers: [] } },
            ],
        });

        expect(forRepo('inherits')).toEqual(new Set(['bot']));
        expect(forRepo('own')).toEqual(new Set(['alice']));
        expect(forRepo('none')).toBeUndefined();
        expect(forRepo('unknown')).toEqual(new Set(['bot']));
    });
});

describe('GenerateKodyRulesUseCase', () => {
    let useCase: GenerateKodyRulesUseCase;

    const integrationServiceMock = {} as jest.Mocked<IIntegrationService>;
    const integrationConfigServiceMock =
        {} as jest.Mocked<IIntegrationConfigService>;
    const parametersServiceMock = {
        findByKey: jest.fn(),
    } as unknown as jest.Mocked<IParametersService>;
    const createOrUpdateParametersUseCaseMock = {
        execute: jest.fn(),
    };
    const codeManagementServiceMock = {
        getPullRequestsByRepository: jest.fn(),
        getAllCommentsInPullRequest: jest.fn(),
        getPullRequestReviewComment: jest.fn(),
        getFilesByPullRequestId: jest.fn(),
    };
    const commentAnalysisServiceMock = {
        processComments: jest.fn(),
        generateKodyRules: jest.fn(),
    };
    const sendRulesNotificationUseCaseMock = {
        execute: jest.fn(),
    };

    // Approval enabled → past-review-generated rules land PENDING.
    const codeBaseConfigServiceMock = {
        getSimpleConfig: jest.fn().mockResolvedValue({
            kodyKnowledgeApproval: { enabled: true },
        }),
    };

    const findRulesUseCaseMock = {
        execute: jest.fn(),
    };

    const createOrUpdateRuleUseCaseMock = {
        execute: jest.fn(),
    };

    const moduleRefMock = {
        resolve: jest.fn(),
    } as unknown as ModuleRef;

    beforeEach(async () => {
        jest.clearAllMocks();

        codeManagementServiceMock.getPullRequestsByRepository.mockResolvedValue(
            [{ pull_number: 10 }],
        );
        codeManagementServiceMock.getAllCommentsInPullRequest.mockResolvedValue(
            [{ id: 'comment-1' }],
        );
        codeManagementServiceMock.getPullRequestReviewComment.mockResolvedValue(
            [{ id: 'review-comment-1' }],
        );
        codeManagementServiceMock.getFilesByPullRequestId.mockResolvedValue([
            { filename: 'src/a.ts' },
        ]);
        commentAnalysisServiceMock.processComments.mockReturnValue([
            { id: 'processed-1' },
        ]);
        commentAnalysisServiceMock.generateKodyRules.mockResolvedValue([
            {
                title: 'Avoid console.log',
                rule: 'Do not use console.log in production code',
                severity: 'medium',
                origin: 'generated',
                examples: [],
            },
        ]);

        sendRulesNotificationUseCaseMock.execute.mockResolvedValue(undefined);
        createOrUpdateParametersUseCaseMock.execute.mockResolvedValue(
            undefined,
        );

        moduleRefMock.resolve = jest.fn((token: any) => {
            if (token === FindRulesInOrganizationByRuleFilterKodyRulesUseCase) {
                return Promise.resolve(findRulesUseCaseMock);
            }

            if (token === CreateOrUpdateKodyRulesUseCase) {
                return Promise.resolve(createOrUpdateRuleUseCaseMock);
            }

            return Promise.resolve(undefined);
        });

        findRulesUseCaseMock.execute.mockResolvedValue([]);

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                {
                    provide: TelemetryService,
                    useValue: {
                        kodyRuleChanged: jest.fn(),
                        kodyRulesImported: jest.fn(),
                    },
                },
                GenerateKodyRulesUseCase,
                {
                    provide: INTEGRATION_SERVICE_TOKEN,
                    useValue: integrationServiceMock,
                },
                {
                    provide: INTEGRATION_CONFIG_SERVICE_TOKEN,
                    useValue: integrationConfigServiceMock,
                },
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: parametersServiceMock,
                },
                {
                    provide: CreateOrUpdateParametersUseCase,
                    useValue: createOrUpdateParametersUseCaseMock,
                },
                {
                    provide: CodeManagementService,
                    useValue: codeManagementServiceMock,
                },
                {
                    provide: CommentAnalysisService,
                    useValue: commentAnalysisServiceMock,
                },
                {
                    provide: ModuleRef,
                    useValue: moduleRefMock,
                },
                {
                    provide: SendRulesNotificationUseCase,
                    useValue: sendRulesNotificationUseCaseMock,
                },
                {
                    provide: CODE_BASE_CONFIG_SERVICE_TOKEN,
                    useValue: codeBaseConfigServiceMock,
                },
                {
                    provide: PermissionValidationService,
                    useValue: {
                        // Truthy BYOK → model policy resolves to "generate with
                        // BYOK", so these tests exercise the persistence flow.
                        // v2-native: the model policy now asks the service for
                        // the codeReview carrier directly.
                        resolveTaskSlot: jest
                            .fn()
                            .mockResolvedValue({
                                provider: 'anthropic',
                                model: 'test-model',
                            }),
                        getSubscriptionStatus: jest
                            .fn()
                            .mockResolvedValue('trial'),
                    },
                },
            ],
        }).compile();

        useCase = module.get(GenerateKodyRulesUseCase);
    });

    it('persists generated rules through centralized-aware create-or-update flow when centralized config is enabled', async () => {
        parametersServiceMock.findByKey.mockImplementation((key: any) => {
            if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                return Promise.resolve({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-one',
                                isSelected: true,
                                directories: [],
                            },
                        ],
                    },
                });
            }

            if (key === ParametersKey.PLATFORM_CONFIGS) {
                return Promise.resolve({
                    configValue: {
                        kodyLearningStatus: 'disabled',
                    },
                });
            }

            return Promise.resolve(null);
        });

        createOrUpdateRuleUseCaseMock.execute.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://example.com/pr/1',
            message:
                'Centralized config is enabled. Change proposed through pull request instead of direct persistence.',
        });

        await useCase.execute(
            {
                teamId: 'team-1',
                days: 7,
            } as any,
            'org-1',
        );

        expect(createOrUpdateRuleUseCaseMock.execute).toHaveBeenCalledTimes(1);
        expect(createOrUpdateRuleUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                status: KodyRulesStatus.PENDING,
                repositoryId: 'repo-1',
            }),
            'org-1',
            expect.objectContaining({ userId: 'kody-system-rules-generator' }),
        );
    });

    it('generates rules ACTIVE when knowledge approval is disabled (policy-driven, no force-activate)', async () => {
        codeBaseConfigServiceMock.getSimpleConfig.mockResolvedValueOnce({
            kodyKnowledgeApproval: { enabled: false },
        });
        parametersServiceMock.findByKey.mockImplementation((key: any) => {
            if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                return Promise.resolve({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-one',
                                isSelected: true,
                                directories: [],
                            },
                        ],
                    },
                });
            }
            if (key === ParametersKey.PLATFORM_CONFIGS) {
                return Promise.resolve({
                    configValue: { kodyLearningStatus: 'disabled' },
                });
            }
            return Promise.resolve(null);
        });
        createOrUpdateRuleUseCaseMock.execute.mockResolvedValue({
            uuid: 'rule-1',
        });

        await useCase.execute({ teamId: 'team-1', days: 7 } as any, 'org-1');

        expect(createOrUpdateRuleUseCaseMock.execute).toHaveBeenCalledWith(
            expect.objectContaining({
                status: KodyRulesStatus.ACTIVE,
                repositoryId: 'repo-1',
            }),
            'org-1',
            expect.anything(),
        );
    });

    it('throws (not "200, 0 rules") when PR fetch fails for every repo', async () => {
        parametersServiceMock.findByKey.mockImplementation((key: any) => {
            if (key === ParametersKey.CODE_REVIEW_CONFIG) {
                return Promise.resolve({
                    configValue: {
                        repositories: [
                            {
                                id: 'repo-1',
                                name: 'repo-one',
                                isSelected: true,
                                directories: [],
                            },
                        ],
                    },
                });
            }
            if (key === ParametersKey.PLATFORM_CONFIGS) {
                return Promise.resolve({
                    configValue: { kodyLearningStatus: 'enabled' },
                });
            }
            return Promise.resolve(null);
        });

        // null = fetch error (e.g. GitHub App install 404), distinct from [].
        codeManagementServiceMock.getPullRequestsByRepository.mockResolvedValue(
            null,
        );

        await expect(
            useCase.execute({ teamId: 'team-1', months: 3 } as any, 'org-1'),
        ).rejects.toThrow(
            /Could not fetch pull requests from the code management integration/,
        );

        // No rule persisted...
        expect(createOrUpdateRuleUseCaseMock.execute).not.toHaveBeenCalled();
        // ...and kodyLearningStatus is reset to ENABLED so the run isn't stuck.
        expect(
            createOrUpdateParametersUseCaseMock.execute,
        ).toHaveBeenCalledWith(
            ParametersKey.PLATFORM_CONFIGS,
            expect.objectContaining({ kodyLearningStatus: 'enabled' }),
            expect.anything(),
        );
    });
});

const longBody = 'x'.repeat(150);
const shortBody = 'LGTM';

describe('orderPullRequestsNewestFirst', () => {
    it('puts the most recent pull requests first', () => {
        const ordered = orderPullRequestsNewestFirst([
            { pull_number: 1, created_at: '2026-01-01T00:00:00Z' },
            { pull_number: 3, created_at: '2026-03-01T00:00:00Z' },
            { pull_number: 2, created_at: '2026-02-01T00:00:00Z' },
        ]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([3, 2, 1]);
    });

    it('accepts either date field name', () => {
        const ordered = orderPullRequestsNewestFirst([
            { pull_number: 1, createdAt: '2026-01-01T00:00:00Z' },
            { pull_number: 2, createdAt: '2026-05-01T00:00:00Z' },
        ]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([2, 1]);
    });

    // Bitbucket and Forgejo do not populate a creation date on this shape.
    // Their APIs already return newest-first, so the original order is better
    // information than anything we could invent — sorting undated entries to
    // the back would actively make the sample worse.
    it('preserves provider order when no date is available', () => {
        const ordered = orderPullRequestsNewestFirst<{
            pull_number: number;
            created_at?: string;
        }>([{ pull_number: 9 }, { pull_number: 8 }, { pull_number: 7 }]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([9, 8, 7]);
    });

    it('does not reorder around an unparseable date', () => {
        const ordered = orderPullRequestsNewestFirst([
            { pull_number: 1, created_at: 'not a date' },
            { pull_number: 2, created_at: '2026-05-01T00:00:00Z' },
        ]);

        expect(ordered.map((pr: any) => pr.pull_number)).toEqual([1, 2]);
    });

    it('leaves the caller\'s array alone', () => {
        const input = [
            { pull_number: 1, created_at: '2026-01-01T00:00:00Z' },
            { pull_number: 2, created_at: '2026-02-01T00:00:00Z' },
        ];
        orderPullRequestsNewestFirst(input);

        expect(input.map((pr) => pr.pull_number)).toEqual([1, 2]);
    });

    it('tolerates empty and missing input', () => {
        expect(orderPullRequestsNewestFirst([])).toEqual([]);
        expect(orderPullRequestsNewestFirst(undefined as any)).toEqual([]);
    });
});

describe('countSubstantiveComments', () => {
    // Mirrors commentAnalysis.service's own `body.length > 100`. Counting
    // "LGTM" toward the budget would stop the walk before it collected
    // anything a rule could be written from.
    it('counts only comments long enough to carry a convention', () => {
        expect(
            countSubstantiveComments({
                generalComments: [{ body: longBody }, { body: shortBody }],
                reviewComments: [{ body: longBody }],
            }),
        ).toBe(2);
    });

    it('treats missing sides and bodies as zero', () => {
        expect(countSubstantiveComments({})).toBe(0);
        expect(
            countSubstantiveComments({ reviewComments: [{}, { body: null }] }),
        ).toBe(0);
    });
});

describe('sampling budget', () => {
    // The whole point is a bounded worst case. 3 provider calls per PR times
    // the ceiling has to stay well inside GitHub's 5000/hour, or a customer
    // still loses their budget to onboarding.
    it('keeps the worst case far below an hourly GitHub budget', () => {
        const worstCaseRequests = MAX_PULL_REQUESTS_SCANNED * 3;

        expect(worstCaseRequests).toBeLessThanOrEqual(500);
    });
});

describe('fetchPullRequestComments (the walk itself)', () => {
    const makeUseCase = (perPrComments: number) => {
        const useCase: any = Object.create(GenerateKodyRulesUseCase.prototype);
        useCase.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        useCase.fetchSinglePullRequestComments = jest.fn(
            async (_repo: any, pr: any) => ({
                pr,
                generalComments: Array.from({ length: perPrComments }, () => ({
                    body: longBody,
                })),
                reviewComments: [],
                files: [],
            }),
        );
        return useCase;
    };

    // Oldest first, the way an API that ignores our sort would hand them over:
    // PR 1 is the oldest, PR n the newest.
    const prs = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
            pull_number: i + 1,
            created_at: new Date(
                Date.UTC(2026, 0, 1) + i * 60_000,
            ).toISOString(),
        }));

    // The bug: 816 PRs in the window meant 816 fetches (2448 API calls) to
    // build a list truncated to 100 comments.
    it('stops once the comment target is met instead of walking every PR', async () => {
        const useCase = makeUseCase(10);

        await useCase.fetchPullRequestComments({}, prs(816), {});

        const fetched = useCase.fetchSinglePullRequestComments.mock.calls
            .length;
        expect(fetched).toBeLessThanOrEqual(
            TARGET_SAMPLED_COMMENTS / 10 + PR_FETCH_CONCURRENCY,
        );
        expect(fetched).toBeLessThan(816);
    });

    // A repo full of "LGTM" never reaches the target, so the ceiling is the
    // only thing standing between it and the whole window.
    it('stops at the scan ceiling when the target is never reached', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(816), {});

        expect(
            useCase.fetchSinglePullRequestComments.mock.calls.length,
        ).toBe(MAX_PULL_REQUESTS_SCANNED);
    });

    it('walks a small repo completely and says nothing about stopping', async () => {
        const useCase = makeUseCase(1);

        const out = await useCase.fetchPullRequestComments({}, prs(12), {});

        expect(useCase.fetchSinglePullRequestComments.mock.calls.length).toBe(
            12,
        );
        expect(out).toHaveLength(12);
        expect(useCase.logger.log).not.toHaveBeenCalled();
    });

    // A cap that trims coverage silently reads as "this repo has no
    // conventions" when someone later wonders why the rule set is thin.
    it('reports what it left unscanned', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(816), {});

        expect(useCase.logger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    pullRequestsInWindow: 816,
                    pullRequestsScanned: MAX_PULL_REQUESTS_SCANNED,
                }),
            }),
        );
    });

    // The quality half of the bug: the old walk filled its quota in the order
    // the provider returned, so rules were learned from the OLDEST reviews in
    // the window -- the least current conventions in the repo.
    // Multi-tenant: "we stopped early on repo X" is unusable without knowing
    // whose repo X is, and this log is the only trace that coverage was
    // trimmed at all.
    it('names the organization when it reports an early stop', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(816), {
            organizationId: 'org-1',
        });

        expect(useCase.logger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ organizationId: 'org-1' }),
            }),
        );
    });

    // On gitlab.com the walk kept the token in 429 for 12 minutes after
    // onboarding, and the first review on the repo was skipped as
    // rate-limited. Once the provider refuses the rate, the sample is done.
    it('stops walking once the provider rate-limits a pull request', async () => {
        const useCase = makeUseCase(0);
        const plain =
            useCase.fetchSinglePullRequestComments.getMockImplementation();
        useCase.fetchSinglePullRequestComments.mockImplementation(
            async (repo: any, pr: any) => ({
                ...(await plain(repo, pr)),
                rateLimited: pr.pull_number === 810,
            }),
        );

        const out = await useCase.fetchPullRequestComments({}, prs(816), {});

        expect(
            useCase.fetchSinglePullRequestComments.mock.calls.length,
        ).toBeLessThanOrEqual(816 - 810 + PR_FETCH_CONCURRENCY);
        expect(out.length).toBeGreaterThan(0);
        expect(useCase.logger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ rateLimited: true }),
            }),
        );
    });

    it('flags a pull request whose fetch was refused with a 429', async () => {
        const useCase: any = Object.create(GenerateKodyRulesUseCase.prototype);
        useCase.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        const rateLimited = Object.assign(
            new Error('GitLab answered HTTP 429; retry after 1s'),
            { name: 'GitbeakerRetryError', status: 429 },
        );
        useCase.codeManagementService = {
            getAllCommentsInPullRequest: jest.fn(async () => []),
            getPullRequestReviewComment: jest.fn(async () => {
                throw rateLimited;
            }),
            getFilesByPullRequestId: jest.fn(async () => []),
        };

        // with429Retry backs off for seconds between attempts; run the clock
        // instead of waiting on it.
        jest.useFakeTimers();
        try {
            const pending = useCase.fetchSinglePullRequestComments(
                {},
                { pull_number: 1 },
                {},
            );
            await jest.runAllTimersAsync();
            const entry = await pending;

            expect(entry.rateLimited).toBe(true);
            expect(entry.reviewComments).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });

    // GitLab turns a failed general-comments fetch into [] unless asked to
    // throw, which hid the 429 from the walk.
    it('asks for general comments to fail loudly', async () => {
        const useCase: any = Object.create(GenerateKodyRulesUseCase.prototype);
        useCase.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        useCase.codeManagementService = {
            getAllCommentsInPullRequest: jest.fn(async () => []),
            getPullRequestReviewComment: jest.fn(async () => []),
            getFilesByPullRequestId: jest.fn(async () => []),
        };

        await useCase.fetchSinglePullRequestComments(
            {},
            { pull_number: 1 },
            {},
        );

        expect(
            useCase.codeManagementService.getAllCommentsInPullRequest,
        ).toHaveBeenCalledWith(expect.objectContaining({ failOnError: true }));
    });

    it('does not flag a pull request whose fetch failed for another reason', async () => {
        const useCase: any = Object.create(GenerateKodyRulesUseCase.prototype);
        useCase.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
        useCase.codeManagementService = {
            getAllCommentsInPullRequest: jest.fn(async () => []),
            getPullRequestReviewComment: jest.fn(async () => {
                throw new Error('404 Not Found');
            }),
            getFilesByPullRequestId: jest.fn(async () => []),
        };

        const entry = await useCase.fetchSinglePullRequestComments(
            {},
            { pull_number: 1 },
            {},
        );

        expect(entry.rateLimited).toBe(false);
    });

    it('takes the NEWEST pull requests, not the first ones the API returned', async () => {
        const useCase = makeUseCase(0);

        await useCase.fetchPullRequestComments({}, prs(300), {});

        const scanned = useCase.fetchSinglePullRequestComments.mock.calls.map(
            (call: any[]) => call[1].pull_number,
        );
        expect(scanned).toHaveLength(MAX_PULL_REQUESTS_SCANNED);
        expect(Math.max(...scanned)).toBe(300);
        expect(Math.min(...scanned)).toBe(300 - MAX_PULL_REQUESTS_SCANNED + 1);
    });
});

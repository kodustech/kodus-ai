import { ProcessFilesPrLevelReviewStage } from '@/code-review/pipeline/stages/process-files-pr-level-review.stage';
import posthog from '@libs/common/utils/posthog';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
    createThreadId: jest.fn(),
}));

jest.mock('@libs/common/utils/posthog', () => ({
    __esModule: true,
    default: {
        isFeatureEnabled: jest.fn(),
    },
    FEATURE_FLAGS: {
        businessLogic: 'business-logic',
    },
}));

describe('ProcessFilesPrLevelReviewStage', () => {
    let stage: ProcessFilesPrLevelReviewStage;
    let businessRulesValidationAgentProvider: {
        execute: jest.Mock;
    };

    beforeEach(() => {
        businessRulesValidationAgentProvider = {
            execute: jest.fn(),
        };
        stage = new ProcessFilesPrLevelReviewStage(
            {} as any,
            {} as any,
            businessRulesValidationAgentProvider as any,
        );
        jest.clearAllMocks();
    });

    it('should run business logic validation when a ticket key exists', async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: {
                reviewOptions: {
                    business_logic: true,
                },
            },
            pullRequest: {
                number: 42,
                body: 'Implements ACME-123 with acceptance criteria updates',
            },
            pipelineMetadata: {},
        } as any;

        const shouldRun = await (stage as any).shouldRunBusinessLogicValidation(
            context,
        );

        expect(shouldRun).toBe(true);
    });

    it('should not run business logic validation when only requirement keywords exist without task id or link', async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);

        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: {
                reviewOptions: {
                    business_logic: true,
                },
            },
            pullRequest: {
                number: 42,
                body: 'This PR includes acceptance criteria and given/when/then details only.',
            },
            pipelineMetadata: {},
        } as any;

        const shouldRun = await (stage as any).shouldRunBusinessLogicValidation(
            context,
        );

        expect(shouldRun).toBe(false);
    });

    it('builds business-logic prepareContext using the nested pullRequest contract expected by the provider', async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);
        businessRulesValidationAgentProvider.execute.mockResolvedValue(
            '## Business Rules Validation\n\n**Status:** Issues Found',
        );

        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: {
                reviewOptions: {
                    business_logic: true,
                },
            },
            repository: {
                id: 'repo-1',
                name: 'repo-name',
            },
            platformType: 'github',
            pullRequest: {
                number: 42,
                body: 'Implements ACME-123 with acceptance criteria updates',
                head: { ref: 'feature/acme-123' },
                base: { ref: 'main' },
            },
            changedFiles: [],
            pipelineMetadata: {},
            errors: [],
        } as any;

        await (stage as any).runBusinessLogicValidation(context);

        expect(
            businessRulesValidationAgentProvider.execute,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                organizationAndTeamData: context.organizationAndTeamData,
                prepareContext: expect.objectContaining({
                    userQuestion: '@kody -v business-logic',
                    repository: context.repository,
                    pullRequestDescription: context.pullRequest.body,
                    businessSignals: {
                        ticketKeys: ['ACME-123'],
                        taskLinks: [],
                        requirementKeywords: ['acceptance criteria'],
                    },
                    pullRequest: {
                        pullRequestNumber: 42,
                        headRef: 'feature/acme-123',
                        baseRef: 'main',
                    },
                }),
            }),
        );
    });

    it('does not create a business-logic suggestion when the provider returns a limitation response', async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);
        businessRulesValidationAgentProvider.execute
            .mockResolvedValue(`## 🤔 Need Pull Request Diff

I found enough task context to understand the expected behavior, but I couldn't load the pull request diff.`);

        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: {
                reviewOptions: {
                    business_logic: true,
                },
            },
            repository: {
                id: 'repo-1',
                name: 'repo-name',
            },
            platformType: 'github',
            pullRequest: {
                number: 42,
                body: 'Implements ACME-123 with acceptance criteria updates',
                head: { ref: 'feature/acme-123' },
                base: { ref: 'main' },
            },
            changedFiles: [],
            pipelineMetadata: {},
            errors: [],
        } as any;

        const result = await (stage as any).runBusinessLogicValidation(context);

        expect(result.businessLogicResults).toEqual([]);
    });

    it('does not create a business-logic suggestion when the provider returns a limitation response in pt-BR', async () => {
        (posthog.isFeatureEnabled as jest.Mock).mockResolvedValue(true);
        businessRulesValidationAgentProvider.execute
            .mockResolvedValue(`## 🤔 Preciso do Diff da Pull Request

Encontrei contexto suficiente da task, mas nao consegui carregar o diff da pull request. Sem as alteracoes de codigo, nao consigo validar se a implementacao atende aos requisitos de negocio.`);

        const context = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: {
                reviewOptions: {
                    business_logic: true,
                },
            },
            repository: {
                id: 'repo-1',
                name: 'repo-name',
            },
            platformType: 'github',
            pullRequest: {
                number: 42,
                body: 'Implementa ACME-123 com criterios de aceitacao',
                head: { ref: 'feature/acme-123' },
                base: { ref: 'main' },
            },
            changedFiles: [],
            pipelineMetadata: {},
            errors: [],
        } as any;

        const result = await (stage as any).runBusinessLogicValidation(context);

        expect(result.businessLogicResults).toEqual([]);
    });

    describe('signal sources beyond the PR body', () => {
        const ctx = (overrides: Record<string, unknown>) => ({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            codeReviewConfig: { reviewOptions: { business_logic: true } },
            repository: { id: 'repo-1', name: 'repo-name' },
            platformType: 'github',
            pullRequest: {
                number: 42,
                body: '',
                title: '',
                head: { ref: '' },
                base: { ref: 'main' },
            },
            changedFiles: [],
            pipelineMetadata: {},
            errors: [],
            ...overrides,
        });

        it('triggers when the ticket key is only in the PR title', async () => {
            const context = ctx({
                pullRequest: {
                    number: 42,
                    body: 'No identifier here',
                    title: '[DL-2773] Add print working mode',
                    head: { ref: 'feature/print-mode' },
                    base: { ref: 'main' },
                },
            });

            const shouldRun = await (
                stage as any
            ).shouldRunBusinessLogicValidation(context);

            expect(shouldRun).toBe(true);
        });

        it('triggers when the ticket key is only in the branch (lowercase)', async () => {
            const context = ctx({
                pullRequest: {
                    number: 42,
                    body: 'No identifier here',
                    title: 'Print working mode',
                    head: { ref: 'feat/dl-2773-print-mode' },
                    base: { ref: 'main' },
                },
            });

            const shouldRun = await (
                stage as any
            ).shouldRunBusinessLogicValidation(context);

            expect(shouldRun).toBe(true);
        });

        it('passes title-derived ticket keys to the agent', async () => {
            businessRulesValidationAgentProvider.execute.mockResolvedValue(
                '## Business Rules Validation\n\nStatus: no gaps',
            );

            const context = ctx({
                pullRequest: {
                    number: 42,
                    body: '',
                    title: '[DL-2773] Add print working mode',
                    head: { ref: 'feature/print-mode' },
                    base: { ref: 'main' },
                },
            });

            await (stage as any).runBusinessLogicValidation(context);

            expect(
                businessRulesValidationAgentProvider.execute,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    prepareContext: expect.objectContaining({
                        businessSignals: expect.objectContaining({
                            ticketKeys: ['DL-2773'],
                        }),
                    }),
                }),
            );
        });

        it('passes branch-derived ticket keys (lowercase) to the agent, uppercased and deduped', async () => {
            businessRulesValidationAgentProvider.execute.mockResolvedValue(
                '## Business Rules Validation\n\nStatus: no gaps',
            );

            const context = ctx({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773',
                    title: '[DL-2773] Add print working mode',
                    head: { ref: 'feat/dl-2773-print-mode' },
                    base: { ref: 'main' },
                },
            });

            await (stage as any).runBusinessLogicValidation(context);

            const call =
                businessRulesValidationAgentProvider.execute.mock.calls[0][0];
            expect(call.prepareContext.businessSignals.ticketKeys).toEqual([
                'DL-2773',
            ]);
        });

        it('does not flag requirement keywords that appear only in the title', async () => {
            businessRulesValidationAgentProvider.execute.mockResolvedValue(
                '## Business Rules Validation\n\nStatus: no gaps',
            );

            const context = ctx({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773 — refactor logging only.',
                    title: 'Fix crash when user clicks save',
                    head: { ref: 'feat/dl-2773-fix' },
                    base: { ref: 'main' },
                },
            });

            await (stage as any).runBusinessLogicValidation(context);

            const call =
                businessRulesValidationAgentProvider.execute.mock.calls[0][0];
            expect(
                call.prepareContext.businessSignals.requirementKeywords,
            ).toEqual([]);
        });
    });
});

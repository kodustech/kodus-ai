import { BusinessLogicValidationStage } from '@/code-review/pipeline/stages/business-logic-validation.stage';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';

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

type JiraConnection = {
    appName: string;
    provider: string;
    organizationId: string;
};

const jiraConnection = (organizationId: string): JiraConnection => ({
    appName: 'Jira',
    provider: 'jira',
    organizationId,
});

describe('BusinessLogicValidationStage', () => {
    let stage: BusinessLogicValidationStage;
    let agentProvider: { execute: jest.Mock };
    let mcpManagerService: { getConnections: jest.Mock };

    const buildContext = (overrides: Record<string, unknown> = {}) => ({
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        codeReviewConfig: {
            reviewOptions: { business_logic: true },
        },
        repository: { id: 'repo-1', name: 'repo-name' },
        platformType: 'github',
        pullRequest: {
            number: 42,
            body: '',
            title: '',
            head: { ref: '' },
            base: { ref: 'main' },
        },
        pipelineMetadata: {},
        errors: [],
        ...overrides,
    });

    beforeEach(() => {
        agentProvider = { execute: jest.fn() };
        mcpManagerService = {
            getConnections: jest.fn().mockResolvedValue([jiraConnection('org-1')]),
        };
        stage = new BusinessLogicValidationStage(
            agentProvider as any,
            mcpManagerService as any,
        );
        jest.clearAllMocks();
    });

    describe('evaluateSkip', () => {
        it('does not skip when ticket key is only in PR title', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Some prose without identifiers',
                    title: '[DL-2773] Add print working mode',
                    head: { ref: 'feature/print-mode' },
                    base: { ref: 'main' },
                },
            });

            const decision = await (stage as any).evaluateSkip(context);

            expect(decision).toBeNull();
        });

        it('does not skip when ticket key is only in the branch (lowercase)', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'No ticket here',
                    title: 'Print mode',
                    head: { ref: 'feat/dl-2773-print-mode' },
                    base: { ref: 'main' },
                },
            });

            const decision = await (stage as any).evaluateSkip(context);

            expect(decision).toBeNull();
        });

        it('skips with no_signals when title, branch and body have no ticket key or matching URL', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Just a refactor',
                    title: 'Refactor logging',
                    head: { ref: 'chore/refactor-logging' },
                    base: { ref: 'main' },
                },
            });

            const decision = await (stage as any).evaluateSkip(context);

            expect(decision).toEqual(
                expect.objectContaining({ reason: 'no_signals' }),
            );
        });
    });

    describe('executeStage', () => {
        beforeEach(() => {
            agentProvider.execute.mockResolvedValue(
                '## Business Rules Validation\n\nStatus: no gaps',
            );
        });

        it('passes a ticket key found in the PR title to the agent', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'No identifier in the body',
                    title: '[DL-2773] Add print working mode',
                    head: { ref: 'feature/print-mode' },
                    base: { ref: 'main' },
                },
            });

            await stage.execute(context as any);

            expect(agentProvider.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    prepareContext: expect.objectContaining({
                        businessSignals: expect.objectContaining({
                            ticketKeys: ['DL-2773'],
                        }),
                    }),
                }),
            );
        });

        it('passes a ticket key found in the branch name (lowercase) to the agent, normalized to uppercase', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: '',
                    title: 'Print working mode',
                    head: { ref: 'feat/dl-2773-print-mode' },
                    base: { ref: 'main' },
                },
            });

            await stage.execute(context as any);

            expect(agentProvider.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    prepareContext: expect.objectContaining({
                        businessSignals: expect.objectContaining({
                            ticketKeys: ['DL-2773'],
                        }),
                    }),
                }),
            );
        });

        it('deduplicates ticket keys when the same key appears across body, title and branch', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773',
                    title: '[DL-2773] Add print mode',
                    head: { ref: 'feat/dl-2773-print-mode' },
                    base: { ref: 'main' },
                },
            });

            await stage.execute(context as any);

            const call = agentProvider.execute.mock.calls[0][0];
            expect(call.prepareContext.businessSignals.ticketKeys).toEqual([
                'DL-2773',
            ]);
        });

        it('does not flag requirement keywords that appear only in the title (false-positive guard)', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773 to refactor logging.',
                    title: 'Fix crash when user clicks save',
                    head: { ref: 'feat/dl-2773-fix-crash' },
                    base: { ref: 'main' },
                },
            });

            await stage.execute(context as any);

            const call = agentProvider.execute.mock.calls[0][0];
            expect(
                call.prepareContext.businessSignals.requirementKeywords,
            ).toEqual([]);
        });

        it('still picks up requirement keywords from the body', async () => {
            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body:
                        'Acceptance criteria for DL-2773:\n' +
                        'Given a user, when X happens, then Y.',
                    title: 'Add print mode',
                    head: { ref: 'feat/dl-2773' },
                    base: { ref: 'main' },
                },
            });

            await stage.execute(context as any);

            const call = agentProvider.execute.mock.calls[0][0];
            expect(
                call.prepareContext.businessSignals.requirementKeywords,
            ).toEqual(
                expect.arrayContaining([
                    'acceptance criteria',
                    'given',
                    'when',
                    'then',
                ]),
            );
        });
    });

    describe('computePrBodyHash', () => {
        it('only depends on the PR body — title-only edits should not re-trigger reviews', () => {
            const hash1 = (stage as any).computePrBodyHash('same body');
            const hash2 = (stage as any).computePrBodyHash('same body');
            expect(hash1).toBe(hash2);
        });
    });

    describe('detectTicketKeys', () => {
        it('matches uppercase keys', () => {
            const keys = (stage as any).detectTicketKeys('Implements ACME-123');
            expect(keys).toEqual(['ACME-123']);
        });

        it('matches lowercase keys and normalizes to uppercase', () => {
            const keys = (stage as any).detectTicketKeys(
                'feat/dl-2773-print-mode',
            );
            expect(keys).toEqual(['DL-2773']);
        });

        it('deduplicates repeated occurrences', () => {
            const keys = (stage as any).detectTicketKeys(
                'DL-2773 dl-2773 DL-2773',
            );
            expect(keys).toEqual(['DL-2773']);
        });
    });

    describe('hasRelevantBusinessSignals', () => {
        it('matches when a lowercase ticket key sits in the combined source', () => {
            const result = (stage as any).hasRelevantBusinessSignals(
                'feat/dl-2773-print-mode',
                ['jira'],
            );
            expect(result).toBe(true);
        });
    });

    describe('skip when no task MCP connected', () => {
        it('returns a skip decision when only non-task MCPs are connected', async () => {
            mcpManagerService.getConnections.mockResolvedValue([
                { appName: 'Slack', provider: 'slack', organizationId: 'org-1' },
            ]);

            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773',
                    title: '',
                    head: { ref: '' },
                    base: { ref: 'main' },
                },
            });

            const decision = await (stage as any).evaluateSkip(context);

            expect(decision).toEqual(
                expect.objectContaining({ reason: 'no_task_mcp' }),
            );
        });
    });

    describe('agent NO_TASK_MCP sentinel handling', () => {
        it('skips silently with no_task_mcp outcome when the agent returns the sentinel', async () => {
            agentProvider.execute.mockResolvedValue(
                BusinessRulesValidationAgentProvider.NO_TASK_MCP_SENTINEL,
            );

            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773',
                    title: '',
                    head: { ref: '' },
                    base: { ref: 'main' },
                },
            });

            const result = await stage.execute(context as any);

            expect(result.businessLogicResults).toEqual([]);
            expect(result.businessLogicOutcome).toEqual(
                expect.objectContaining({
                    kind: 'skipped',
                    reason: 'no_task_mcp',
                }),
            );
        });
    });
});

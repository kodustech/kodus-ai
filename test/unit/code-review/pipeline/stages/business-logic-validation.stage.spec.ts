import { BusinessLogicValidationStage } from '@/code-review/pipeline/stages/business-logic-validation.stage';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent';

jest.mock('@libs/common/utils/thread-id', () => ({
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
    let mcpManagerService: {
        getConnections: jest.Mock;
        getIntegrations: jest.Mock;
    };

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
            getIntegrations: jest.fn().mockResolvedValue([]),
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
                    title: 'LKDB-286 Add print working mode',
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

    describe('one-shot gate', () => {
        const withTicket = (overrides: Record<string, unknown> = {}) =>
            buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773',
                    title: '',
                    head: { ref: '' },
                    base: { ref: 'main' },
                },
                ...overrides,
            });

        it('runs when the PR has never been validated', async () => {
            const decision = await (stage as any).evaluateSkip(withTicket());
            expect(decision).toBeNull();
        });

        it('skips once the PR has already been validated', async () => {
            const decision = await (stage as any).evaluateSkip(
                withTicket({
                    pipelineMetadata: {
                        lastExecution: {
                            businessLogicValidatedAt: '2026-09-02T17:23:23.000Z',
                        },
                    },
                }),
            );

            expect(decision).toEqual(
                expect.objectContaining({ reason: 'already_validated' }),
            );
        });

        it('still skips when the PR body changed after the first validation', async () => {
            const decision = await (stage as any).evaluateSkip(
                withTicket({
                    pullRequest: {
                        number: 42,
                        body: 'Implements DL-2773 — description rewritten since',
                        title: '',
                        head: { ref: '' },
                        base: { ref: 'main' },
                    },
                    pipelineMetadata: {
                        lastExecution: {
                            businessLogicValidatedAt: '2026-09-02T17:23:23.000Z',
                        },
                    },
                }),
            );

            expect(decision).toEqual(
                expect.objectContaining({ reason: 'already_validated' }),
            );
        });

        it('re-runs for @kody review --force even when already validated', async () => {
            const decision = await (stage as any).evaluateSkip(
                withTicket({
                    origin: 'command-force',
                    pipelineMetadata: {
                        lastExecution: {
                            businessLogicValidatedAt: '2026-09-02T17:23:23.000Z',
                        },
                    },
                }),
            );

            expect(decision).toBeNull();
        });

        it('does not re-run on a force-push, which sets forceFullRerun without a user asking', async () => {
            const decision = await (stage as any).evaluateSkip(
                withTicket({
                    origin: 'automation',
                    pipelineMetadata: {
                        forceFullRerun: true,
                        lastExecution: {
                            businessLogicValidatedAt: '2026-09-02T17:23:23.000Z',
                        },
                    },
                }),
            );

            expect(decision).toEqual(
                expect.objectContaining({ reason: 'already_validated' }),
            );
        });

        it('honours the legacy body-hash marker left by earlier releases', async () => {
            const decision = await (stage as any).evaluateSkip(
                withTicket({
                    pipelineMetadata: {
                        lastExecution: { businessLogicHash: 'a-stored-hash' },
                    },
                }),
            );

            expect(decision).toEqual(
                expect.objectContaining({ reason: 'already_validated' }),
            );
        });
    });

    describe('validation marker', () => {
        const ticketContext = () =>
            buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Implements DL-2773',
                    title: '',
                    head: { ref: '' },
                    base: { ref: 'main' },
                },
            });

        it('marks the PR as validated when a gap is reported', async () => {
            agentProvider.execute.mockResolvedValue('Business logic gap found');

            const result = await stage.execute(ticketContext() as any);

            expect(result.businessLogicValidatedAt).toEqual(expect.any(String));
        });

        it('marks the PR as validated when the PR is aligned', async () => {
            agentProvider.execute.mockResolvedValue('No gaps found');

            const result = await stage.execute(ticketContext() as any);

            expect(result.businessLogicValidatedAt).toEqual(expect.any(String));
        });

        it('marks the PR as validated when weak task context is reported to the author', async () => {
            agentProvider.execute.mockResolvedValue(
                `${BusinessRulesValidationAgentProvider.WEAK_TASK_CONTEXT_MARKER}\n## Need Task Information`,
            );

            const result = await stage.execute(ticketContext() as any);

            expect(result.businessLogicResults).toHaveLength(1);
            expect(result.businessLogicValidatedAt).toEqual(expect.any(String));
        });

        it('leaves the PR unmarked when the agent fails, so a transient error stays retryable', async () => {
            agentProvider.execute.mockRejectedValue(new Error('boom'));

            const result = await stage.execute(ticketContext() as any);

            expect(result.businessLogicValidatedAt).toBeUndefined();
        });

        it('leaves the PR unmarked when nothing was posted to the author', async () => {
            agentProvider.execute.mockResolvedValue(
                'MCP connection failed while reading the task',
            );

            const result = await stage.execute(ticketContext() as any);

            expect(result.businessLogicResults).toEqual([]);
            expect(result.businessLogicValidatedAt).toBeUndefined();
        });
    });

    describe('automatic-run footer', () => {
        it('tells the author how to re-run the validation on demand', async () => {
            agentProvider.execute.mockResolvedValue('Business logic gap found');

            const result = await stage.execute(
                buildContext({
                    pullRequest: {
                        number: 42,
                        body: 'Implements DL-2773',
                        title: '',
                        head: { ref: '' },
                        base: { ref: 'main' },
                    },
                }) as any,
            );

            expect(result.businessLogicResults?.[0].suggestionContent).toContain(
                '@kody -v business-logic',
            );
        });

        it('omits the footer when the user asked for this run explicitly', async () => {
            agentProvider.execute.mockResolvedValue('Business logic gap found');

            const result = await stage.execute(
                buildContext({
                    origin: 'command-force',
                    pullRequest: {
                        number: 42,
                        body: 'Implements DL-2773',
                        title: '',
                        head: { ref: '' },
                        base: { ref: 'main' },
                    },
                }) as any,
            );

            expect(
                result.businessLogicResults?.[0].suggestionContent,
            ).not.toContain('@kody -v business-logic');
        });
    });

    describe('detectTicketKeys', () => {
        it('matches Jira-style keys with underscores', () => {
            const keys = (stage as any).detectTicketKeys('Implements PROJ_1-42');
            expect(keys).toEqual(['PROJ_1-42']);
        });

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

        it('matches Jira keys when Atlassian Rovo is the connected MCP', () => {
            const result = (stage as any).hasRelevantBusinessSignals(
                'LKDB-286 refactor logging',
                ['atlassianrovo'],
            );
            expect(result).toBe(true);
        });
    });

    describe('skip when no task MCP connected', () => {
        it('returns a skip decision when only non-task MCPs are connected', async () => {
            mcpManagerService.getConnections.mockResolvedValue([
                { appName: 'Slack', provider: 'slack', organizationId: 'org-1' },
            ]);
            mcpManagerService.getIntegrations.mockResolvedValue([]);

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

        it('does not skip when Atlassian Rovo OAuth is active without a connection row', async () => {
            mcpManagerService.getConnections.mockResolvedValue([]);
            mcpManagerService.getIntegrations.mockResolvedValue([
                {
                    id: 'atlassian-rovo-default',
                    name: 'Atlassian Rovo',
                    appName: 'Atlassian Rovo',
                    provider: 'kodusmcp',
                    active: true,
                    isConnected: false,
                },
            ]);

            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: 'Implements LKDB-286',
                    title: '',
                    head: { ref: '' },
                    base: { ref: 'main' },
                },
            });

            const decision = await (stage as any).evaluateSkip(context);

            expect(decision).toBeNull();
        });

        it('does not skip for a custom MCP named Jira with only OAuth active', async () => {
            mcpManagerService.getConnections.mockResolvedValue([]);
            mcpManagerService.getIntegrations.mockResolvedValue([
                {
                    id: 'custom-jira-1',
                    name: 'Company Jira',
                    appName: 'Company Jira',
                    provider: 'custom',
                    active: true,
                    isConnected: false,
                },
            ]);

            const context = buildContext({
                pullRequest: {
                    number: 42,
                    body: '',
                    title: 'LKDB-286 Fix checkout',
                    head: { ref: '' },
                    base: { ref: 'main' },
                },
            });

            const decision = await (stage as any).evaluateSkip(context);

            expect(decision).toBeNull();
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

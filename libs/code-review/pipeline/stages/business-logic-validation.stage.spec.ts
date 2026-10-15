import type { BusinessValidationOutcome } from '@libs/agents/business-validation/business-validation.types';

import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { BusinessLogicValidationStage } from './business-logic-validation.stage';

const ORG = { organizationId: 'org-1', teamId: 'team-1' };
const TASK = { tracker: 'Linear', id: 'PLAT-41', title: 'Scale servings' };

function build(
    outcome: BusinessValidationOutcome | Error,
    wholeDiff?: Array<{ filename: string; status: string; patch: string }>,
    { lastVerdictFailed = false } = {},
) {
    const service = {
        validate: jest.fn(async () => {
            if (outcome instanceof Error) {
                throw outcome;
            }
            return { outcome, references: [], attempts: [], trackers: [] };
        }),
    };
    const publisher = {
        publish: jest.fn(async (input: { result: { outcome: unknown } }) => ({
            outcome: input.result.outcome,
            comment: 'created',
        })),
        lastVerdictFailed: jest.fn(async () => lastVerdictFailed),
        withRepository: jest.fn((request: unknown) => request),
    };
    const pullRequests = {
        getChangedFilesMetadata: jest.fn(async () => wholeDiff ?? []),
    };
    return {
        stage: new BusinessLogicValidationStage(
            service as any,
            publisher as any,
            pullRequests as any,
        ),
        service,
        publisher,
        pullRequests,
    };
}

const context = (overrides: Partial<CodeReviewPipelineContext> = {}) =>
    frozenContext({
        organizationAndTeamData: ORG,
        repository: { id: 'repo-1', name: 'recipes', fullName: 'acme/recipes' },
        pullRequest: {
            number: 42,
            title: 'feat(PLAT-41): scale servings',
            body: 'Adds scaling.',
            head: { ref: 'feat/plat-41', sha: 'abc1234' },
            base: { ref: 'main' },
            user: { login: 'rafa' },
        },
        platformType: 'github',
        codeReviewConfig: {
            reviewOptions: { business_logic: true },
            byokModel: 'gpt-5.4',
            byokModelId: 'model-main',
        },
        changedFiles: [{ filename: 'a.ts', status: 'modified', patch: '+x' }],
        prAllCommits: [
            {
                sha: 'abc1234',
                commit: {
                    author: {
                        name: 'rafa',
                        email: 'rafa@example.com',
                        date: '',
                    },
                    message:
                        'feat: scale\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
                },
            },
        ],
        pipelineMetadata: {},
        errors: [],
        ...overrides,
    } as unknown as CodeReviewPipelineContext);

const validated = (passed: boolean) =>
    ({
        kind: 'validated',
        checks: [
            {
                task: TASK,
                verdict: {
                    needsMoreInfo: false,
                    summary: 'x',
                    status: passed ? 'compliant' : 'issues_found',
                    requirements: [],
                },
                passed,
                readAt: '2026-10-05T00:00:00.000Z',
            },
        ],
        thinTasks: [],
        passed,
        unseenFiles: [],
    }) as BusinessValidationOutcome;

describe('BusinessLogicValidationStage', () => {
    it('judges the whole PR after a push, not only the files of that push', async () => {
        const { stage, service, pullRequests } = build(validated(true), [
            { filename: 'filter.ts', status: 'added', patch: '+filter' },
            { filename: 'a.ts', status: 'modified', patch: '+x' },
        ]);

        await stage.execute(
            context({
                lastExecution: { lastAnalyzedCommit: 'old1234' },
                codeReviewConfig: {
                    reviewOptions: { business_logic: true },
                    businessLogic: { recheckOn: 'push' },
                },
            } as any),
        );

        expect(pullRequests.getChangedFilesMetadata).toHaveBeenCalledWith(
            ORG,
            expect.objectContaining({ id: 'repo-1' }),
            expect.objectContaining({ number: 42 }),
        );
        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                diff: expect.stringContaining('filter.ts'),
            }),
        );
    });

    it('leaves out of the whole PR what the team ignores and deleted files', async () => {
        const { stage, service } = build(validated(true), [
            { filename: 'filter.ts', status: 'added', patch: '+filter' },
            { filename: 'pnpm-lock.yaml', status: 'modified', patch: '+lock' },
            { filename: 'old.ts', status: 'removed', patch: '-old' },
        ]);

        await stage.execute(
            context({
                lastExecution: { lastAnalyzedCommit: 'old1234' },
                codeReviewConfig: {
                    reviewOptions: { business_logic: true },
                    businessLogic: { recheckOn: 'push' },
                    ignorePaths: ['**/*.yaml'],
                },
            } as any),
        );

        const { diff } = (service.validate.mock.calls[0] as any)[0];
        expect(diff).toContain('filter.ts');
        expect(diff).not.toContain('pnpm-lock.yaml');
        expect(diff).not.toContain('old.ts');
    });

    it('uses the files it already has on the first review', async () => {
        const { stage, pullRequests } = build(validated(true));

        await stage.execute(context());

        expect(pullRequests.getChangedFilesMetadata).not.toHaveBeenCalled();
    });

    it('sends the PR, its diff, the model override and the settings to the service', async () => {
        const { stage, service } = build(validated(true));

        await stage.execute(
            context({
                codeReviewConfig: {
                    reviewOptions: { business_logic: true },
                    byokModel: 'gpt-5.4',
                    byokModelId: 'model-main',
                    businessLogic: { recheckOn: 'push' },
                },
            } as any),
        );

        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({
                door: 'auto',
                organizationAndTeamData: ORG,
                repository: {
                    id: 'repo-1',
                    name: 'recipes',
                    fullName: 'acme/recipes',
                },
                pullRequest: expect.objectContaining({
                    number: 42,
                    title: 'feat(PLAT-41): scale servings',
                    headRef: 'feat/plat-41',
                }),
                diff: expect.stringContaining('=== FILE: a.ts ==='),
                byokModel: 'gpt-5.4',
                byokModelId: 'model-main',
                settings: expect.objectContaining({ recheckOn: 'push' }),
            }),
        );
    });

    it('publishes the outcome with the head commit, the trigger and the commits', async () => {
        const { stage, publisher } = build(validated(true));

        await stage.execute(context());

        expect(publisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({
                headSha: 'abc1234',
                trigger: 'auto',
                authorLogin: 'rafa',
                commits: [
                    expect.objectContaining({
                        message: expect.stringContaining(
                            'Co-Authored-By: Claude',
                        ),
                    }),
                ],
            }),
        );
    });

    it.each([
        [
            'option_off',
            { codeReviewConfig: { reviewOptions: { business_logic: false } } },
        ],
        [
            'already_validated',
            {
                pipelineMetadata: {
                    lastExecution: { businessLogicValidatedAt: 'x' },
                },
            },
        ],
    ])('skips without calling the service: %s', async (reason, overrides) => {
        const { stage, service, publisher } = build(validated(true));

        const result = await stage.execute(context(overrides as any));

        expect(service.validate).not.toHaveBeenCalled();
        expect(publisher.publish).not.toHaveBeenCalled();
        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason,
        });
        expect(result.businessLogicResults).toEqual([]);
    });

    it('re-checks a PR already validated on a push while its last check failed', async () => {
        const { stage, service, publisher } = build(validated(true), [], {
            lastVerdictFailed: true,
        });

        await stage.execute(
            context({
                pipelineMetadata: {
                    lastExecution: { businessLogicValidatedAt: 'x' },
                },
            } as any),
        );

        expect(publisher.lastVerdictFailed).toHaveBeenCalledWith({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            pullRequestNumber: 42,
        });
        expect(service.validate).toHaveBeenCalled();
        expect(publisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'push' }),
        );
    });

    it('re-checks only on request when the team chose that, even after a failed check', async () => {
        const { stage, service } = build(validated(true), [], {
            lastVerdictFailed: true,
        });

        const result = await stage.execute(
            context({
                codeReviewConfig: {
                    reviewOptions: { business_logic: true },
                    businessLogic: { recheckOn: 'request' },
                },
                pipelineMetadata: {
                    lastExecution: { businessLogicValidatedAt: 'x' },
                },
            } as any),
        );

        expect(service.validate).not.toHaveBeenCalled();
        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason: 'already_validated',
        });
    });

    it('fails the review outcome when no task is referenced and the repository requires one', async () => {
        const { stage } = build({
            kind: 'task_required',
            message: 'This repository requires a task',
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'gap_found',
        });
        expect(result.businessLogicValidatedAt).toBeDefined();
    });

    it('fails the review outcome on a typo when the repository requires a task', async () => {
        const { stage } = build({
            kind: 'task_missing',
            references: [],
            tracker: 'Linear',
            message: '',
            required: true,
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'gap_found',
        });
    });

    it('leaves a typo as skipped when the repository does not require a task', async () => {
        const { stage } = build({
            kind: 'task_missing',
            references: [],
            tracker: 'Linear',
            message: '',
            required: false,
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason: 'task_missing',
        });
    });

    it('re-checks a PR already validated when the team turned on re-check on every push (UC-35)', async () => {
        const { stage, service, publisher } = build(validated(true));

        await stage.execute(
            context({
                codeReviewConfig: {
                    reviewOptions: { business_logic: true },
                    businessLogic: { recheckOn: 'push' },
                },
                pipelineMetadata: {
                    lastExecution: { businessLogicValidatedAt: 'x' },
                },
            } as any),
        );

        expect(service.validate).toHaveBeenCalled();
        expect(publisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'push' }),
        );
    });

    it('revalidates on @kody review --force, with door "force"', async () => {
        const { stage, service, publisher } = build(validated(true));

        await stage.execute(
            context({
                origin: 'command-force',
                pipelineMetadata: {
                    lastExecution: { businessLogicValidatedAt: 'x' },
                },
            } as any),
        );

        expect(service.validate).toHaveBeenCalledWith(
            expect.objectContaining({ door: 'force' }),
        );
        expect(publisher.publish).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'force' }),
        );
    });

    it('records a skip without marking the PR validated (no task, tracker down, ...)', async () => {
        const { stage } = build({
            kind: 'skipped',
            reason: 'tracker_unavailable',
            message: 'Linear did not answer',
        });

        const result = await stage.execute(context());

        expect(result.businessLogicResults).toEqual([]);
        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason: 'tracker_unavailable',
        });
        expect(result.businessLogicValidatedAt).toBeUndefined();
    });

    it('marks the PR validated when the task is too thin to judge', async () => {
        const { stage } = build({
            kind: 'task_too_thin',
            tasks: [TASK],
            message: 'PLAT-41 has only a title',
        });

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason: 'weak_task_context',
        });
        expect(result.businessLogicValidatedAt).toBeDefined();
    });

    // #2019: the verdict decides, whatever the report says and in any language.
    it.each([
        [true, 'success'],
        [false, 'gap_found'],
    ] as const)('maps a verdict that passed=%s to %s', async (passed, kind) => {
        const { stage } = build(validated(passed));

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({ kind });
        // The comment is the publisher's; nothing goes through PR-level suggestions.
        expect(result.businessLogicResults).toEqual([]);
    });

    it('records an error without aborting the pipeline when the service throws', async () => {
        const { stage } = build(new Error('boom'));

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({ kind: 'error' });
        expect(result.errors).toHaveLength(1);
    });

    it('leaves no timeout pending once the service has answered', async () => {
        jest.useFakeTimers();
        try {
            const { stage } = build(validated(true));
            await stage.execute(context());
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});

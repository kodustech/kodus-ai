import type { BusinessValidationOutcome } from '@libs/agents/business-validation/business-validation.types';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { BusinessLogicValidationStage } from './business-logic-validation.stage';

const ORG = { organizationId: 'org-1', teamId: 'team-1' };
const TASK = { tracker: 'Linear', id: 'PLAT-41', title: 'Scale servings' };

function build(outcome: BusinessValidationOutcome | Error) {
    const service = {
        validate: jest.fn(async () => {
            if (outcome instanceof Error) {
                throw outcome;
            }
            return { outcome, references: [], attempts: [] };
        }),
    };
    return { stage: new BusinessLogicValidationStage(service as any), service };
}

const context = (overrides: Partial<CodeReviewPipelineContext> = {}) =>
    frozenContext({
        organizationAndTeamData: ORG,
        repository: { id: 'repo-1', name: 'recipes', fullName: 'acme/recipes' },
        pullRequest: {
            number: 42,
            title: 'feat(PLAT-41): scale servings',
            body: 'Adds scaling.',
            head: { ref: 'feat/plat-41' },
            base: { ref: 'main' },
        },
        platformType: 'github',
        codeReviewConfig: {
            reviewOptions: { business_logic: true },
            byokModel: 'gpt-5.4',
            byokModelId: 'model-main',
        },
        changedFiles: [{ filename: 'a.ts', status: 'modified', patch: '+x' }],
        pipelineMetadata: {},
        errors: [],
        ...overrides,
    } as unknown as CodeReviewPipelineContext);

const verdict = (status: 'compliant' | 'issues_found', summary: string) =>
    ({
        kind: 'validated',
        task: TASK,
        verdict: { needsMoreInfo: false, status, findings: [], summary },
        report: summary,
    }) as BusinessValidationOutcome;

describe('BusinessLogicValidationStage', () => {
    it('sends the PR, its diff and the model override to the service', async () => {
        const { stage, service } = build(verdict('compliant', 'ok'));

        await stage.execute(context());

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
        const { stage, service } = build(verdict('compliant', 'ok'));

        const result = await stage.execute(context(overrides as any));

        expect(service.validate).not.toHaveBeenCalled();
        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason,
        });
        expect(result.businessLogicResults).toEqual([]);
    });

    it('revalidates on @kody review --force, with door "force" and no rerun tip', async () => {
        const { stage, service } = build(verdict('compliant', 'ok'));

        const result = await stage.execute(
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
        expect(result.businessLogicResults[0].suggestionContent).toBe('ok');
    });

    it('posts nothing when the service skipped (no task, tracker down, ...)', async () => {
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

    it('posts the message when the task is too thin to judge', async () => {
        const { stage } = build({
            kind: 'task_too_thin',
            task: TASK,
            message: 'PLAT-41 has only a title',
        });

        const result = await stage.execute(context());

        expect(result.businessLogicResults[0].suggestionContent).toContain(
            'PLAT-41 has only a title',
        );
        expect(result.businessLogicOutcome).toMatchObject({
            kind: 'skipped',
            reason: 'weak_task_context',
        });
        expect(result.businessLogicValidatedAt).toBeDefined();
    });

    // #2019: the verdict decides, whatever the report says and in any language.
    it.each([
        [
            'compliant',
            '**Status:** Em conformidade',
            'success',
            SeverityLevel.LOW,
        ],
        [
            'issues_found',
            'no issues with naming, but AC #2 is missing',
            'gap_found',
            SeverityLevel.MEDIUM,
        ],
    ] as const)(
        'maps a %s verdict to %s',
        async (status, report, kind, severity) => {
            const { stage } = build(verdict(status, report));

            const result = await stage.execute(context());

            expect(result.businessLogicOutcome).toMatchObject({ kind });
            expect(result.businessLogicResults[0]).toMatchObject({ severity });
            expect(result.businessLogicResults[0].suggestionContent).toContain(
                report,
            );
            expect(result.businessLogicResults[0].suggestionContent).toContain(
                '@kody -v business-logic',
            );
        },
    );

    it('records an error without aborting the pipeline when the service throws', async () => {
        const { stage } = build(new Error('boom'));

        const result = await stage.execute(context());

        expect(result.businessLogicOutcome).toMatchObject({ kind: 'error' });
        expect(result.errors).toHaveLength(1);
    });

    it('leaves no timeout pending once the service has answered', async () => {
        jest.useFakeTimers();
        try {
            const { stage } = build(verdict('compliant', 'ok'));
            await stage.execute(context());
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            jest.useRealTimers();
        }
    });
});

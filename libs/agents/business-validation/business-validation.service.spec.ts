import { BusinessValidationService } from './business-validation.service';
import { resolveBusinessLogicSettings } from './settings';

const reference = {
    kind: 'key' as const,
    id: 'KOD-999',
    raw: 'KOD-999',
    source: 'title' as const,
    intent: 'closes' as const,
};

/** What the service decides once the tracker answered "no such task". */
function decideNotFound(
    requireTask: boolean,
    intended?: { reference: typeof reference; tracker: string; nearby: string[] },
) {
    const service = new BusinessValidationService(
        {} as any,
        {} as any,
        { findByKey: async () => undefined } as any,
        {} as any,
    );
    const judge = async () => ({ translate: async (m: string) => m });
    return (service as any).decide(
        {
            door: 'auto',
            organizationAndTeamData: { organizationId: 'org-1' },
        },
        resolveBusinessLogicSettings({ requireTask }),
        {
            kind: 'not_found',
            looksIntended: !!intended,
            ...(intended ? { intended } : {}),
            attempts: [],
        },
        [intended?.reference ?? { ...reference, id: 'UTF-8', raw: 'UTF-8' }],
        ['Linear'],
        judge,
    );
}

describe('BusinessValidationService · a task the PR names that does not exist', () => {
    it('stays quiet about `UTF-8` in a title when no task is required', async () => {
        await expect(decideNotFound(false)).resolves.toMatchObject({
            kind: 'skipped',
            reason: 'task_not_found',
        });
    });

    it('asks for a task when `UTF-8` is all the PR names and the repository requires one', async () => {
        await expect(decideNotFound(true)).resolves.toMatchObject({
            kind: 'task_required',
        });
    });

    it('reports a typo without blocking when no task is required', async () => {
        const outcome = await decideNotFound(false, {
            reference,
            tracker: 'Linear',
            nearby: ['KOD-99'],
        });
        expect(outcome).toMatchObject({ kind: 'task_missing' });
        expect(outcome.required).toBeUndefined();
    });

    it('reports a typo that blocks when the repository requires a task', async () => {
        await expect(
            decideNotFound(true, {
                reference,
                tracker: 'Linear',
                nearby: [],
            }),
        ).resolves.toMatchObject({ kind: 'task_missing', required: true });
    });
});

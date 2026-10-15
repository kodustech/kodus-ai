import type { TaskReference } from './business-validation.types';
import { BusinessValidationService } from './business-validation.service';
import { resolveBusinessLogicSettings } from './settings';

function ref(raw: string): TaskReference {
    return raw.startsWith('#')
        ? {
              kind: 'git_issue',
              id: raw.slice(1),
              raw,
              source: 'body',
              intent: 'closes',
          }
        : { kind: 'key', id: raw, raw, source: 'title', intent: 'closes' };
}

/** What the service decides once the trackers answered, for a team that does or doesn't require a task. */
function decide(
    requireTask: boolean,
    resolution: Record<string, unknown>,
    references: TaskReference[],
) {
    const service = new BusinessValidationService(
        {} as any,
        {} as any,
        { findByKey: async () => undefined } as any,
        {} as any,
    );
    return (service as any).decide(
        { door: 'auto', organizationAndTeamData: { organizationId: 'org-1' } },
        resolveBusinessLogicSettings({ requireTask }),
        { attempts: [], ...resolution },
        references,
        ['Linear'],
        async () => ({ translate: async (m: string) => m }),
    );
}

describe('BusinessValidationService · a task the PR names that does not exist', () => {
    const utf8 = { kind: 'not_found', looksIntended: false };
    const typo = (nearby: string[]) => ({
        kind: 'not_found',
        looksIntended: true,
        intended: { reference: ref('KOD-999'), tracker: 'Linear', nearby },
    });

    it('stays quiet about `UTF-8` in a title when no task is required', async () => {
        await expect(
            decide(false, utf8, [ref('UTF-8')]),
        ).resolves.toMatchObject({
            kind: 'skipped',
            reason: 'task_not_found',
        });
    });

    it('asks for a task when `UTF-8` is all the PR names and the repository requires one', async () => {
        await expect(decide(true, utf8, [ref('UTF-8')])).resolves.toMatchObject(
            {
                kind: 'task_required',
            },
        );
    });

    it('reports a typo without blocking when no task is required', async () => {
        const outcome = await decide(false, typo(['KOD-99']), [ref('KOD-999')]);
        expect(outcome).toMatchObject({ kind: 'task_missing' });
        expect(outcome.required).toBeUndefined();
    });

    it('reports a typo that blocks when the repository requires a task', async () => {
        await expect(
            decide(true, typo([]), [ref('KOD-999')]),
        ).resolves.toMatchObject({ kind: 'task_missing', required: true });
    });
});

describe('BusinessValidationService · a reference no connected tracker reads', () => {
    const unreadable = {
        kind: 'no_capable_tracker',
        attempts: [
            { reference: '#1', tracker: 'Linear', status: 'unsupported' },
        ],
    };

    it('stays quiet about `Closes #1` with only Linear connected', async () => {
        await expect(
            decide(false, unreadable, [ref('#1')]),
        ).resolves.toMatchObject({
            kind: 'skipped',
            reason: 'no_capable_tracker',
        });
    });

    it('fails `Closes #1` with only Linear connected when the repository requires a task', async () => {
        const outcome = await decide(true, unreadable, [ref('#1')]);
        expect(outcome.kind).toBe('task_required');
        expect(outcome.message).toContain(
            "can't be read by the connected task tools (Linear)",
        );
    });

    it("never fails the author for a plugin the admin hasn't set up", async () => {
        await expect(
            decide(
                true,
                {
                    kind: 'no_capable_tracker',
                    attempts: [
                        {
                            reference: '#1',
                            tracker: 'Acme',
                            status: 'unsupported',
                            setup: true,
                        },
                    ],
                },
                [ref('#1')],
            ),
        ).resolves.toMatchObject({
            kind: 'skipped',
            reason: 'no_capable_tracker',
        });
    });
});

import { GitlabService } from './gitlab.service';

/**
 * Repository saves that overlap each run a webhook pass; each pass that sees
 * no Kodus hook adds one, so without convergence a project ends with one hook
 * per pass (prod had 3 to 7).
 */

const WEBHOOK_URL = 'https://api.kodus.io/gitlab/webhook';

function fakeGitlab() {
    const hooks = new Map<number, { id: number; url: string }[]>();
    const added: { projectId: number; id: number }[] = [];
    let nextId = 1;
    const tick = () => new Promise((r) => setTimeout(r, 5));

    const ProjectHooks = {
        all: jest.fn(async (projectId: number) => {
            const snapshot = [...(hooks.get(projectId) ?? [])];
            await tick();
            return snapshot;
        }),
        add: jest.fn(async (projectId: number, url: string) => {
            await tick();
            const hook = { id: nextId++, url };
            hooks.set(projectId, [...(hooks.get(projectId) ?? []), hook]);
            added.push({ projectId, id: hook.id });
            return hook;
        }),
        remove: jest.fn(async (projectId: number, hookId: number) => {
            await tick();
            const list = hooks.get(projectId) ?? [];
            if (!list.some((h) => h.id === hookId)) {
                throw Object.assign(new Error('404 Not Found'), {
                    cause: { response: { status: 404 } },
                });
            }
            hooks.set(
                projectId,
                list.filter((h) => h.id !== hookId),
            );
        }),
    };

    return { api: { ProjectHooks }, hooks, added };
}

describe('GitlabService.createMergeRequestWebhook — one Kodus hook per project', () => {
    const orgTeam = { organizationId: 'org-1', teamId: 'team-1' };
    let service: GitlabService;
    let gitlab: ReturnType<typeof fakeGitlab>;

    beforeEach(() => {
        process.env.API_GITLAB_CODE_MANAGEMENT_WEBHOOK = WEBHOOK_URL;
        service = new GitlabService(
            {} as any,
            {} as any,
            {} as any,
            { get: jest.fn() } as any,
            {} as any,
        );
        (service as any).logger = {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
        };
        gitlab = fakeGitlab();
        jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({});
        jest.spyOn(service as any, 'instanceGitlabApi').mockReturnValue(
            gitlab.api,
        );
        jest.spyOn(
            service as any,
            'findOneByOrganizationAndTeamDataAndConfigKey',
        ).mockResolvedValue([{ id: 77086088 }, { id: 83192371 }]);
    });

    const run = () =>
        service.createMergeRequestWebhook({ organizationAndTeamData: orgTeam });

    it('leaves only the oldest Kodus hook per project when 4 saves set webhooks up at once', async () => {
        await Promise.all([run(), run(), run(), run()]);

        for (const projectId of [77086088, 83192371]) {
            const ids = gitlab.added
                .filter((hook) => hook.projectId === projectId)
                .map((hook) => hook.id);
            // The race is real: every pass added its own hook first.
            expect(ids.length).toBeGreaterThan(1);
            expect(gitlab.hooks.get(projectId)).toEqual([
                { id: Math.min(...ids), url: WEBHOOK_URL },
            ]);
        }
    });

    it('clears duplicates an earlier save left behind', async () => {
        gitlab.hooks.set(77086088, [
            { id: 10, url: WEBHOOK_URL },
            { id: 11, url: WEBHOOK_URL },
            { id: 12, url: WEBHOOK_URL },
            { id: 5, url: 'https://sentry.io/extensions/gitlab/webhook/' },
        ]);
        gitlab.hooks.set(83192371, [{ id: 20, url: WEBHOOK_URL }]);

        await run();

        expect(gitlab.hooks.get(77086088)).toEqual([
            { id: 10, url: WEBHOOK_URL },
            { id: 5, url: 'https://sentry.io/extensions/gitlab/webhook/' },
        ]);
        expect(gitlab.api.ProjectHooks.add).not.toHaveBeenCalled();
    });

    it('keeps setting up the next repositories when a duplicate cannot be removed', async () => {
        gitlab.hooks.set(77086088, [
            { id: 10, url: WEBHOOK_URL },
            { id: 11, url: WEBHOOK_URL },
        ]);
        gitlab.api.ProjectHooks.remove.mockRejectedValueOnce(
            Object.assign(new Error('403 Forbidden'), {
                cause: { response: { status: 403 } },
            }),
        );

        await run();

        // The first project keeps its duplicate, the second still gets a hook.
        expect(gitlab.hooks.get(77086088)).toHaveLength(2);
        expect(gitlab.hooks.get(83192371)).toHaveLength(1);
    });

    it('adds nothing and removes nothing when the project already has one Kodus hook', async () => {
        gitlab.hooks.set(77086088, [{ id: 99, url: WEBHOOK_URL }]);
        gitlab.hooks.set(83192371, [{ id: 98, url: WEBHOOK_URL }]);

        await run();

        expect(gitlab.api.ProjectHooks.add).not.toHaveBeenCalled();
        expect(gitlab.api.ProjectHooks.remove).not.toHaveBeenCalled();
    });
});

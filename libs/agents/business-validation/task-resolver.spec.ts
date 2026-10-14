import type { TaskReference, TrackerLookup } from './business-validation.types';
import { extractTaskReferences } from './task-references';
import { repositoryForLookup, resolveTasks } from './task-resolver';
import type { TaskTracker } from './trackers/tracker';

const context = { organizationAndTeamData: { organizationId: 'org-1' } };

function tracker(
    name: string,
    tasks: Record<string, string>,
    options: {
        down?: boolean;
        teams?: string[];
        reads?: TaskReference['kind'][];
    } = {},
): TaskTracker & { reads: string[] } {
    const reads: string[] = [];
    return {
        name,
        reads,
        canRead: (r) => (options.reads ?? ['key']).includes(r.kind),
        read: async (r): Promise<TrackerLookup> => {
            reads.push(r.id);
            if (options.down) {
                return { status: 'error', message: '503' };
            }
            return tasks[r.id]
                ? {
                      status: 'found',
                      task: {
                          tracker: name,
                          id: r.id,
                          title: tasks[r.id],
                          description: tasks[r.id],
                      },
                  }
                : { status: 'not_found' };
        },
        ownsReference: async (r) =>
            (options.teams ?? []).includes(r.id.split('-')[0]),
        close: async () => undefined,
    };
}

const refs = (body: string, title?: string) =>
    extractTaskReferences({ title, body });

describe('resolveTasks', () => {
    it('returns every stated task a tracker confirms (UC-16)', async () => {
        const linear = tracker('Linear', { 'PLAT-1': 'a', 'PLAT-2': 'b' });
        const result = await resolveTasks(
            refs('Closes PLAT-1 and closes PLAT-2'),
            [linear],
            context,
        );
        expect(result.kind).toBe('found');
        expect(
            result.kind === 'found' && result.tasks.map((t) => t.task.id),
        ).toEqual(['PLAT-1', 'PLAT-2']);
    });

    it('skips a release that states more than three tasks, without asking the tracker (UC-17)', async () => {
        const linear = tracker('Linear', {});
        const result = await resolveTasks(
            refs('Closes A-1\nCloses A-2\nCloses A-3\nCloses A-4'),
            [linear],
            context,
        );
        expect(result.kind).toBe('too_many_references');
        expect(linear.reads).toEqual([]);
    });

    it('stays quiet on a version-looking key whose prefix no team owns (UC-14)', async () => {
        const result = await resolveTasks(
            refs('', 'fix: handle UTF-8 in the parser'),
            [tracker('Linear', {}, { teams: ['SAA'] })],
            context,
        );
        expect(result).toMatchObject({
            kind: 'not_found',
            looksIntended: false,
        });
    });

    it('flags a typo of a real team key and names real tasks one typo away (UC-21)', async () => {
        const linear = tracker('Linear', { 'SAA-99': 'x' }, { teams: ['SAA'] });
        const result = await resolveTasks(
            refs('', 'feat(SAA-999): bulk archive'),
            [linear],
            context,
        );
        expect(result).toMatchObject({
            kind: 'not_found',
            looksIntended: true,
            intended: { tracker: 'Linear', nearby: ['SAA-99'] },
        });
    });

    it('says the tracker is unavailable rather than that the task is missing (UC-22)', async () => {
        const result = await resolveTasks(
            refs('', 'feat(PLAT-1): x'),
            [tracker('Linear', {}, { down: true })],
            context,
        );
        expect(result.kind).toBe('tracker_unavailable');
    });

    it('treats a plugin with no read tool as unreadable, not as an outage to retry', async () => {
        const plugin: TaskTracker = {
            name: 'Acme',
            canRead: () => true,
            read: async () => ({
                status: 'error',
                message: 'Acme has no tool that reads one task by its id',
                setup: true,
            }),
            close: async () => undefined,
        };
        const result = await resolveTasks(
            refs('Closes AB#12'),
            [plugin],
            context,
        );
        expect(result.kind).toBe('no_capable_tracker');
        expect(result.attempts).toEqual([
            expect.objectContaining({ tracker: 'Acme', setup: true }),
        ]);
    });

    it('says no connected tracker reads a git issue when only Linear is connected (UC-11)', async () => {
        const result = await resolveTasks(
            refs('Closes #183'),
            [tracker('Linear', {})],
            context,
        );
        expect(result.kind).toBe('no_capable_tracker');
    });

    it('never reads a #N the description only mentions as the task', async () => {
        const issues = tracker(
            'Git Issues',
            { '45': 'another feature' },
            { reads: ['git_issue'] },
        );
        const result = await resolveTasks(
            refs('Similar to #45, see the screenshot.', 'feat: reorder'),
            [issues],
            context,
        );
        expect(result.kind).toBe('no_reference');
        expect(issues.reads).toEqual([]);
    });
});

describe('an issue number after a branch prefix', () => {
    const issues = (titles: Record<string, string>) =>
        tracker('Git Issues', titles, { reads: ['git_issue'] });

    it('counts the issue when its title shares a word with the branch', async () => {
        const result = await resolveTasks(
            extractTaskReferences({ branch: 'feature/12-add-login' }),
            [issues({ '12': 'Login page for guests' })],
            context,
        );
        expect(result.kind).toBe('found');
    });

    it('does not judge an unrelated issue a status code happens to number', async () => {
        const result = await resolveTasks(
            extractTaskReferences({ branch: 'fix/404-on-login' }),
            [issues({ '404': 'Dark mode toggle' })],
            context,
        );
        expect(result.kind).toBe('not_found');
    });

    it('matches accents and plurals, not three-letter words like "add"', async () => {
        const read = (branch: string, title: string) =>
            resolveTasks(
                extractTaskReferences({ branch }),
                [issues({ '7': title })],
                context,
            ).then((r) => r.kind);
        await expect(
            read('feat/7-relatorio-mensal', 'Relatórios mensais'),
        ).resolves.toBe('found');
        await expect(read('fix/7-add-cache', 'Add dark mode')).resolves.toBe(
            'not_found',
        );
    });
});

describe('repositoryForLookup', () => {
    it('splits a name given as owner/name, so #12 is read in the right repository', () => {
        expect(
            repositoryForLookup({
                name: 'acme/notes',
                owner: 'acme',
            }),
        ).toEqual({ owner: 'acme', name: 'notes' });
        expect(repositoryForLookup({ name: 'acme/notes' })).toEqual({
            owner: 'acme',
            name: 'notes',
        });
    });

    it('takes the owner from the full name, nested groups included', () => {
        expect(
            repositoryForLookup({
                name: 'notes',
                fullName: 'acme/platform/notes',
            }),
        ).toEqual({ owner: 'acme/platform', name: 'notes' });
    });

    it('reads the namespace from the path, not a display-name owner (GitLab)', () => {
        expect(
            repositoryForLookup({
                name: 'acme.dev/notes',
                owner: 'Acme Corp',
            }),
        ).toEqual({ owner: 'acme.dev', name: 'notes' });
    });
});

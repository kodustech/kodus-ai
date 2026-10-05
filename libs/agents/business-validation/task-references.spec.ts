import { extractTaskReferences } from './task-references';

const ids = (sources: Parameters<typeof extractTaskReferences>[0]) =>
    extractTaskReferences(sources).map((r) => `${r.kind}:${r.id}`);

describe('extractTaskReferences', () => {
    it('reads a key from the title, the branch and the body, in that order', () => {
        expect(
            ids({
                title: 'feat(PLAT-41): scale servings',
                branch: 'feat/plat-42-export',
                body: 'Refs PLAT-43',
            }),
        ).toEqual(['key:PLAT-41', 'key:PLAT-42', 'key:PLAT-43']);
    });

    it('puts what the command was given first', () => {
        expect(ids({ command: 'REC-7', title: 'feat(PLAT-41): x' })).toEqual([
            'key:REC-7',
            'key:PLAT-41',
        ]);
    });

    it('reads git issue references, local and in another repository', () => {
        const refs = extractTaskReferences({
            body: 'Closes #12, see acme/recipes-api#3 and https://github.com/acme/web/issues/9',
        });
        expect(refs.map((r) => `${r.kind}:${r.id}`)).toEqual([
            'git_issue:12',
            'git_issue:3',
            'git_issue:9',
        ]);
        expect(refs[0]).not.toHaveProperty('repository');
        expect(refs[1]).toMatchObject({
            repository: { owner: 'acme', name: 'recipes-api' },
        });
        expect(refs[2]).toMatchObject({
            repository: { owner: 'acme', name: 'web' },
        });
    });

    it('never takes a pull request URL for an issue', () => {
        expect(
            ids({ body: 'Follows https://github.com/acme/web/pull/70' }),
        ).toEqual([]);
    });

    it('reads tracker URLs with their host', () => {
        const refs = extractTaskReferences({
            body: [
                'https://linear.app/acme/issue/PLAT-41/recipes-scale-servings',
                'https://acme.atlassian.net/browse/REC-7',
                'https://acme.atlassian.net/jira/software/c/projects/KC/boards/2?selectedIssue=KC-14',
                'https://dev.azure.com/acme/web/_workitems/edit/27',
                'https://www.notion.so/acme/Scale-servings-1a2b3c4d5e6f708192a3b4c5d6e7f809',
            ].join('\n'),
        });
        expect(
            refs.map((r) => [r.kind, r.id, 'host' in r ? r.host : undefined]),
        ).toEqual([
            ['key', 'PLAT-41', 'linear'],
            ['key', 'REC-7', 'jira'],
            ['key', 'KC-14', 'jira'],
            ['work_item', '27', undefined],
            ['page', '1a2b3c4d5e6f708192a3b4c5d6e7f809', undefined],
        ]);
    });

    it('reads Azure Boards AB# references', () => {
        expect(ids({ title: 'feat(AB#27): scale servings' })).toEqual([
            'work_item:27',
        ]);
    });

    it('takes key-like tokens; the tracker decides whether they exist', () => {
        expect(ids({ title: 'fix: handle UTF-8 in the importer' })).toEqual([
            'key:UTF-8',
        ]);
    });

    it('does not read a key glued to other words or numbers', () => {
        expect(ids({ body: 'see foo-bar-1x, 1.2-3 and v2-rc' })).toEqual([]);
    });

    it('does not count a key twice', () => {
        expect(ids({ title: 'PLAT-41', body: 'PLAT-41 and plat-41' })).toEqual([
            'key:PLAT-41',
        ]);
    });

    it('returns nothing when nothing is referenced', () => {
        expect(ids({ title: 'chore: bump deps', body: '' })).toEqual([]);
    });
});

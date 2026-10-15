import {
    extractTaskReferences,
    referenceLabel,
    selectReferences,
} from './task-references';

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

    it('skips a URL with a malformed escape and still reads the rest', () => {
        expect(
            ids({
                body: 'See https://linear.app/acme/issue/%E0%A4%A and SAA-12',
            }),
        ).toEqual(['key:SAA-12']);
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

describe('issue number in the branch', () => {
    it('reads the branch GitHub creates from an issue as that issue', () => {
        expect(ids({ branch: '12-add-login' })).toEqual(['git_issue:12']);
    });

    it('reads `issue-12` and `gh-12` as issue #12, not as a key', () => {
        expect(ids({ branch: 'issue-12' })).toEqual(['git_issue:12']);
        expect(ids({ branch: 'nina/gh-12-add-login' })).toEqual([
            'git_issue:12',
        ]);
    });

    it('reads a number after a prefix only with the rest of the name, for the title to confirm', () => {
        const hinted = (branch: string) =>
            extractTaskReferences({ branch }).map((r) =>
                r.kind === 'git_issue' ? `${r.id}:${r.titleHint}` : r.id,
            );
        expect(hinted('feature/12-add-login')).toEqual(['12:add-login']);
        expect(hinted('users/ana/8_checkout')).toEqual(['8:checkout']);
        // A status code reads the same way; the issue's title tells them apart.
        expect(hinted('fix/404-on-login')).toEqual(['404:on-login']);
        expect(hinted('12-add-login')).toEqual(['12:undefined']);
    });

    it('drops the title check once the PR names the issue outright', () => {
        const [reference] = extractTaskReferences({
            branch: 'feature/12-add-login',
            body: 'Closes #12',
        });
        expect(reference).toMatchObject({ kind: 'git_issue', id: '12' });
        expect(
            reference.kind === 'git_issue' && reference.titleHint,
        ).toBeFalsy();
    });

    it('does not read dates or versions as an issue', () => {
        expect(ids({ branch: 'release/2026-10-01' })).toEqual([]);
        expect(ids({ branch: 'v2-cleanup' })).toEqual([]);
    });
});

describe("the team's own id pattern (#1884)", () => {
    it('reads the id the pattern captures, where the built-in shapes do not reach', () => {
        const pattern = { taskIdPattern: 'sc-(\\d+)' };
        expect(
            extractTaskReferences(
                { branch: 'nina/sc-123-gift-cards' },
                pattern,
            ).map((r) => `${r.kind}:${r.id}:${r.source}`),
        ).toEqual(['key:123:branch']);
    });

    it('reads the whole match when the pattern has no group', () => {
        expect(
            extractTaskReferences(
                { title: 'feat: T1234 gift cards' },
                { taskIdPattern: 'T\\d{3,}' },
            ).map((r) => r.id),
        ).toEqual(['T1234']);
    });

    it('reads its id from a link Kody does not know, as the settings preview does', () => {
        expect(
            extractTaskReferences(
                { body: 'https://app.shortcut.com/acme/story/123' },
                { taskIdPattern: 'story/(\\d+)' },
            ).map((r) => r.id),
        ).toEqual(['123']);
    });

    it('leaves a tracker link Kody knows to the built-in reader', () => {
        expect(
            extractTaskReferences(
                { body: 'https://acme.atlassian.net/browse/PLAT-7' },
                { taskIdPattern: 'PLAT-(\\d+)' },
            ).map((r) => `${r.id}:${'host' in r ? r.host : ''}`),
        ).toEqual(['PLAT-7:jira']);
    });

    it('still keeps the built-in shapes out of a link that is not a task', () => {
        expect(
            extractTaskReferences(
                { body: 'See https://github.com/acme/app/pull/70' },
                { taskIdPattern: 'story/(\\d+)' },
            ),
        ).toEqual([]);
    });
});

describe('task keys by case', () => {
    it('marks a lowercase key in prose as loose, and trusts it in the branch and the command', () => {
        const loose = (sources: Parameters<typeof extractTaskReferences>[0]) =>
            extractTaskReferences(sources).map(
                (r) => `${r.id}${'loose' in r && r.loose ? ' loose' : ''}`,
            );
        expect(
            loose({ title: 'feat: summarize threads with gpt-5 mini' }),
        ).toEqual(['GPT-5 loose']);
        expect(loose({ title: 'feat(kod-10): sticky notes' })).toEqual([
            'KOD-10 loose',
        ]);
        expect(loose({ body: 'Moves to node-22 and es-2022.' })).toEqual([
            'NODE-22 loose',
            'ES-2022 loose',
        ]);
        expect(loose({ branch: 'nina/saa-96-sticky-notes' })).toEqual([
            'SAA-96',
        ]);
        expect(loose({ command: 'saa-96' })).toEqual(['SAA-96']);
        expect(ids({ title: 'feat(SAA-96): sticky notes' })).toEqual([
            'key:SAA-96',
        ]);
    });
});

describe('reference intent (UC-18)', () => {
    const intents = (sources: Parameters<typeof extractTaskReferences>[0]) =>
        extractTaskReferences(sources).map((r) => `${r.id}:${r.intent}`);

    it('reads "Closes" as closing and "Part of" as a slice', () => {
        expect(
            intents({ body: 'Closes PLAT-1\nPart of PLAT-2\nRefs: PLAT-3' }),
        ).toEqual(['PLAT-1:closes', 'PLAT-2:part_of', 'PLAT-3:part_of']);
    });

    it("treats a task in the title or branch as the PR's own, and one only mentioned in the body as a mention", () => {
        expect(
            intents({
                title: 'feat(PLAT-1): x',
                body: 'Uses the same cache as PLAT-9.',
            }),
        ).toEqual(['PLAT-1:closes', 'PLAT-9:mentions']);
    });

    it('keeps "part of" when the body says so about the title\'s task', () => {
        expect(
            intents({
                title: 'feat(PLAT-1): x',
                body: 'This is part of PLAT-1.',
            }),
        ).toEqual(['PLAT-1:part_of']);
    });
});

describe('selectReferences (UC-17)', () => {
    const refs = (sources: Parameters<typeof extractTaskReferences>[0]) =>
        extractTaskReferences(sources);

    it('prefers stated references over ones the body only mentions', () => {
        const chosen = selectReferences(
            refs({
                title: 'feat(PLAT-1): x',
                body: 'Needs node-22, UTF-8 and SHA-256 support.',
            }),
            3,
        );
        expect(chosen?.map((r) => r.id)).toEqual(['PLAT-1']);
    });

    it('gives up on a release that states more tasks than one validation covers', () => {
        expect(
            selectReferences(
                refs({
                    body: 'Closes PLAT-1\nCloses PLAT-2\nCloses PLAT-3\nCloses PLAT-4',
                }),
                3,
            ),
        ).toBeUndefined();
    });

    it('never judges a #N the body only mentions: it is another issue or PR', () => {
        expect(
            selectReferences(
                refs({ body: 'Similar to #45. Step #1 done.' }),
                3,
            ),
        ).toEqual([]);
    });

    it('falls back to mentions when nothing is stated', () => {
        expect(
            selectReferences(refs({ body: 'Touches PLAT-7.' }), 3)?.map(
                (r) => r.id,
            ),
        ).toEqual(['PLAT-7']);
    });
});

describe('referenceLabel', () => {
    const label = (sources: Parameters<typeof extractTaskReferences>[0]) =>
        extractTaskReferences(sources).map(referenceLabel);

    it('names an issue a branch pointed at as #N, not the fragment it was cut from', () => {
        expect(label({ branch: 'bv/rq-gh1' })).toEqual(['#1']);
        expect(label({ branch: 'feature/12-add-login' })).toEqual(['#12']);
    });

    it('keeps the repository, the Azure prefix and the key', () => {
        expect(label({ body: 'Closes acme/web#7' })).toEqual(['acme/web#7']);
        expect(label({ title: 'feat(AB#8)' })).toEqual(['AB#8']);
        expect(label({ title: 'feat: SAA-96 reorder' })).toEqual(['SAA-96']);
    });
});

describe('Linear project ids', () => {
    it('never reads project P-KOD-1 as task KOD-1', () => {
        const labels = (sources: Parameters<typeof extractTaskReferences>[0]) =>
            extractTaskReferences(sources).map(referenceLabel);
        expect(labels({ body: 'Part of project P-KOD-1' })).toEqual([]);
        expect(labels({ title: 'feat(P-KOD-1): x' })).toEqual([]);
        expect(labels({ branch: 'feat/p-kod-1-x' })).toEqual([]);
        expect(labels({ body: 'Closes KOD-10, project P-KOD-1' })).toEqual([
            'KOD-10',
        ]);
        expect(labels({ branch: 'feat-kod-10' })).toEqual(['KOD-10']);
    });
});

describe('ClickUp references', () => {
    const refs = (sources: Parameters<typeof extractTaskReferences>[0]) =>
        extractTaskReferences(sources).map((r) => [
            r.id,
            'host' in r ? r.host : undefined,
        ]);

    it('reads a task link, with or without the workspace, and never a chat thread', () => {
        expect(
            refs({ body: 'Closes https://app.clickup.com/t/86bcjxxuu' }),
        ).toEqual([['86bcjxxuu', 'clickup']]);
        expect(
            refs({ body: 'https://app.clickup.com/t/90141770923/DEV-12' }),
        ).toEqual([['DEV-12', 'clickup']]);
        expect(
            refs({
                body: 'https://app.clickup.com/90141770923/v/cn/5-1/t/86b',
            }),
        ).toEqual([]);
    });

    it('reads the CU- prefix ClickUp puts in branches and titles', () => {
        expect(refs({ branch: 'feature/CU-86bcjxxuu-bulk-archive' })).toEqual([
            ['86bcjxxuu', 'clickup'],
        ]);
        expect(refs({ title: 'feat: bulk archive [CU-86BCJXXUU]' })).toEqual([
            ['86bcjxxuu', 'clickup'],
        ]);
    });
});

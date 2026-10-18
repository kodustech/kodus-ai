import {
    assertCustomAgentsRevisions,
    customAgentsRevisionsAtLevel,
    StaleCustomAgentsError,
} from './revision';

const agent = (id: string, instructions: string) => ({
    id,
    name: id,
    enabled: true,
    instructions,
});

const stored = () => ({
    configs: {
        customAgents: [agent('global-agent', 'Check the invoices.')],
        knowledge: [{ path: 'docs/global.md', kind: 'doc', linkedTo: [] }],
    },
    repositories: [
        {
            id: 'repo-1',
            configs: {
                customAgents: [agent('ledger-agent', 'Balance the ledger.')],
            },
            directories: [
                {
                    id: 'dir-1',
                    folders: [{ path: '/src/ledger' }],
                    configs: {
                        customAgents: [agent('dir-agent', 'Close the books.')],
                    },
                },
            ],
        },
        { id: 'repo-2', configs: {}, directories: [] },
    ],
});

describe('customAgentsRevisionsAtLevel', () => {
    it('is stable for the same stored lists, whatever the key order', () => {
        const reordered = stored();
        reordered.repositories[0].configs.customAgents = [
            {
                instructions: 'Balance the ledger.',
                enabled: true,
                name: 'ledger-agent',
                id: 'ledger-agent',
            },
        ];

        expect(
            customAgentsRevisionsAtLevel(reordered, { repositoryId: 'repo-1' }),
        ).toEqual(
            customAgentsRevisionsAtLevel(stored(), { repositoryId: 'repo-1' }),
        );
    });

    it('changes when an agent stored at the level changes', () => {
        const before = customAgentsRevisionsAtLevel(stored(), {
            repositoryId: 'repo-1',
        });
        const edited = stored();
        edited.repositories[0].configs.customAgents[0].instructions =
            'Balance the ledger twice.';
        const after = customAgentsRevisionsAtLevel(edited, {
            repositoryId: 'repo-1',
        });

        expect(after.customAgents).not.toBe(before.customAgents);
        expect(after.knowledge).toBe(before.knowledge);
    });

    it('follows the inherited list when the level stores none', () => {
        const before = customAgentsRevisionsAtLevel(stored(), {
            repositoryId: 'repo-2',
        });
        const edited = stored();
        edited.configs.customAgents[0].instructions = 'Check every invoice.';

        expect(
            customAgentsRevisionsAtLevel(edited, { repositoryId: 'repo-2' })
                .customAgents,
        ).not.toBe(before.customAgents);
        // The repository stores its own list: a global edit does not touch it.
        expect(
            customAgentsRevisionsAtLevel(edited, { repositoryId: 'repo-1' }),
        ).toEqual(
            customAgentsRevisionsAtLevel(stored(), { repositoryId: 'repo-1' }),
        );
    });

    it('resolves a directory group by id or by its folder paths', () => {
        expect(
            customAgentsRevisionsAtLevel(stored(), {
                repositoryId: 'repo-1',
                directoryPaths: ['/src/ledger'],
            }),
        ).toEqual(
            customAgentsRevisionsAtLevel(stored(), {
                repositoryId: 'repo-1',
                directoryId: 'dir-1',
            }),
        );
        expect(
            customAgentsRevisionsAtLevel(stored(), {
                repositoryId: 'repo-1',
                directoryId: 'dir-1',
            }).customAgents,
        ).not.toBe(
            customAgentsRevisionsAtLevel(stored(), { repositoryId: 'repo-1' })
                .customAgents,
        );
    });
});

describe('assertCustomAgentsRevisions', () => {
    const level = { repositoryId: 'repo-1' };

    it('accepts a save made from the stored lists', () => {
        const loaded = customAgentsRevisionsAtLevel(stored(), level);

        expect(() =>
            assertCustomAgentsRevisions(
                stored(),
                level,
                { customAgents: [], knowledge: [] },
                loaded,
            ),
        ).not.toThrow();
    });

    it('rejects a save made from a list someone else changed since', () => {
        const loaded = customAgentsRevisionsAtLevel(stored(), level);
        const changed = stored();
        changed.repositories[0].configs.customAgents.push(
            agent('audit-agent', 'Trace every adjustment.'),
        );

        expect(() =>
            assertCustomAgentsRevisions(
                changed,
                level,
                { customAgents: [] },
                loaded,
            ),
        ).toThrow(StaleCustomAgentsError);
    });

    it('checks only the lists the save writes', () => {
        const loaded = customAgentsRevisionsAtLevel(stored(), level);
        const changed = stored();
        changed.repositories[0].configs.customAgents.push(
            agent('audit-agent', 'Trace every adjustment.'),
        );

        // Only the knowledge is written: the agents edited elsewhere stay.
        expect(() =>
            assertCustomAgentsRevisions(
                changed,
                level,
                { knowledge: [] },
                loaded,
            ),
        ).not.toThrow();
    });

    it('skips the check when the caller sends no revision', () => {
        const changed = stored();
        changed.repositories[0].configs.customAgents = [];

        expect(() =>
            assertCustomAgentsRevisions(
                changed,
                level,
                { customAgents: [] },
                undefined,
            ),
        ).not.toThrow();
    });
});

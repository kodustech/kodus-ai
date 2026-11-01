/**
 * Skills and docs kept in another repository the team's integration reaches
 * (#2329): read through the provider API at the configured ref or that
 * repository's default branch, named `owner/repo:path`, and only from the
 * repositories the config links.
 * Fixture domain: an invented greenhouse-irrigation team and its rules repo.
 */
import { guideSourcesFor } from '@libs/code-review/infrastructure/agents/core/convention-check';

import {
    type KnowledgeCodeManagementPort,
    MultiRepositoryKnowledgeReader,
    resolveKnowledgeRepositories,
} from './base-branch-reader';
import { InMemoryBaseBranchReader, skillMarkdown } from './knowledge.fixtures';
import { renderKnowledgeSection } from './knowledge-prompt';
import { KnowledgeResolver } from './knowledge-resolver';
import { resolveReviewKnowledge } from './review-knowledge';

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
const RULES = 'greenhouse/irrigation-rules';

/** The provider: two repositories, each with its files per branch. */
function provider(
    filesByRepoAndRef: Record<string, Record<string, string>>,
    listing = [
        {
            id: '10',
            name: 'irrigation-service',
            full_name: 'greenhouse/irrigation-service',
            default_branch: 'main',
            visibility: 'public' as const,
            http_url: 'https://github.com/greenhouse/irrigation-service',
        },
        {
            id: '20',
            name: 'irrigation-rules',
            full_name: RULES,
            default_branch: 'trunk',
            visibility: 'private' as const,
            http_url: `https://github.com/${RULES}`,
        },
    ],
): KnowledgeCodeManagementPort & { calls: string[] } {
    const calls: string[] = [];
    const filesOf = (repoId: string, ref: string) =>
        filesByRepoAndRef[`${repoId}@${ref}`] ?? {};
    return {
        calls,
        getRepositories: jest.fn(async () => listing),
        getRepositoryContentFile: jest.fn(
            async ({ repository, file, pullRequest }) => {
                calls.push(
                    `${repository.id}@${pullRequest.base.ref}:${file.filename}`,
                );
                const content = filesOf(repository.id, pullRequest.base.ref)[
                    file.filename
                ];
                return content === undefined
                    ? null
                    : { data: { content, encoding: 'utf-8' } };
            },
        ),
        getRepositoryAllFiles: jest.fn(async ({ repository, filters }) =>
            Object.keys(filesOf(repository.id, filters!.branch!)).map(
                (path) => ({
                    path,
                }),
            ),
        ),
    };
}

describe('resolveKnowledgeRepositories', () => {
    it("reads at the item's ref, else the repository's default branch", async () => {
        const cm = provider({});
        const pinned = await resolveKnowledgeRepositories({
            items: [{ repository: RULES, ref: 'v3' }],
            codeManagement: cm,
            organizationAndTeamData: ORG,
        });
        const unpinned = await resolveKnowledgeRepositories({
            items: [{ repository: RULES }],
            codeManagement: cm,
            organizationAndTeamData: ORG,
        });

        expect(pinned.sources[0].source).toMatchObject({ id: '20', ref: 'v3' });
        expect(unpinned.sources[0].source).toMatchObject({
            id: '20',
            ref: 'trunk',
            visibility: 'private',
        });
    });

    it('reports a repository the integration does not reach as missing', async () => {
        const result = await resolveKnowledgeRepositories({
            items: [{ repository: 'someone-else/rules' }],
            codeManagement: provider({}),
            organizationAndTeamData: ORG,
        });

        expect(result.sources).toEqual([]);
        expect(result.missing).toEqual(['someone-else/rules']);
    });

    it('lists nothing when no item names another repository', async () => {
        const cm = provider({});
        const result = await resolveKnowledgeRepositories({
            items: [{}],
            codeManagement: cm,
            organizationAndTeamData: ORG,
        });

        expect(result.sources).toEqual([]);
        expect(cm.getRepositories).not.toHaveBeenCalled();
    });
});

describe('MultiRepositoryKnowledgeReader', () => {
    const local = new InMemoryBaseBranchReader({ 'docs/local.md': 'local' });
    const remote = new InMemoryBaseBranchReader({
        'stack/node/rules/valves.md': 'remote',
        'stack/node/skills/migrations/SKILL.md': 'skill',
        'stack/node/skills/migrations/references/locks.md': 'locks',
    });
    const reader = new MultiRepositoryKnowledgeReader(local, [
        {
            source: {
                fullName: RULES,
                id: '20',
                name: 'irrigation-rules',
                ref: 'trunk',
            },
            reader: remote,
        },
    ]);

    it('routes owner/repo:path to that repository and anything else to the reviewed one', async () => {
        await expect(
            reader.readFile(`${RULES}:stack/node/rules/valves.md`),
        ).resolves.toEqual({
            status: 'ok',
            content: 'remote',
        });
        await expect(reader.readFile('docs/local.md')).resolves.toEqual({
            status: 'ok',
            content: 'local',
        });
        expect(reader.refFor(`${RULES}:stack/node/rules/valves.md`)).toBe(
            'trunk',
        );
        expect(reader.refFor('docs/local.md')).toBe('main');
    });

    it('refuses a repository the config does not link', async () => {
        await expect(
            reader.readFile('greenhouse/secrets:stack/node/rules/valves.md'),
        ).resolves.toMatchObject({ status: 'refused' });
        await expect(
            reader.listFiles('greenhouse/secrets:stack'),
        ).resolves.toEqual([]);
    });

    it('lists a folder of the other repository with its qualified prefix', async () => {
        await expect(
            reader.listFiles(`${RULES}:stack/node/skills/migrations`),
        ).resolves.toEqual([
            `${RULES}:stack/node/skills/migrations/SKILL.md`,
            `${RULES}:stack/node/skills/migrations/references/locks.md`,
        ]);
    });
});

describe('KnowledgeResolver with another repository', () => {
    it('resolves a doc and a skill of the rules repository by qualified path, on its ref', async () => {
        const reader = new MultiRepositoryKnowledgeReader(
            new InMemoryBaseBranchReader({}),
            [
                {
                    source: {
                        fullName: RULES,
                        id: '20',
                        name: 'irrigation-rules',
                        ref: 'trunk',
                    },
                    reader: new InMemoryBaseBranchReader({
                        'stack/node/rules/valves.md':
                            '# Valves\n\nLog the zone id.',
                        'stack/node/skills/migrations/SKILL.md': skillMarkdown(
                            'migrations',
                            'How the team writes migrations.',
                        ),
                    }),
                },
            ],
        );

        const resolved = await new KnowledgeResolver(reader).resolve({
            items: [
                {
                    kind: 'doc',
                    repository: RULES,
                    path: 'stack/node/rules/valves.md',
                    linkedTo: ['main-review'],
                },
                {
                    kind: 'skill',
                    repository: RULES,
                    path: 'stack/node/skills/migrations',
                    linkedTo: ['main-review'],
                },
                {
                    kind: 'doc',
                    repository: RULES,
                    path: 'stack/node/rules/missing.md',
                    linkedTo: ['main-review'],
                },
            ],
            target: 'main-review',
        });

        expect(resolved.docs).toEqual([
            expect.objectContaining({
                path: `${RULES}:stack/node/rules/valves.md`,
                ref: 'trunk',
            }),
        ]);
        expect(resolved.skills).toEqual([
            expect.objectContaining({
                name: 'migrations',
                path: `${RULES}:stack/node/skills/migrations/SKILL.md`,
                folder: `${RULES}:stack/node/skills/migrations`,
                ref: 'trunk',
            }),
        ]);
        expect(resolved.warnings).toEqual([
            {
                code: 'DOC_NOT_FOUND',
                path: `${RULES}:stack/node/rules/missing.md`,
                detail: 'not found on trunk',
            },
        ]);
        expect(renderKnowledgeSection(resolved)).toContain(
            'A path written `owner/repo:path` is a file of that other repository',
        );
    });

    it('leaves the prompt of reviewed-repository knowledge as it was', async () => {
        const resolved = await new KnowledgeResolver(
            new InMemoryBaseBranchReader({ 'docs/valves.md': '# Valves' }),
        ).resolve({
            items: [
                {
                    kind: 'doc',
                    path: 'docs/valves.md',
                    linkedTo: ['main-review'],
                },
            ],
            target: 'main-review',
        });

        expect(resolved.docs[0]).not.toHaveProperty('ref');
        expect(renderKnowledgeSection(resolved)).not.toContain(
            'owner/repo:path',
        );
        expect(renderKnowledgeSection(resolved)).toContain(
            '<team-doc path="docs/valves.md">',
        );
    });
});

describe('resolveReviewKnowledge with another repository', () => {
    const base = {
        customAgents: [{ id: 'valves', name: 'Valves' } as any],
        changedFiles: [{ filename: 'src/valves/open.ts' }],
        baseBranch: 'main',
        sandbox: undefined,
        organizationAndTeamData: ORG,
        repository: { id: '10', name: 'irrigation-service' },
        logContext: 'spec',
    };

    it('reads the rules repository through the provider API at its default branch, never the PR', async () => {
        const cm = provider({
            '20@trunk': {
                'stack/node/rules/valves.md': '# Valves\n\nLog the zone id.',
            },
            '20@feature/pr-branch': {
                'stack/node/rules/valves.md': 'PR-edited rule',
            },
        });

        const knowledge = await resolveReviewKnowledge({
            ...base,
            items: [
                {
                    kind: 'doc',
                    repository: RULES,
                    path: 'stack/node/rules/valves.md',
                    linkedTo: [{ agentId: 'valves' }],
                },
            ],
            codeManagement: cm,
        });

        expect(knowledge.byTarget?.get('valves')?.docs).toEqual([
            expect.objectContaining({
                path: `${RULES}:stack/node/rules/valves.md`,
                content: '# Valves\n\nLog the zone id.',
                ref: 'trunk',
            }),
        ]);
        expect(cm.calls).toEqual(['20@trunk:stack/node/rules/valves.md']);
        expect(knowledge.sources).toEqual([
            expect.objectContaining({
                fullName: RULES,
                ref: 'trunk',
                visibility: 'private',
            }),
        ]);
        expect(knowledge.reviewedRepository).toMatchObject({
            visibility: 'public',
        });
    });

    it('warns, per agent, about a repository the integration cannot read', async () => {
        const knowledge = await resolveReviewKnowledge({
            ...base,
            items: [
                {
                    kind: 'doc',
                    repository: 'someone-else/rules',
                    path: 'rules.md',
                    linkedTo: [{ agentId: 'valves' }],
                },
            ],
            codeManagement: provider({}),
        });

        expect(knowledge.warnings).toEqual([
            expect.objectContaining({
                kind: 'DOC_NOT_FOUND',
                agentName: 'Valves',
                detail: "someone-else/rules:rules.md: someone-else/rules is not a repository this team's integration can read",
            }),
        ]);
    });

    it('does not list repositories when every item is in the reviewed repository', async () => {
        const cm = provider({ '10@main': { 'docs/valves.md': '# Valves' } });

        await resolveReviewKnowledge({
            ...base,
            items: [
                {
                    kind: 'doc',
                    path: 'docs/valves.md',
                    linkedTo: [{ agentId: 'valves' }],
                },
            ],
            codeManagement: cm,
        });

        expect(cm.getRepositories).not.toHaveBeenCalled();
    });
});

describe('guideSourcesFor (where the quote gate reads guides)', () => {
    const sandboxRead = jest.fn(async (file: string) => `sandbox:${file}`);
    const sandboxList = jest.fn(async (dir: string) => [`${dir}/a.md`]);
    const knowledgeReader = {
        readFile: jest.fn(async (path: string) => ({
            status: 'ok' as const,
            content: `api:${path}`,
        })),
        listFiles: jest.fn(async (dir: string) => [`${dir}/b.md`]),
    };

    it('is exactly the sandbox reader when no guide is in another repository', () => {
        const sources = guideSourcesFor(
            ['docs/valves.md'],
            knowledgeReader,
            sandboxRead,
            sandboxList,
        );

        expect(sources).toEqual({
            readGuide: sandboxRead,
            listGuideDir: sandboxList,
        });
        expect(
            guideSourcesFor(
                ['docs/valves.md'],
                knowledgeReader,
                undefined,
                undefined,
            ),
        ).toBeUndefined();
    });

    it('reads a guide of another repository through the knowledge reader, local ones through the sandbox', async () => {
        const sources = guideSourcesFor(
            ['docs/valves.md', `${RULES}:stack/node/rules/valves.md`],
            knowledgeReader,
            sandboxRead,
            sandboxList,
        )!;

        await expect(
            sources.readGuide(`${RULES}:stack/node/rules/valves.md`),
        ).resolves.toBe(`api:${RULES}:stack/node/rules/valves.md`);
        await expect(sources.readGuide('docs/valves.md')).resolves.toBe(
            'sandbox:docs/valves.md',
        );
        await expect(
            sources.listGuideDir!(`${RULES}:stack/node/skills/x`),
        ).resolves.toEqual([`${RULES}:stack/node/skills/x/b.md`]);
    });

    it('checks quotes without a sandbox once a guide is in another repository', async () => {
        const sources = guideSourcesFor(
            ['docs/valves.md', `${RULES}:stack/node/rules/valves.md`],
            knowledgeReader,
            undefined,
            undefined,
        )!;

        await expect(sources.readGuide('docs/valves.md')).resolves.toBe(
            'api:docs/valves.md',
        );
    });
});

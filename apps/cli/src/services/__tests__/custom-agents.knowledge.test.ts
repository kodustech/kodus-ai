import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/custom-agents.api.js', () => ({
    customAgentsApi: {
        getCodeReviewConfig: vi.fn(),
        save: vi.fn(),
        resolve: vi.fn(),
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: { resolve: vi.fn() },
}));

import { ApiError } from '../../types/errors.js';
import type {
    CustomAgent,
    FormattedCodeReviewParameter,
    KnowledgeItem,
} from '../../types/custom-agents.js';
import { customAgentsApi } from '../api/custom-agents.api.js';
import {
    customAgentsService,
    setKnowledgeLink,
    STALE_KNOWLEDGE_MESSAGE,
} from '../custom-agents.service.js';
import { userContextService } from '../user-context.service.js';

const api = vi.mocked(customAgentsApi);
const resolveUser = vi.mocked(userContextService.resolve);

const agent = (overrides: Partial<CustomAgent> = {}): CustomAgent => ({
    id: 'security',
    name: 'Security reviewer',
    enabled: true,
    instructions: 'Trace untrusted input.',
    scope: { include: ['src/**'] },
    tools: {},
    presentation: {
        tag: { color: '#ef4444' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
    ...overrides,
});

const owasp: KnowledgeItem = {
    path: '.agents/skills/owasp',
    kind: 'skill',
    linkedTo: [{ agentId: 'security' }],
};

function config(): FormattedCodeReviewParameter {
    return {
        configValue: {
            configs: {
                customAgents: { value: [agent()], level: 'global' },
                knowledge: { value: [owasp], level: 'global' },
            },
            customAgentsRevision: 'rev-global',
            knowledgeRevision: 'krev-global',
            repositories: [
                {
                    id: 'repo-1',
                    name: 'kodustech/kodus-ai',
                    configs: {
                        customAgents: { value: [agent()], level: 'global' },
                        knowledge: { value: [owasp], level: 'repository' },
                    },
                    customAgentsRevision: 'rev-repo',
                    knowledgeRevision: 'krev-repo',
                    directories: [
                        {
                            id: 'dir-1',
                            folders: [{ path: '/apps/web' }],
                            configs: {
                                customAgents: {
                                    value: [agent()],
                                    level: 'repository',
                                },
                                knowledge: {
                                    value: [owasp],
                                    level: 'repository',
                                },
                            },
                            knowledgeRevision: 'krev-dir',
                        },
                    ],
                },
            ],
        },
    };
}

// What the config reads back after a save that went through: every list's
// fingerprint changed. A save the plan left out reads back the same ones.
function saved<T>(value: T): T {
    return JSON.parse(
        JSON.stringify(value).replace(
            /"(customAgentsRevision|knowledgeRevision)":"([^"]*)"/g,
            '"$1":"$2-saved"',
        ),
    );
}

describe('customAgentsService skills & docs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveUser.mockResolvedValue({
            accessToken: 'eyJ.user.token',
            organizationId: 'org-1',
            teamId: 'team-1',
            teamName: 'Core',
        });
        // mockReset: a test that never read the config must not leave its
        // queued first answer to the next one.
        api.getCodeReviewConfig
            .mockReset()
            .mockResolvedValueOnce(config())
            .mockResolvedValue(saved(config()));
        api.save.mockResolvedValue({});
    });

    it('lists the items of a repository with who follows them and the branch report', async () => {
        api.resolve.mockResolvedValue({
            repository: { id: 'repo-1', name: 'kodus-ai', branch: 'main' },
            knowledge: {
                status: 'ok',
                items: [
                    {
                        path: owasp.path,
                        kind: 'skill',
                        found: true,
                        name: 'OWASP',
                        issues: [],
                        linkedTo: owasp.linkedTo,
                        kodyRuleSource: false,
                    },
                ],
                budgets: [],
            },
        });

        const result = await customAgentsService.listKnowledge({
            repo: 'kodus-ai',
        });

        expect(api.resolve).toHaveBeenCalledWith('eyJ.user.token', {
            teamId: 'team-1',
            repositoryId: 'repo-1',
            knowledge: [owasp],
        });
        expect(result.branch).toBe('main');
        expect(result.items).toEqual([
            expect.objectContaining({
                path: owasp.path,
                followedBy: ['Security reviewer'],
                report: expect.objectContaining({ name: 'OWASP' }),
            }),
        ]);
        expect(result.targets.map((target) => target.label)).toEqual([
            'Main review',
            'Security reviewer',
        ]);
    });

    it('does not read a branch at global', async () => {
        const result = await customAgentsService.listKnowledge({});

        expect(api.resolve).not.toHaveBeenCalled();
        expect(result.level).toBe('global');
        expect(result.unavailable).toContain('files of each repository');
    });

    it("shows a directory's inherited items apart from its own", async () => {
        const result = await customAgentsService.listKnowledge({
            repo: 'kodus-ai',
            directory: 'apps/web',
            check: false,
        });

        expect(result.level).toBe('directory');
        expect(result.items).toEqual([]);
        expect(result.inherited.map((item) => item.path)).toEqual([owasp.path]);
    });

    it('adds paths with their kinds and links, naming the knowledge revision', async () => {
        const result = await customAgentsService.addKnowledge(
            ['docs/payments.md', '.claude/skills/ledger/SKILL.md'],
            { repo: 'kodus-ai' },
            { link: ['main-review'] },
        );

        expect(api.save).toHaveBeenCalledWith('eyJ.user.token', {
            configValue: {
                knowledge: [
                    owasp,
                    {
                        path: 'docs/payments.md',
                        kind: 'doc',
                        linkedTo: ['main-review'],
                    },
                    {
                        path: '.claude/skills/ledger',
                        kind: 'skill',
                        linkedTo: ['main-review'],
                    },
                ],
            },
            organizationAndTeamData: { teamId: 'team-1' },
            repositoryId: 'repo-1',
            directoryId: undefined,
            expectedRevisions: { knowledge: 'krev-repo' },
        });
        expect(result.changed).toBe(true);
        expect(result.note).toBeUndefined();
    });

    it('registers an item with no links, as the page does, and says so', async () => {
        const result = await customAgentsService.addKnowledge(
            ['docs/style.md'],
            {},
        );

        const body = api.save.mock.calls[0][1];
        expect(body.repositoryId).toBeUndefined();
        expect(body.expectedRevisions).toEqual({ knowledge: 'krev-global' });
        expect(body.configValue.knowledge?.at(-1)).toEqual({
            path: 'docs/style.md',
            kind: 'doc',
            linkedTo: [],
        });
        expect(result.note).toContain('Nothing follows');
    });

    it('skips the save when the item is already there', async () => {
        const result = await customAgentsService.addKnowledge([owasp.path], {
            repo: 'kodus-ai',
        });

        expect(api.save).not.toHaveBeenCalled();
        expect(result.changed).toBe(false);
    });

    it('links an existing path under its stored kind, without a second entry', async () => {
        await customAgentsService.addKnowledge(
            [owasp.path],
            { repo: 'kodus-ai' },
            { kind: 'doc', link: ['main-review'] },
        );

        const saved = api.save.mock.calls[0][1].configValue.knowledge ?? [];
        const entries = saved.filter((entry) => entry.path === owasp.path);
        expect(entries).toHaveLength(1);
        expect(entries[0].kind).toBe('skill');
        expect(entries[0].linkedTo).toEqual(
            expect.arrayContaining([{ agentId: 'security' }]),
        );
        expect(entries[0].linkedTo).toHaveLength(2);
    });

    it('rejects a link target that is not an agent here', async () => {
        await expect(
            customAgentsService.addKnowledge(
                ['docs/a.md'],
                {},
                {
                    link: ['nobody'],
                },
            ),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(api.save).not.toHaveBeenCalled();
    });

    it('removes an item, and refuses one a directory inherits', async () => {
        await customAgentsService.removeKnowledge([owasp.path], {
            repo: 'kodus-ai',
        });
        expect(api.save.mock.calls[0][1].configValue.knowledge).toEqual([]);

        await expect(
            customAgentsService.removeKnowledge([owasp.path], {
                repo: 'kodus-ai',
                directory: 'apps/web',
            }),
        ).rejects.toMatchObject({
            code: 'INVALID_INPUT',
            message: expect.stringContaining('belongs to the repository'),
        });
    });

    it('unlinking keeps the item registered', async () => {
        await customAgentsService.linkKnowledge(
            owasp.path,
            ['security'],
            false,
            { repo: 'kodus-ai' },
        );

        expect(api.save.mock.calls[0][1].configValue.knowledge).toEqual([
            { ...owasp, linkedTo: [] },
        ]);
    });

    it('links the main review and an agent at once', async () => {
        await customAgentsService.linkKnowledge(
            owasp.path,
            ['main', 'Security reviewer'],
            true,
            { repo: 'kodus-ai' },
        );

        expect(
            api.save.mock.calls[0][1].configValue.knowledge?.[0].linkedTo,
        ).toEqual(['main-review', { agentId: 'security' }]);
    });

    it('turns a revision conflict into a re-run message and never retries', async () => {
        api.save.mockRejectedValue(new ApiError(409, 'Conflict'));

        await expect(
            customAgentsService.addKnowledge(['docs/a.md'], {
                repo: 'kodus-ai',
            }),
        ).rejects.toMatchObject({ message: STALE_KNOWLEDGE_MESSAGE });
        expect(api.save).toHaveBeenCalledTimes(1);
    });

    it('discovers only what is not added yet, and refuses global', async () => {
        api.resolve.mockResolvedValue({
            repository: { id: 'repo-1', name: 'kodus-ai', branch: 'main' },
            knowledge: {
                status: 'ok',
                items: [],
                budgets: [],
                candidates: [
                    {
                        path: owasp.path,
                        kind: 'skill',
                        kodyRuleSource: false,
                    },
                    {
                        path: 'docs/payments.md',
                        kind: 'doc',
                        kodyRuleSource: true,
                    },
                ],
            },
        });

        const result = await customAgentsService.discoverKnowledge({
            repo: 'kodus-ai',
        });

        expect(api.resolve).toHaveBeenCalledWith(
            'eyJ.user.token',
            expect.objectContaining({ discover: true }),
        );
        expect(result.candidates.map((candidate) => candidate.path)).toEqual([
            'docs/payments.md',
        ]);

        await expect(
            customAgentsService.discoverKnowledge({}),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
});

describe('setKnowledgeLink', () => {
    it('adds a missing item and toggles one target', () => {
        const added = setKnowledgeLink(
            [],
            { path: 'docs/a.md', kind: 'doc' },
            'main-review',
            true,
        );
        expect(added).toEqual([
            { path: 'docs/a.md', kind: 'doc', linkedTo: ['main-review'] },
        ]);
        expect(setKnowledgeLink(added, added[0], 'main-review', false)).toEqual(
            [{ path: 'docs/a.md', kind: 'doc', linkedTo: [] }],
        );
    });
});

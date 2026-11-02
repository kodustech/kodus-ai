import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/custom-agents.api.js', () => ({
    customAgentsApi: {
        getCodeReviewConfig: vi.fn(),
        save: vi.fn(),
        getStatus: vi.fn(),
        startTry: vi.fn(),
        readTry: vi.fn(),
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: { resolve: vi.fn() },
}));

import { ApiError } from '../../types/errors.js';
import type {
    CustomAgent,
    FormattedCodeReviewParameter,
} from '../../types/custom-agents.js';
import { CommandError } from '../../utils/command-errors.js';
import { customAgentsApi } from '../api/custom-agents.api.js';
import {
    customAgentsService,
    resolveLevel,
    STALE_AGENTS_MESSAGE,
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

function config(): FormattedCodeReviewParameter {
    return {
        configValue: {
            configs: {
                customAgents: { value: [agent()], level: 'global' },
                knowledge: {
                    value: [
                        {
                            path: '.agents/skills/owasp',
                            kind: 'skill',
                            linkedTo: [{ agentId: 'security' }],
                        },
                    ],
                    level: 'global',
                },
            },
            customAgentsRevision: 'rev-global',
            knowledgeRevision: 'krev-global',
            repositories: [
                {
                    id: 'repo-1',
                    name: 'kodus-ai',
                    configs: {
                        customAgents: { value: [agent()], level: 'global' },
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
                            },
                            customAgentsRevision: 'rev-dir',
                        },
                    ],
                },
            ],
        },
    };
}

describe('customAgentsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveUser.mockResolvedValue({
            accessToken: 'eyJ.user.token',
            organizationId: 'org-1',
            teamId: 'team-1',
            teamName: 'Core',
        });
        api.getCodeReviewConfig.mockResolvedValue(config());
        api.save.mockResolvedValue({});
    });

    it('rejects a team key with the login hint', async () => {
        resolveUser.mockRejectedValue(
            new CommandError(
                'AUTH_REQUIRED',
                'Custom agents requires a logged-in user. Run: kodus auth login (team keys do not cover this command yet).',
            ),
        );

        await expect(customAgentsService.list({})).rejects.toMatchObject({
            code: 'AUTH_REQUIRED',
        });
        expect(api.getCodeReviewConfig).not.toHaveBeenCalled();
    });

    it('creates a turned-off agent at the repository with the list revision', async () => {
        const result = await customAgentsService.create(
            {
                name: 'Data contracts',
                instructions: 'Check schema changes.',
                include: ['migrations/**'],
            },
            { repo: 'kodus-ai' },
        );

        expect(api.save).toHaveBeenCalledWith('eyJ.user.token', {
            configValue: {
                customAgents: [
                    agent(),
                    {
                        id: 'data-contracts',
                        name: 'Data contracts',
                        enabled: false,
                        instructions: 'Check schema changes.',
                        scope: { include: ['migrations/**'] },
                        tools: {},
                        presentation: {
                            tag: { color: '#a855f7' },
                            format: 'inline',
                            suggestedFix: 'when-confident',
                        },
                    },
                ],
            },
            organizationAndTeamData: { teamId: 'team-1' },
            repositoryId: 'repo-1',
            directoryId: undefined,
            expectedRevisions: { customAgents: 'rev-repo' },
        });
        // The repository read the global list: saving gives it its own.
        expect(result.note).toContain('now has its own agents list');
    });

    it('refuses a name whose @kody -v command another agent uses', async () => {
        await expect(
            customAgentsService.create({ name: 'security  reviewer' }, {}),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(api.save).not.toHaveBeenCalled();
    });

    it('updates only the fields passed and links a skill', async () => {
        await customAgentsService.update(
            'Security reviewer',
            {
                minSeverity: 'high',
                linkDocs: ['docs/threat-model.md'],
            },
            {},
        );

        const body = api.save.mock.calls[0][1];
        expect(body.repositoryId).toBeUndefined();
        expect(body.configValue.customAgents?.[0]).toMatchObject({
            id: 'security',
            instructions: 'Trace untrusted input.',
            presentation: { minSeverity: 'high' },
        });
        expect(body.configValue.knowledge).toEqual([
            {
                path: '.agents/skills/owasp',
                kind: 'skill',
                linkedTo: [{ agentId: 'security' }],
            },
            {
                path: 'docs/threat-model.md',
                kind: 'doc',
                linkedTo: [{ agentId: 'security' }],
            },
        ]);
        expect(body.expectedRevisions).toEqual({
            customAgents: 'rev-global',
            knowledge: 'krev-global',
        });
    });

    it('turns an agent off', async () => {
        await customAgentsService.setEnabled('security', false, {});

        const body = api.save.mock.calls[0][1];
        expect(body.configValue.customAgents?.[0].enabled).toBe(false);
        expect(body.configValue.knowledge).toBeUndefined();
    });

    it('deletes an agent with its knowledge links', async () => {
        const result = await customAgentsService.delete('security', {});

        const body = api.save.mock.calls[0][1];
        expect(body.configValue.customAgents).toEqual([]);
        expect(body.configValue.knowledge).toEqual([
            { path: '.agents/skills/owasp', kind: 'skill', linkedTo: [] },
        ]);
        expect(result.deletedAgentId).toBe('security');
    });

    it("won't change the repository's agent from a directory", async () => {
        await expect(
            customAgentsService.update(
                'security',
                { enabled: false },
                { repo: 'repo-1', directory: 'apps/web' },
            ),
        ).rejects.toMatchObject({
            code: 'INVALID_INPUT',
            message: expect.stringContaining('belongs to the repository'),
        });
    });

    it('fails without writing when someone else saved the agents first', async () => {
        api.save.mockRejectedValue(new ApiError(409, 'stale'));

        await expect(
            customAgentsService.setEnabled('security', false, {}),
        ).rejects.toMatchObject({ message: STALE_AGENTS_MESSAGE });
        expect(api.save).toHaveBeenCalledTimes(1);
    });

    it('returns the centralized pull request a save opened', async () => {
        api.save.mockResolvedValue({
            mode: 'centralized-pr',
            prUrl: 'https://github.com/acme/config/pull/7',
        });

        const result = await customAgentsService.setEnabled(
            'security',
            true,
            {},
        );

        expect(result.centralized?.prUrl).toBe(
            'https://github.com/acme/config/pull/7',
        );
    });

    it('lists agents with their repository status', async () => {
        api.getStatus.mockResolvedValue({
            windowDays: 30,
            agents: [
                { agentId: 'security', pullRequests: 3, posted: 5, dropped: 1 },
            ],
        });

        const result = await customAgentsService.list({ repo: 'kodus-ai' });

        expect(api.getStatus).toHaveBeenCalledWith('eyJ.user.token', {
            teamId: 'team-1',
            repositoryId: 'repo-1',
        });
        expect(result.agents[0]).toMatchObject({
            id: 'security',
            status: { posted: 5 },
        });
    });

    it('polls a try run until it is done', async () => {
        const trace = {
            status: 'completed' as const,
            skillsOpened: [],
            toolCalls: [],
            findings: [],
        };
        api.startTry.mockResolvedValue({ runId: 'run-1', status: 'running' });
        api.readTry
            .mockResolvedValueOnce({ runId: 'run-1', status: 'running' })
            .mockResolvedValueOnce({
                runId: 'run-1',
                status: 'done',
                result: trace,
            });
        const wait = vi.fn().mockResolvedValue(undefined);

        const result = await customAgentsService.tryAgent(
            'security',
            'https://github.com/acme/app/pull/1',
            { repo: 'kodus-ai' },
            { wait },
        );

        expect(api.startTry).toHaveBeenCalledWith(
            'eyJ.user.token',
            expect.objectContaining({
                teamId: 'team-1',
                repositoryId: 'repo-1',
                prUrl: 'https://github.com/acme/app/pull/1',
                agent: expect.objectContaining({ id: 'security' }),
            }),
        );
        expect(api.readTry).toHaveBeenCalledTimes(2);
        expect(api.readTry).toHaveBeenCalledWith('eyJ.user.token', 'run-1', {
            teamId: 'team-1',
            repositoryId: 'repo-1',
        });
        expect(wait).toHaveBeenCalledTimes(2);
        expect(result.trace).toBe(trace);
    });

    it('needs a repository to try an agent', async () => {
        await expect(
            customAgentsService.tryAgent('security', 'https://x/pull/1', {}),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(api.startTry).not.toHaveBeenCalled();
    });
});

describe('resolveLevel', () => {
    it('at a directory, owns nothing until it saves its own list', () => {
        const view = resolveLevel(config(), {
            repo: 'kodus-ai',
            directory: './apps/web/',
        });

        expect(view.level).toBe('directory');
        expect(view.directoryId).toBe('dir-1');
        expect(view.agents).toEqual([]);
        expect(view.inheritedAgents.map((a) => a.id)).toEqual(['security']);
        expect(view.effectiveAgents.map((a) => a.id)).toEqual(['security']);
        expect(view.revisions.customAgents).toBe('rev-dir');
    });

    it('names the configured repositories when one is unknown', () => {
        expect(() => resolveLevel(config(), { repo: 'nope' })).toThrow(
            /Configured: kodus-ai/,
        );
    });
});

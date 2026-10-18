import { BadRequestException } from '@nestjs/common';

import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

import {
    buildTryTrace,
    CustomAgentKnowledgeReaderService,
    CustomAgentToolCatalogService,
    CustomAgentTryRunnerService,
    pullRequestNumberFromUrl,
} from './custom-agent-seams.service';

const org = { organizationId: 'org-1', teamId: 'team-1' };

const agent = (over: Partial<CustomAgentConfig> = {}): CustomAgentConfig => ({
    id: 'ledger-agent',
    name: 'Ledger reviewer',
    enabled: true,
    instructions: 'Every posting must balance debits and credits.',
    scope: { include: ['src/ledger/**'] },
    tools: {},
    presentation: {
        tag: { color: '#304FFE' },
        format: 'inline',
        suggestedFix: 'when-confident',
    },
    ...over,
});

const SKILL = [
    '---',
    'name: ledger-posting',
    'description: How the team posts journal entries.',
    '---',
    'Post through the journal service.',
].join('\n');

/** Provider API over a tiny invented repository on branch `main`. */
const codeManagement = (files: Record<string, string> = {}) => ({
    getRepositoryContentFile: jest.fn(async ({ file }: any) =>
        file.filename in files
            ? { data: { content: files[file.filename] } }
            : null,
    ),
    getRepositoryAllFiles: jest.fn(async ({ filters }: any) =>
        Object.keys(files)
            .filter((path) =>
                (filters?.filePatterns ?? []).some((p: string) =>
                    p.includes('**')
                        ? path.startsWith(p.split('**')[0])
                        : path === p,
                ),
            )
            .map((path) => ({ path })),
    ),
    getPullRequestByNumber: jest.fn(async () => ({
        title: 'Book refunds',
        base: { ref: 'main' },
    })),
    getFilesByPullRequestId: jest.fn(async () => [
        {
            filename: 'src/ledger/refund.ts',
            patch: '@@ -1,1 +1,2 @@\n line\n+ledger.insert(refund);',
        },
        { filename: 'src/billing/invoice.ts', patch: '@@ -1 +1 @@\n-a\n+b' },
    ]),
    getDefaultBranch: jest.fn(async () => 'main'),
});

describe('pullRequestNumberFromUrl', () => {
    it.each([
        ['https://git.example.test/acme/ledger/pull/42', 42],
        ['https://git.example.test/acme/ledger/-/merge_requests/7/diffs', 7],
        ['https://git.example.test/acme/_git/ledger/pullrequest/9', 9],
        ['https://git.example.test/acme/ledger/pull-requests/3/overview', 3],
        ['https://git.example.test/acme/ledger/pulls/5', 5],
        ['https://git.example.test/acme/ledger/issues/5', undefined],
    ])('%s → %s', (url, expected) => {
        expect(pullRequestNumberFromUrl(url)).toBe(expected);
    });
});

describe('CustomAgentTryRunnerService', () => {
    const parameters = {
        findByKey: jest.fn(async () => ({
            configValue: {
                configs: {},
                repositories: [{ id: 'repo-1', name: 'acme/ledger' }],
            },
        })),
    };

    const setup = (files: Record<string, string> = {}) => {
        const execute = jest.fn(async (input: any) => {
            input.onAgentProgress?.({
                agentName: 'x',
                status: 'completed',
                toolCalls: [
                    { tool: 'loadSkill', args: '{"name":"ledger-posting"}' },
                ],
            });
            return {
                suggestions: [
                    {
                        relevantFile: 'src/ledger/refund.ts',
                        oneSentenceSummary: 'One-sided refund',
                        severity: 'high',
                    },
                ],
                discardedByVerify: [
                    {
                        relevantFile: 'src/ledger/refund.ts',
                        oneSentenceSummary: 'Refuted',
                        severity: 'low',
                    },
                ],
                agentName: 'x',
                turnsUsed: 1,
                durationMs: 1,
            };
        });
        const factory = { create: jest.fn(() => ({ execute })) };
        const cm = codeManagement(files);
        const runner = new CustomAgentTryRunnerService(
            parameters as any,
            cm as any,
            factory as any,
        );
        return { runner, execute, factory, cm };
    };

    it('refuses a pull request URL of another repository', async () => {
        const { runner, execute } = setup();

        await expect(
            runner.runCustomAgentOnPullRequest({
                organizationAndTeamData: org,
                repositoryId: 'repo-1',
                prUrl: 'https://git.example.test/acme/billing/pull/42',
                agent: agent(),
                knowledge: [],
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(execute).not.toHaveBeenCalled();
    });

    it('skips without running when no changed file is in scope', async () => {
        const { runner, execute } = setup();

        const trace = await runner.runCustomAgentOnPullRequest({
            organizationAndTeamData: org,
            repositoryId: 'repo-1',
            prUrl: 'https://git.example.test/acme/ledger/pull/42',
            agent: agent({ scope: { include: ['src/payroll/**'] } }),
            knowledge: [],
        });

        expect(trace.status).toBe('skipped');
        expect(execute).not.toHaveBeenCalled();
    });

    it('runs the agent on its files with its knowledge and reports what it did', async () => {
        const { runner, execute } = setup({
            '.skills/ledger-posting/SKILL.md': SKILL,
        });

        const trace = await runner.runCustomAgentOnPullRequest({
            organizationAndTeamData: org,
            repositoryId: 'repo-1',
            prUrl: 'https://git.example.test/acme/ledger/pull/42',
            agent: agent(),
            knowledge: [
                {
                    path: '.skills/ledger-posting',
                    kind: 'skill',
                    linkedTo: [{ agentId: 'ledger-agent' }],
                },
            ],
        });

        const input = execute.mock.calls[0][0];
        expect(input.changedFiles.map((f: any) => f.filename)).toEqual([
            'src/ledger/refund.ts',
        ]);
        expect(input.changedFiles[0].patchWithLinesStr).toContain('refund');
        expect(input.prNumber).toBe(42);
        expect(input.baseBranch).toBe('main');
        expect(input.knowledge.skills.map((s: any) => s.name)).toEqual([
            'ledger-posting',
        ]);
        expect(trace.status).toBe('completed');
        expect(trace.skillsOpened).toEqual([
            { path: '.skills/ledger-posting/SKILL.md' },
        ]);
        expect(trace.findings).toEqual([
            expect.objectContaining({ verdict: 'kept', wouldPost: true }),
            expect.objectContaining({ verdict: 'dropped', wouldPost: false }),
        ]);
    });
});

describe('buildTryTrace', () => {
    it('marks as posting only what clears the severity floor and the comment limit', () => {
        const trace = buildTryTrace({
            agent: agent({
                presentation: {
                    ...agent().presentation,
                    minSeverity: 'medium' as any,
                    maxComments: 1,
                },
            }),
            output: {
                suggestions: [
                    { oneSentenceSummary: 'a', severity: 'medium' },
                    { oneSentenceSummary: 'b', severity: 'critical' },
                    { oneSentenceSummary: 'c', severity: 'low' },
                ],
                agentName: 'x',
                turnsUsed: 1,
                durationMs: 1,
            } as any,
            events: [],
            startedAt: Date.now(),
        });

        expect(trace.findings.map((f) => [f.summary, f.wouldPost])).toEqual([
            ['a', false],
            ['b', true],
            ['c', false],
        ]);
    });
});

describe('CustomAgentKnowledgeReaderService', () => {
    const repository = { id: 'repo-1', name: 'acme/ledger', branch: 'main' };

    it('validates skills and measures docs on the branch', async () => {
        const cm = codeManagement({
            '.skills/ledger-posting/SKILL.md': SKILL,
            '.skills/broken/SKILL.md': 'no frontmatter',
            'docs/ledger.md': 'Debits equal credits.',
        });
        const reader = new CustomAgentKnowledgeReaderService(
            cm as any,
            { detect: jest.fn() } as any,
        );

        const [ok, broken, missing, doc] = await reader.resolve({
            organizationAndTeamData: org,
            repository,
            items: [
                { path: '.skills/ledger-posting', kind: 'skill' },
                { path: '.skills/broken', kind: 'skill' },
                { path: '.skills/absent', kind: 'skill' },
                { path: 'docs/ledger.md', kind: 'doc' },
            ],
        });

        expect(ok).toEqual(
            expect.objectContaining({
                found: true,
                name: 'ledger-posting',
                issues: [],
            }),
        );
        expect(broken.found).toBe(true);
        expect(broken.issues[0].severity).toBe('error');
        expect(missing.found).toBe(false);
        expect(doc).toEqual(
            expect.objectContaining({ found: true, kind: 'doc' }),
        );
        expect(doc.tokens).toBeGreaterThan(0);
    });

    it('offers detected skills and the docs the repository keeps', async () => {
        const cm = codeManagement({
            'docs/ledger.md': 'x',
            'CONTRIBUTING.md': 'y',
            'src/app.ts': 'z',
        });
        const detect = jest.fn(async () => [
            {
                path: '.claude/skills/ledger-posting',
                file: '.claude/skills/ledger-posting/SKILL.md',
                source: '.claude/skills',
                valid: true,
                name: 'ledger-posting',
                description: 'How to post.',
            },
        ]);
        const reader = new CustomAgentKnowledgeReaderService(
            cm as any,
            { detect } as any,
        );

        const candidates = await reader.discover({
            organizationAndTeamData: org,
            repository,
        });

        expect(candidates).toEqual([
            expect.objectContaining({
                path: '.claude/skills/ledger-posting',
                kind: 'skill',
            }),
            { path: 'CONTRIBUTING.md', kind: 'doc' },
            { path: 'docs/ledger.md', kind: 'doc' },
        ]);
    });

    it('carries why a detected skill is not valid', async () => {
        const detect = jest.fn(async () => [
            {
                path: '.claude/skills/notes',
                file: '.claude/skills/notes/SKILL.md',
                source: '.claude/skills',
                valid: false,
                errors: [
                    'SKILL.md must start with a YAML frontmatter block (---)',
                ],
            },
        ]);
        const reader = new CustomAgentKnowledgeReaderService(
            codeManagement({}) as any,
            { detect } as any,
        );

        const [skill] = await reader.discover({
            organizationAndTeamData: org,
            repository,
        });

        expect(skill.errors).toEqual([
            'SKILL.md must start with a YAML frontmatter block (---)',
        ]);
    });
});

describe('CustomAgentToolCatalogService', () => {
    it('returns nothing when plugins are not available on this server', async () => {
        expect(
            await new CustomAgentToolCatalogService().listReadOnlyMcpTools({
                organizationAndTeamData: org,
            }),
        ).toEqual([]);
    });

    it('lists no connection of another organization', async () => {
        const getConnections = jest.fn(async (_org: any, format?: boolean) =>
            format
                ? [
                      {
                          name: 'Tracker',
                          url: 'https://mcp.example.test',
                          integrationId: 'int-9',
                      },
                  ]
                : [
                      {
                          organizationId: 'org-2',
                          integrationId: 'int-9',
                          appName: 'Tracker',
                      },
                  ],
        );
        const catalog = new CustomAgentToolCatalogService({
            getConnections,
        } as any);

        expect(
            await catalog.listReadOnlyMcpTools({
                organizationAndTeamData: org,
            }),
        ).toEqual([]);
    });
});

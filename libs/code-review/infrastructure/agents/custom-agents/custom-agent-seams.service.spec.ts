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

    const CLI_WARNING = {
        kind: 'CLI_INSTALL_FAILED',
        reason: 'cli_install_failed',
        contextWindowTokens: 0,
        modelName: '',
        detail: 'Ledger reviewer: CLI "dupfinder" unavailable (install failed); the agent ran without it',
    };

    const output = {
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
        agentName: 'custom-agent:ledger-reviewer',
        turnsUsed: 1,
        durationMs: 1,
    };

    /**
     * The review's own pieces, faked at their edges: the sandbox stage hands
     * back a checkout (or none), the orchestrator runs the agent.
     */
    const setup = (opts: { checkout?: boolean; orchestrate?: any } = {}) => {
        const checkout = opts.checkout ?? true;
        const sandbox = {
            type: 'e2b',
            sandboxId: 'sbx-1',
            repoDir: '/repo',
            baseBranch: 'main',
            remoteCommands: { grep: jest.fn() },
            // Every path reads as absent on the target branch.
            run: jest.fn(async (_command: string) => ({
                stdout: '',
                stderr: '',
                exitCode: 0,
            })),
            readFile: jest.fn(),
            writeFile: jest.fn(),
            cleanup: jest.fn(async () => {}),
        };
        const installed = [{ agentId: 'ledger-agent', name: 'dupfinder' }];
        const createSandboxStage = {
            execute: jest.fn(async (context: any) =>
                checkout
                    ? {
                          ...context,
                          sandboxHandle: sandbox,
                          customAgentClis: {
                              byAgentId: { 'ledger-agent': installed },
                              warnings: [CLI_WARNING],
                          },
                      }
                    : context,
            ),
        };
        const orchestrator = {
            execute: jest.fn(
                opts.orchestrate ??
                    (async (input: any) => {
                        input.onAgentProgress?.({
                            agentName: 'x',
                            status: 'completed',
                            toolCalls: [{ tool: 'runCli', args: '{}' }],
                        });
                        return {
                            suggestions: output.suggestions,
                            agentResults: [output],
                            failures: [],
                            incomplete: [],
                            customAgentRuns: [],
                            totalDurationMs: 1,
                            warnings: [],
                        };
                    }),
            ),
        };
        const codeBaseConfig = {
            getConfig: jest.fn(async () => ({
                languageResultPrompt: 'pt-BR',
                reviewMode: 'normal',
                byokModelId: 'repo-model',
                customAgents: [],
                knowledge: [],
            })),
        };
        const cm = {
            ...codeManagement(),
            getTypeIntegration: jest.fn(async () => 'github'),
            getPullRequestByNumber: jest.fn(async () => ({
                title: 'Book refunds',
                base: { ref: 'main' },
                head: { ref: 'feature/refunds' },
            })),
        };
        const runner = new CustomAgentTryRunnerService(
            parameters as any,
            cm as any,
            codeBaseConfig as any,
            createSandboxStage as any,
            orchestrator as any,
        );
        return {
            runner,
            sandbox,
            installed,
            createSandboxStage,
            orchestrator,
            codeBaseConfig,
        };
    };

    const run = (runner: CustomAgentTryRunnerService, over: any = {}) =>
        runner.runCustomAgentOnPullRequest({
            organizationAndTeamData: org,
            repositoryId: 'repo-1',
            prUrl: 'https://git.example.test/acme/ledger/pull/42',
            agent: agent(),
            knowledge: [],
            ...over,
        });

    it('refuses a pull request URL of another repository', async () => {
        const { runner, orchestrator, createSandboxStage } = setup();

        await expect(
            run(runner, {
                prUrl: 'https://git.example.test/acme/billing/pull/42',
            }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(createSandboxStage.execute).not.toHaveBeenCalled();
        expect(orchestrator.execute).not.toHaveBeenCalled();
    });

    it('skips without a sandbox or a run when no changed file is in scope', async () => {
        const { runner, orchestrator, createSandboxStage } = setup();

        const trace = await run(runner, {
            agent: agent({ scope: { include: ['src/payroll/**'] } }),
        });

        expect(trace.status).toBe('skipped');
        expect(createSandboxStage.execute).not.toHaveBeenCalled();
        expect(orchestrator.execute).not.toHaveBeenCalled();
    });

    it("opens the review's sandbox for this pull request, installing only this agent's CLIs", async () => {
        const { runner, createSandboxStage } = setup();

        await run(runner);

        const context = createSandboxStage.execute.mock.calls[0][0];
        expect(context.platformType).toBe('github');
        expect(context.branch).toBe('feature/refunds');
        expect(context.pullRequest).toEqual(
            expect.objectContaining({ number: 42, base: { ref: 'main' } }),
        );
        expect(context.repository).toEqual(
            expect.objectContaining({ id: 'repo-1', name: 'acme/ledger' }),
        );
        expect(context.codeReviewConfig.customAgents).toEqual([agent()]);
        expect(context.onlyCustomAgent).toBe('ledger-reviewer');
        expect(context.changedFiles.map((f: any) => f.filename)).toEqual([
            'src/ledger/refund.ts',
            'src/billing/invoice.ts',
        ]);
    });

    it('runs the agent through the review orchestrator with the sandbox, its CLIs and the repository config', async () => {
        const { runner, orchestrator, sandbox, installed } = setup();

        await run(runner, {
            knowledge: [
                {
                    path: '.skills/ledger-posting',
                    kind: 'skill',
                    linkedTo: [{ agentId: 'ledger-agent' }],
                },
            ],
        });

        const input = orchestrator.execute.mock.calls[0][0];
        expect(input.customAgents).toEqual([agent()]);
        expect(input.onlyCustomAgent).toBe('ledger-reviewer');
        expect(input.prNumber).toBe(42);
        expect(input.baseBranch).toBe('main');
        expect(input.changedFiles[0].patchWithLinesStr).toContain('refund');
        // The same tools a review offers: the checkout and runCli.
        expect(input.remoteCommands).toBe(sandbox.remoteCommands);
        expect(input.customAgentTooling).toEqual({
            sandbox,
            installedClis: { 'ledger-agent': installed },
            onCliRun: expect.any(Function),
        });
        // The repository's config, as the review reads it.
        expect(input.languageResultPrompt).toBe('pt-BR');
        expect(input.byokModelId).toBe('repo-model');
        // Skills and docs read from the target branch in the checkout, the
        // source the quote check reads.
        expect(input.knowledgeReader).toBeDefined();
        expect(input.knowledgeByTarget.get('ledger-agent')).toBeDefined();
        expect(
            sandbox.run.mock.calls.some(([command]) =>
                command.includes('refs/remotes/origin/main'),
            ),
        ).toBe(true);
    });

    it('reports what the agent did, with the warnings a review would carry, and releases the sandbox', async () => {
        const { runner, sandbox } = setup();

        const trace = await run(runner, {
            knowledge: [
                {
                    path: '.skills/ledger-posting',
                    kind: 'skill',
                    linkedTo: [{ agentId: 'ledger-agent' }],
                },
            ],
        });

        expect(trace.status).toBe('completed');
        expect(trace.toolCalls.map((call) => call.tool)).toEqual(['runCli']);
        expect(trace.findings).toEqual([
            expect.objectContaining({ verdict: 'kept', wouldPost: true }),
            expect.objectContaining({ verdict: 'dropped', wouldPost: false }),
        ]);
        expect(trace.warnings).toEqual(
            expect.arrayContaining([
                { kind: 'CLI_INSTALL_FAILED', detail: CLI_WARNING.detail },
                expect.objectContaining({ kind: 'SKILL_NOT_FOUND' }),
            ]),
        );
        expect(sandbox.cleanup).toHaveBeenCalled();
    });

    it('says the run read only the diff when the sandbox could not be opened', async () => {
        const { runner, orchestrator } = setup({ checkout: false });

        const trace = await run(runner);

        expect(orchestrator.execute.mock.calls[0][0].remoteCommands).toBe(
            undefined,
        );
        expect(trace.warnings).toEqual([
            expect.objectContaining({ kind: 'SANDBOX_UNAVAILABLE' }),
        ]);
    });

    it('fails with the reason when the agent failed, and still releases the sandbox', async () => {
        const { runner, sandbox } = setup({
            orchestrate: async () => ({
                suggestions: [],
                agentResults: [],
                failures: [
                    {
                        agentName: 'custom-agent:ledger-reviewer',
                        category: 'custom-agent:ledger-reviewer',
                        error: new Error('model refused the key'),
                        durationMs: 0,
                        customAgent: { id: 'ledger-agent' },
                    },
                ],
                incomplete: [],
                customAgentRuns: [],
                totalDurationMs: 1,
                warnings: [],
            }),
        });

        const trace = await run(runner);

        expect(trace.status).toBe('failed');
        expect(trace.reason).toBe('model refused the key');
        expect(sandbox.cleanup).toHaveBeenCalled();
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

describe('buildTryTrace — repeated findings', () => {
    it('shows a second finding on the same lines as a repeat, not as another post', () => {
        // Try it skips the review's dedup: two near-identical findings on one
        // line both read "would post", while the review would post one.
        const at = (summary: string, file = 'src/trace.ts') => ({
            relevantFile: file,
            relevantLinesStart: 2,
            relevantLinesEnd: 2,
            severity: 'medium',
            oneSentenceSummary: summary,
            suggestionContent: summary,
        });
        const trace = buildTryTrace({
            agent: agent(),
            output: {
                suggestions: [
                    at('Use the shared logger instead of console.log in trace'),
                    at('Use the shared logger instead of console.log here'),
                    at('Use the shared logger instead of console.log', 'src/sync.ts'),
                ],
                agentName: 'x',
                turnsUsed: 1,
                durationMs: 1,
            } as any,
            events: [],
            startedAt: Date.now(),
        });

        expect(
            trace.findings.map((f) => [f.file, f.verdict, f.wouldPost, f.reason]),
        ).toEqual([
            ['src/trace.ts', 'kept', true, undefined],
            ['src/sync.ts', 'kept', true, undefined],
            [
                'src/trace.ts',
                'dropped',
                false,
                'repeats a finding on the same lines',
            ],
        ]);
    });
});

describe('buildTryTrace — severity floor before repeats', () => {
    it('lets a severe finding post when the one it repeats is under the floor, as the review does', () => {
        const at = (summary: string, severity: string) => ({
            relevantFile: 'src/ledger/post.ts',
            relevantLinesStart: 4,
            relevantLinesEnd: 4,
            severity,
            oneSentenceSummary: summary,
            suggestionContent: summary,
        });
        const trace = buildTryTrace({
            agent: agent({
                presentation: {
                    ...agent().presentation,
                    minSeverity: 'high' as any,
                },
            }),
            output: {
                suggestions: [
                    at('The entry is posted to one side of the ledger only', 'low'),
                    at('The entry is posted to one side of the ledger only here', 'critical'),
                ],
                agentName: 'x',
                turnsUsed: 1,
                durationMs: 1,
            } as any,
            events: [],
            startedAt: Date.now(),
        });

        expect(
            trace.findings.map((f) => [f.severity, f.verdict, f.wouldPost]),
        ).toEqual([
            ['low', 'kept', false],
            ['critical', 'kept', true],
        ]);
    });
});

describe('buildTryTrace — what the check saw', () => {
    it("shows each drop's own reason, the CLI's output and the comment that would post", () => {
        const trace = buildTryTrace({
            agent: agent(),
            output: {
                suggestions: [
                    {
                        relevantFile: 'src/billing/refund.ts',
                        customAgent: { id: 'ledger-agent', name: 'Ledger' },
                        oneSentenceSummary: 'Refund repeats the charge parser',
                        suggestionContent: 'The parser is copied from charge.ts.',
                        kind: 'convention',
                        source: {
                            file: 'TeamInstructions',
                            quote: 'Report every copied parser.',
                        },
                    },
                ],
                discardedByVerify: [
                    {
                        relevantFile: 'src/billing/void.ts',
                        oneSentenceSummary: 'Void repeats the charge parser',
                        discardReason:
                            'src/billing/void.ts is not a guide linked to this review',
                    },
                ],
                agentName: 'x',
                turnsUsed: 1,
                durationMs: 1,
            } as any,
            events: [
                {
                    status: 'completed',
                    toolCalls: [
                        { tool: 'readFile', args: '{"path":"a"}' },
                        { tool: 'runCli', args: '{"cli":"dupfinder"}' },
                    ],
                } as any,
            ],
            cliRuns: [
                {
                    agentId: 'ledger-agent',
                    cli: 'dupfinder',
                    args: ['src'],
                    output: 'refund.ts:1-20 ~ charge.ts:1-20',
                },
            ],
            startedAt: Date.now(),
        });

        expect(trace.toolCalls.map((c) => c.outputPreview)).toEqual([
            undefined,
            'refund.ts:1-20 ~ charge.ts:1-20',
        ]);
        const [kept, dropped] = trace.findings;
        expect(kept.comment).toBe(
            'The parser is copied from charge.ts.\n\n**Evidence** (`dupfinder` output):\n```text\nrefund.ts:1-20 ~ charge.ts:1-20\n```',
        );
        expect(dropped.reason).toBe(
            'src/billing/void.ts is not a guide linked to this review',
        );
        expect(dropped.comment).toBeUndefined();
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

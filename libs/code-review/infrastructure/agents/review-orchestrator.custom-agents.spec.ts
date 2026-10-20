/**
 * Custom agent dispatch (#2172): one run per enabled agent next to the
 * built-in agents, scoped to the files its globs match, on the fast budget in
 * fast mode, and recorded per agent whether it ran or not.
 */
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import type { CustomAgentConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

type Call = { changedFiles: Array<{ filename: string }>; maxSteps?: number };

function agentConfig(over: Partial<CustomAgentConfig> = {}): CustomAgentConfig {
    return {
        id: 'agent-1',
        name: 'Ledger Rules',
        enabled: true,
        instructions: 'Every ledger write must go through the journal service.',
        scope: { include: ['src/ledger/**'] },
        tools: {},
        presentation: {
            tag: { color: '7B1FA2' },
            format: 'inline',
            suggestedFix: 'when-confident',
        },
        ...over,
    };
}

function setup(customOutput?: (config: CustomAgentConfig) => any) {
    const builtIn = (name: string) => ({
        execute: jest.fn(async () => ({
            suggestions: [],
            durationMs: 1,
            agentName: name,
            agentCategory: name,
        })),
    });
    const generalist = builtIn('generalist');
    const kodyRules = builtIn('kody-rules');
    const customCalls = new Map<string, Call>();
    const factory = {
        create: jest.fn((config: CustomAgentConfig) => ({
            execute: jest.fn(async (input: Call) => {
                customCalls.set(config.id, input);
                if (customOutput) {
                    return customOutput(config);
                }
                return {
                    suggestions: [
                        {
                            relevantFile: input.changedFiles[0]?.filename,
                            customAgent: { id: config.id, name: config.name },
                        },
                    ],
                    discardedByVerify: [{}, {}],
                    durationMs: 1,
                    agentName: config.name,
                    agentCategory: 'custom_agent',
                };
            }),
        })),
    };
    const service = new ReviewOrchestratorService(
        builtIn('bug') as any,
        builtIn('security') as any,
        builtIn('performance') as any,
        generalist as any,
        kodyRules as any,
        factory as any,
    );
    return { service, generalist, kodyRules, factory, customCalls };
}

const files = [
    { filename: 'src/ledger/post-entry.ts' },
    { filename: 'src/ledger/post-entry.spec.ts' },
    { filename: 'src/billing/invoice.ts' },
];

function inputFor(over: Record<string, unknown> = {}) {
    return {
        reviewOptions: { bug: true, security: true, performance: true },
        reviewMode: 'normal',
        prNumber: 7,
        changedFiles: files,
        kodyRules: [{ uuid: 'r1' }],
        ...over,
    } as any;
}

describe('ReviewOrchestratorService — custom agents', () => {
    it('runs each enabled agent in parallel with the generalist and Kody Rules', async () => {
        const { service, generalist, kodyRules, factory } = setup();

        const out = await service.execute(
            inputFor({
                customAgents: [
                    agentConfig(),
                    agentConfig({
                        id: 'agent-2',
                        name: 'Api Contracts',
                        scope: {},
                    }),
                    agentConfig({ id: 'agent-3', name: 'Off', enabled: false }),
                ],
            }),
        );

        expect(generalist.execute).toHaveBeenCalledTimes(1);
        expect(kodyRules.execute).toHaveBeenCalledTimes(1);
        expect(factory.create.mock.calls.map(([c]) => c.id)).toEqual([
            'agent-1',
            'agent-2',
        ]);
        expect(out.suggestions).toHaveLength(2);
    });

    it('gives the main review and each agent only the knowledge linked to it', async () => {
        const { service, generalist, kodyRules, customCalls } = setup();
        const main = { ref: 'main', skills: [], docs: [], warnings: [] };
        const ledger = { ref: 'main', skills: [], docs: [], warnings: [] };

        await service.execute(
            inputFor({
                customAgents: [
                    agentConfig(),
                    agentConfig({ id: 'agent-2', name: 'Api', scope: {} }),
                ],
                knowledgeByTarget: new Map<string, any>([
                    ['main-review', main],
                    ['agent-1', ledger],
                ]),
            }),
        );

        expect((generalist.execute.mock.calls[0] as any[])[0].knowledge).toBe(
            main,
        );
        expect(
            (kodyRules.execute.mock.calls[0] as any[])[0].knowledge,
        ).toBeUndefined();
        expect((customCalls.get('agent-1') as any).knowledge).toBe(ledger);
        expect((customCalls.get('agent-2') as any).knowledge).toBeUndefined();
        expect(
            (customCalls.get('agent-1') as any).knowledgeByTarget,
        ).toBeUndefined();
    });

    it('gives an agent only the changed files its globs match', async () => {
        const { service, customCalls } = setup();

        await service.execute(
            inputFor({
                customAgents: [
                    agentConfig({
                        scope: {
                            include: ['src/ledger/**'],
                            exclude: ['**/*.spec.ts'],
                        },
                    }),
                ],
            }),
        );

        expect(
            customCalls.get('agent-1')!.changedFiles.map((f) => f.filename),
        ).toEqual(['src/ledger/post-entry.ts']);
    });

    it('keeps the call graph and analyzer findings of other files out of a scoped agent', async () => {
        const { service, generalist, customCalls } = setup();
        const callGraph = [
            '<CallGraph>',
            '  <Summary changedFunctions="2" />',
            '',
            '  <ChangedFunction name="postEntry" file="src/ledger/post-entry.ts" lines="1-4" status="new">',
            '    <WhatChanged>New function added</WhatChanged>',
            '  </ChangedFunction>',
            '',
            '  <ChangedFunction name="invoice" file="src/billing/invoice.ts" lines="1-2" status="new">',
            '    <WhatChanged>New function added</WhatChanged>',
            '  </ChangedFunction>',
            '',
            '  <Imports>',
            '    <Import source="src/billing/invoice.ts" target="src/lib/money.ts" new="true" />',
            '  </Imports>',
            '</CallGraph>',
        ].join('\n');
        const analyzerFindings = [
            { ruleId: 'r', path: 'src/ledger/post-entry.ts', startLine: 1 },
            { ruleId: 'r', path: 'src/billing/invoice.ts', startLine: 1 },
        ];

        await service.execute(
            inputFor({
                callGraph,
                analyzerFindings,
                customAgents: [
                    agentConfig({ scope: { include: ['src/ledger/**'] } }),
                ],
            }),
        );

        const scoped = customCalls.get('agent-1') as any;
        expect(scoped.callGraph).toContain('src/ledger/post-entry.ts');
        expect(scoped.callGraph).not.toContain('src/billing/invoice.ts');
        expect(scoped.analyzerFindings.map((f: any) => f.path)).toEqual([
            'src/ledger/post-entry.ts',
        ]);
        // The built-in agents still see the whole PR.
        const main = (generalist.execute.mock.calls[0] as any[])[0];
        expect(main.callGraph).toBe(callGraph);
        expect(main.analyzerFindings).toBe(analyzerFindings);
    });

    it('drops the call graph for a scoped agent when none of its files is in it', async () => {
        const { service, customCalls } = setup();

        await service.execute(
            inputFor({
                callGraph:
                    '<CallGraph>\n  <ChangedFunction name="invoice" file="src/billing/invoice.ts">\n  </ChangedFunction>\n</CallGraph>',
                customAgents: [
                    agentConfig({ scope: { include: ['src/ledger/**'] } }),
                ],
            }),
        );

        expect((customCalls.get('agent-1') as any).callGraph).toBe('');
    });

    it('shows a custom agent only the earlier decisions on its own findings', async () => {
        const { service, generalist, customCalls } = setup();
        const previousDecisions = [
            {
                suggestionId: 'g1',
                label: 'bug',
                suggestionContent: 'native',
                outcome: 'pending',
                decidedAt: '',
            },
            {
                suggestionId: 'c1',
                label: 'custom_agent',
                customAgentId: 'agent-1',
                suggestionContent: 'mine',
                outcome: 'pending',
                decidedAt: '',
            },
            {
                suggestionId: 'c2',
                label: 'custom_agent',
                customAgentId: 'agent-2',
                suggestionContent: 'other agent',
                outcome: 'pending',
                decidedAt: '',
            },
        ];

        await service.execute(
            inputFor({
                previousDecisions,
                customAgents: [agentConfig({ scope: {} })],
            }),
        );

        expect(
            (customCalls.get('agent-1') as any).previousDecisions.map(
                (d: any) => d.suggestionId,
            ),
        ).toEqual(['c1']);
        expect(
            (generalist.execute.mock.calls[0] as any[])[0].previousDecisions,
        ).toBe(previousDecisions);
    });

    describe('ignored files', () => {
        const ignoredChangedFiles = [
            { filename: 'package.json', patch: '@@ -1 +1 @@\n-a\n+b' },
            {
                filename: 'infra/envs/prod/main.tf',
                patch: '@@ -1 +1 @@\n-a\n+b',
            },
        ];

        it('gives an agent the ignored files its globs name, and no one else', async () => {
            const { service, generalist, kodyRules, customCalls } = setup();

            await service.execute(
                inputFor({
                    ignoredChangedFiles,
                    customAgents: [
                        agentConfig({
                            scope: {
                                include: ['src/ledger/**', 'package.json'],
                                exclude: ['**/*.spec.ts'],
                            },
                        }),
                        agentConfig({
                            id: 'agent-2',
                            name: 'Infra',
                            scope: { include: ['infra/**/*.tf'] },
                        }),
                        agentConfig({
                            id: 'agent-3',
                            name: 'Everything',
                            scope: { include: ['**/*'] },
                        }),
                    ],
                }),
            );

            const seen = (id: string) =>
                customCalls.get(id)!.changedFiles.map((f) => f.filename);
            expect(seen('agent-1')).toEqual([
                'src/ledger/post-entry.ts',
                'package.json',
            ]);
            expect(seen('agent-2')).toEqual(['infra/envs/prod/main.tf']);
            expect(seen('agent-3')).toEqual(files.map((f) => f.filename));
            for (const builtIn of [generalist, kodyRules]) {
                const call = (builtIn.execute.mock.calls[0] as any[])[0];
                expect(call.changedFiles.map((f: any) => f.filename)).toEqual(
                    files.map((f) => f.filename),
                );
                expect(call.ignoredChangedFiles).toBeUndefined();
            }
        });

        it('runs an agent whose only files are ignored files it names', async () => {
            const { service, customCalls } = setup();

            const out = await service.execute(
                inputFor({
                    ignoredChangedFiles,
                    customAgents: [
                        agentConfig({ scope: { include: ['package.json'] } }),
                    ],
                }),
            );

            expect(
                customCalls.get('agent-1')!.changedFiles.map((f) => f.filename),
            ).toEqual(['package.json']);
            expect(out.customAgentRuns).toEqual([
                expect.objectContaining({ id: 'agent-1', status: 'ran' }),
            ]);
        });

        it('runs only the naming agent when every changed file is ignored', async () => {
            const { service, generalist, kodyRules, factory, customCalls } =
                setup();

            const out = await service.execute(
                inputFor({
                    changedFiles: [],
                    ignoredChangedFiles,
                    customAgents: [
                        agentConfig({ scope: { include: ['package.json'] } }),
                    ],
                }),
            );

            expect(generalist.execute).not.toHaveBeenCalled();
            expect(kodyRules.execute).not.toHaveBeenCalled();
            expect(factory.create).toHaveBeenCalledTimes(1);
            expect(
                customCalls.get('agent-1')!.changedFiles.map((f) => f.filename),
            ).toEqual(['package.json']);
            expect(out.suggestions).toEqual([
                expect.objectContaining({ relevantFile: 'package.json' }),
            ]);
        });

        it('does not run an agent whose broad globs match only ignored files', async () => {
            const { service, factory } = setup();

            const out = await service.execute(
                inputFor({
                    ignoredChangedFiles,
                    customAgents: [
                        agentConfig({ scope: { include: ['**/*.json'] } }),
                    ],
                }),
            );

            expect(factory.create).not.toHaveBeenCalled();
            expect(out.customAgentRuns).toEqual([
                expect.objectContaining({ status: 'no-matching-files' }),
            ]);
        });
    });

    it('skips an agent whose globs match no changed file and records it', async () => {
        const { service, factory } = setup();

        const out = await service.execute(
            inputFor({
                customAgents: [
                    agentConfig({ scope: { include: ['docs/**'] } }),
                ],
            }),
        );

        expect(factory.create).not.toHaveBeenCalled();
        expect(out.customAgentRuns).toEqual([
            expect.objectContaining({
                id: 'agent-1',
                slug: 'ledger-rules',
                status: 'no-matching-files',
            }),
        ]);
    });

    it('records what verification dropped per agent', async () => {
        const { service } = setup();

        const out = await service.execute(
            inputFor({ customAgents: [agentConfig()] }),
        );

        expect(out.customAgentRuns).toEqual([
            expect.objectContaining({
                status: 'ran',
                droppedByVerify: 2,
            }),
        ]);
    });

    it('runs custom agents on the fast step budget in fast mode', async () => {
        const { service, customCalls } = setup();

        await service.execute(
            inputFor({ reviewMode: 'fast', customAgents: [agentConfig()] }),
        );

        expect(customCalls.get('agent-1')!.maxSteps).toBe(4);
    });

    it('runs every enabled agent, with no cap on how many', async () => {
        const { service, factory } = setup();

        await service.execute(
            inputFor({
                customAgents: Array.from({ length: 7 }, (_, i) =>
                    agentConfig({ id: `a${i}`, name: `Agent ${i}`, scope: {} }),
                ),
            }),
        );

        expect(factory.create).toHaveBeenCalledTimes(7);
    });

    it('runs only the requested agent on `@kody -v <slug>`, even when disabled', async () => {
        const { service, generalist, kodyRules, factory } = setup();

        await service.execute(
            inputFor({
                onlyCustomAgent: 'ledger-rules',
                customAgents: [
                    agentConfig({ enabled: false }),
                    agentConfig({
                        id: 'agent-2',
                        name: 'Api Contracts',
                        scope: {},
                    }),
                ],
            }),
        );

        expect(generalist.execute).not.toHaveBeenCalled();
        expect(kodyRules.execute).not.toHaveBeenCalled();
        expect(factory.create.mock.calls.map(([c]) => c.id)).toEqual([
            'agent-1',
        ]);
    });

    it('runs the first of two saved agents sharing a slug, and logs the clash', async () => {
        const { service, factory } = setup();
        const warn = jest
            .spyOn((service as any).logger, 'warn')
            .mockImplementation(() => undefined);

        const out = await service.execute(
            inputFor({
                customAgents: [
                    agentConfig(),
                    agentConfig({ id: 'agent-2', name: 'ledger rules' }),
                ],
            }),
        );

        expect(factory.create.mock.calls.map(([c]) => c.id)).toEqual([
            'agent-1',
        ]);
        expect(out.customAgentRuns.map((r: any) => r.id)).toEqual(['agent-1']);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining(
                    'share the command name "ledger-rules"',
                ),
            }),
        );
    });

    it('reports a failed agent with the custom agent it belongs to', async () => {
        const { service } = setup(() => {
            throw new Error('provider down');
        });

        const out = await service.execute(
            inputFor({
                customAgents: [agentConfig()],
            }),
        );

        expect(out.failures).toEqual([
            expect.objectContaining({
                agentName: 'custom-agent:ledger-rules',
                customAgent: { id: 'agent-1' },
            }),
        ]);
        expect(out.customAgentRuns?.[0].status).toBe('failed');
    });

    it('logs a skipped and a failed agent with the review and agent ids', async () => {
        const { service } = setup(() => {
            throw new Error('provider down');
        });
        const logger = (service as any).logger;
        const log = jest
            .spyOn(logger, 'log')
            .mockImplementation(() => undefined);
        const error = jest
            .spyOn(logger, 'error')
            .mockImplementation(() => undefined);
        const ids = {
            organizationId: 'org-1',
            teamId: 'team-1',
            repositoryId: 'repo-1',
            prNumber: 7,
        };

        await service.execute(
            inputFor({
                organizationAndTeamData: {
                    organizationId: 'org-1',
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
                customAgents: [
                    agentConfig(),
                    agentConfig({
                        id: 'agent-2',
                        name: 'Docs only',
                        scope: { include: ['**/*.nothing'] },
                    }),
                ],
            }),
        );

        expect(log).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    ...ids,
                    customAgentId: 'agent-2',
                    customAgentSlug: 'docs-only',
                    reason: 'no-matching-files',
                }),
            }),
        );
        expect(error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('custom-agent:ledger-rules'),
                metadata: expect.objectContaining({
                    ...ids,
                    customAgentId: 'agent-1',
                }),
            }),
        );
    });

    it('reports a cut-short agent as incomplete', async () => {
        const { service } = setup((config) => ({
            suggestions: [],
            durationMs: 1,
            agentName: config.name,
            hitHardLimit: true,
            finishReason: 'max-steps',
        }));

        const out = await service.execute(
            inputFor({ customAgents: [agentConfig()] }),
        );

        expect(out.incomplete).toEqual([
            expect.objectContaining({
                customAgent: { id: 'agent-1' },
            }),
        ]);
        expect(out.customAgentRuns?.[0].status).toBe('incomplete');
    });

    it('reports an agent that never submitted a result as incomplete, with why', async () => {
        const { service } = setup((config) => ({
            suggestions: [],
            durationMs: 1,
            agentName: config.name,
            hitHardLimit: true,
            finishReason: 'no-result',
        }));

        const out = await service.execute(
            inputFor({ customAgents: [agentConfig()] }),
        );

        expect(out.incomplete).toEqual([
            expect.objectContaining({ finishReason: 'no-result' }),
        ]);
        expect(out.customAgentRuns?.[0].status).toBe('incomplete');
    });

    it('runs nothing custom when no agents are passed (feature off)', async () => {
        const { service, factory } = setup();

        const out = await service.execute(inputFor());

        expect(factory.create).not.toHaveBeenCalled();
        expect(out.customAgentRuns).toEqual([]);
    });
});

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
            mode: 'shadow',
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
                mode: 'shadow',
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

    it('caps the agents a review runs at the configured limit', async () => {
        const { service, factory } = setup();

        await service.execute(
            inputFor({
                customAgents: Array.from({ length: 7 }, (_, i) =>
                    agentConfig({ id: `a${i}`, name: `Agent ${i}`, scope: {} }),
                ),
            }),
        );

        expect(factory.create).toHaveBeenCalledTimes(5);
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

    it('reports a failed agent with its mode so the stage can tell shadow from post', async () => {
        const { service } = setup(() => {
            throw new Error('provider down');
        });

        const out = await service.execute(
            inputFor({
                customAgents: [
                    agentConfig({
                        presentation: {
                            ...agentConfig().presentation,
                            mode: 'post',
                        },
                    }),
                ],
            }),
        );

        expect(out.failures).toEqual([
            expect.objectContaining({
                agentName: 'custom-agent:ledger-rules',
                customAgent: { id: 'agent-1', mode: 'post' },
            }),
        ]);
        expect(out.customAgentRuns?.[0].status).toBe('failed');
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
                customAgent: { id: 'agent-1', mode: 'shadow' },
            }),
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

/**
 * A skill run opens MCP clients for its context fetcher. Each client keeps a
 * session-cleanup interval, so a run that never releases them leaves timers
 * and connections behind in the worker after every pull request.
 */
import { AbstractSkillProvider } from './abstract-skill-provider';

type TestContext = {
    organizationAndTeamData: unknown;
    userLanguage: string;
    formattedResponse?: string;
};

class TestSkillProvider extends AbstractSkillProvider<TestContext, any> {
    protected readonly skillName = 'testSkill';
    protected readonly maxOutputTokensFallback = 100;
    protected readonly defaultLLMConfig = {
        llmProvider: 'openai' as any,
        temperature: 0,
        maxTokens: 100,
        maxReasoningTokens: 0,
        stop: undefined,
    };

    constructor(
        runner: unknown,
        private readonly steps: unknown[] = [],
    ) {
        super(
            { resolveTaskSlot: jest.fn().mockResolvedValue(null) } as any,
            {} as any,
            runner as any,
        );
    }

    protected async createMCPAdapter(): Promise<void> {
        // The fetcher runtime is stubbed; no MCP needed.
    }
    protected createBlueprint() {
        return this.steps as any;
    }
    protected async runLLMStep(_step: any, ctx: TestContext) {
        return ctx;
    }
    protected createInitialContext(params: {
        organizationAndTeamData: unknown;
        userLanguage: string;
    }): TestContext {
        return { ...params, formattedResponse: 'done' };
    }
    protected async resolveUserLanguage() {
        return 'en-US';
    }
}

function build(steps?: unknown[]) {
    const dispose = jest.fn(async () => undefined);
    const runner = {
        createFetcherOrchestration: jest.fn(async () => ({
            toolCaller: {} as any,
            capabilityRuntime: {} as any,
            dispose,
        })),
    };
    return { provider: new TestSkillProvider(runner, steps), dispose };
}

const context = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
} as any;

describe('AbstractSkillProvider fetcher lifecycle', () => {
    it('releases the fetcher runtime after a run', async () => {
        const { provider, dispose } = build();

        await expect(provider.execute(context)).resolves.toBe('done');

        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it('releases the fetcher runtime when the run throws', async () => {
        const { provider, dispose } = build([
            {
                name: 'boom',
                type: 'deterministic',
                fn: async () => {
                    throw new Error('step failed');
                },
            },
        ]);

        await expect(provider.execute(context)).rejects.toThrow();

        expect(dispose).toHaveBeenCalledTimes(1);
    });
});

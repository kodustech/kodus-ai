/**
 * Skill trace scope — proves the Langfuse trace identity wraps the WHOLE skill
 * run, context fetcher included.
 *
 * This is the part that is easy to get wrong and impossible to see from the
 * code: wrapping only the LLM step still leaves the fetcher's model calls
 * outside the session, so the gathering phase reads as "missing" next to the
 * analysis it fed. The assertion is therefore ORDERING — propagation must be
 * active BEFORE the fetcher orchestration is built, not just around the steps.
 */
const propagated: { params: any[] } = { params: [] };
jest.mock('@langfuse/tracing', () => ({
    propagateAttributes: (params: any, fn: () => unknown) => {
        propagated.params.push(params);
        return fn();
    },
}));

import { AbstractSkillProvider } from './abstract-skill-provider';

type TestContext = {
    organizationAndTeamData: unknown;
    userLanguage: string;
    formattedResponse?: string;
};

/** Records the order in which the run's phases happen. */
const timeline: string[] = [];

class TestSkillProvider extends AbstractSkillProvider<TestContext, any> {
    protected readonly skillName = 'testSkill';
    protected readonly defaultLLMConfig = {
        llmProvider: 'openai' as any,
        temperature: 0,
        maxTokens: 100,
        maxReasoningTokens: 0,
        stop: undefined,
    };

    protected async createMCPAdapter(): Promise<void> {
        // The fetcher orchestration is stubbed in this test; no MCP needed.
    }
    protected createBlueprint() {
        return [];
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

function build() {
    const createFetcherOrchestration = jest.fn(async () => {
        timeline.push(
            propagated.params.length > 0
                ? 'fetcher-inside-trace'
                : 'fetcher-outside-trace',
        );
        return {
            toolCaller: {} as any,
            capabilityRuntime: {} as any,
        };
    });

    const provider = new TestSkillProvider(
        { getBYOKConfigV2Raw: jest.fn().mockResolvedValue(null) } as any,
        {} as any,
        { createFetcherOrchestration } as any,
    );
    return { provider, createFetcherOrchestration };
}

describe('AbstractSkillProvider trace scope', () => {
    const originalEnv = { ...process.env };
    beforeEach(() => {
        propagated.params = [];
        timeline.length = 0;
    });
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    function enableTracing() {
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-test';
    }

    it('opens the trace before the context fetcher runs', async () => {
        enableTracing();
        const { provider, createFetcherOrchestration } = build();

        const res = await provider.execute({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        } as any);

        expect(res).toBe('done');
        expect(createFetcherOrchestration).toHaveBeenCalledTimes(1);
        // The fetcher — the phase that was outside the session before — now
        // runs with the trace already propagating.
        expect(timeline).toEqual(['fetcher-inside-trace']);
    });

    it('scopes a generic skill to the org without inventing a session', async () => {
        enableTracing();
        const { provider } = build();

        await provider.execute({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        } as any);

        expect(propagated.params).toHaveLength(1);
        expect(propagated.params[0]).toMatchObject({
            traceName: 'testSkill',
            userId: 'org-1',
            metadata: {
                organizationId: 'org-1',
                teamId: 'team-1',
                skill: 'testSkill',
            },
        });
        // A skill with nothing to group under gets no session key.
        expect(propagated.params[0].sessionId).toBeUndefined();
    });

    it('runs unwrapped when tracing is disabled', async () => {
        delete process.env.LANGFUSE_TRACING;
        const { provider } = build();

        const res = await provider.execute({
            organizationAndTeamData: { organizationId: 'org-1' },
        } as any);

        expect(res).toBe('done');
        expect(propagated.params).toHaveLength(0);
    });
});

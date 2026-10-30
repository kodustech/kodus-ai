import { OverflowRecoveringRunner } from './overflow-recovering-runner';
import type {
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';

const overflowState = (): RunState =>
    ({
        runId: 'r',
        agentId: 'a',
        status: 'error',
        steps: [],
        artifacts: [],
        trace: [
            {
                at: 0,
                source: 'runner',
                kind: 'error',
                detail: { message: 'context_length_exceeded' },
            },
        ],
        usage: {},
    }) as unknown as RunState;

const okState = (): RunState =>
    ({
        runId: 'r',
        agentId: 'a',
        status: 'completed',
        steps: [],
        artifacts: [],
        trace: [],
        usage: {},
    }) as unknown as RunState;

const rateLimitState = (): RunState =>
    ({
        runId: 'r',
        agentId: 'a',
        status: 'error',
        steps: [],
        artifacts: [],
        trace: [
            {
                at: 0,
                source: 'runner',
                kind: 'error',
                detail: { message: 'rate limit exceeded, try again' },
            },
        ],
        usage: {},
    }) as unknown as RunState;

// A spec whose single policy is a fake "compression" policy, so we can observe
// the tightener swapping it.
const spec = (windowTag: string): AgentSpec =>
    ({
        id: 'finder',
        systemPrompt: 's',
        modelId: 'm',
        tools: { get: () => undefined, list: () => [] },
        policies: [{ name: 'compression', tag: windowTag }],
        maxSteps: 20,
    }) as unknown as AgentSpec;

// Tightener stamps the scale onto the compression policy so the retry spec is
// observably different from the first.
const tighten = (s: AgentSpec, scale: number): AgentSpec =>
    ({
        ...s,
        policies: s.policies.map((p: any) =>
            p.name === 'compression' ? { ...p, scale } : p,
        ),
    }) as AgentSpec;

function recordingRunner(states: RunState[]): {
    runner: AgentRunner;
    calls: { spec: AgentSpec }[];
} {
    const calls: { spec: AgentSpec }[] = [];
    let i = 0;
    const runner: AgentRunner = {
        run: async (s) => {
            calls.push({ spec: s });
            return states[Math.min(i++, states.length - 1)];
        },
    };
    return { runner, calls };
}

const input = { prompt: 'find bugs' } as any;
const ctx = { runId: 'x' } as any;

describe('OverflowRecoveringRunner', () => {
    it('re-runs once at a tighter window when the pass overflows', async () => {
        const { runner, calls } = recordingRunner([overflowState(), okState()]);
        const rec = new OverflowRecoveringRunner(runner, tighten, 0.6);

        const out = await rec.run(spec('orig'), input, ctx);

        expect(calls).toHaveLength(2);
        // second call got the tightened spec
        expect((calls[1].spec.policies[0] as any).scale).toBe(0.6);
        // returns the recovered (completed) state
        expect(out.status).toBe('completed');
    });

    it('does NOT retry on a non-overflow failure (rate limit)', async () => {
        const { runner, calls } = recordingRunner([rateLimitState()]);
        const rec = new OverflowRecoveringRunner(runner, tighten);

        const out = await rec.run(spec('orig'), input, ctx);

        expect(calls).toHaveLength(1);
        expect(out.status).toBe('error');
    });

    it('does NOT retry on success', async () => {
        const { runner, calls } = recordingRunner([okState()]);
        const rec = new OverflowRecoveringRunner(runner, tighten);

        await rec.run(spec('orig'), input, ctx);

        expect(calls).toHaveLength(1);
    });

    it('returns the retry result even if it overflows again (single attempt)', async () => {
        const { runner, calls } = recordingRunner([
            overflowState(),
            overflowState(),
        ]);
        const rec = new OverflowRecoveringRunner(runner, tighten);

        const out = await rec.run(spec('orig'), input, ctx);

        expect(calls).toHaveLength(2); // exactly one retry, no infinite loop
        expect(out.status).toBe('error');
    });
});

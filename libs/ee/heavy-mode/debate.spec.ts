/**
 * The debate (debate.ts) over scripted runners: no model. Each runner answers
 * from a queue of submits; the test reads which findings both sides end up
 * endorsing and when the debate stops.
 */
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { buildFinderAgentSpec } from '@libs/code-review/infrastructure/agents/core/finder.agent';

import { DEBATE_MAX_ROUNDS, debateProfiles, runDebate, withDebateFields } from './debate';

const finding = (file: string, text: string, label = 'bug') => ({
    label,
    relevantFile: file,
    relevantLinesStart: 1,
    relevantLinesEnd: 1,
    suggestionContent: text,
});

function scripted(submits: Array<Record<string, unknown>>) {
    const prompts: string[] = [];
    return {
        prompts,
        run: async (_spec: unknown, input: { prompt: string }) => {
            prompts.push(input.prompt);
            const payload = submits.shift() ?? { reasoning: 'nothing', suggestions: [], keep: [], objections: [], done: true };
            return {
                runId: 'r',
                agentId: 'finder',
                status: 'completed',
                steps: [],
                artifacts: [{ type: 'submitResult', payload }],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                trace: [],
            } as any;
        },
    };
}

const spec = buildFinderAgentSpec({ systemPrompt: 's', modelId: 'm', tools: new InMemoryToolRegistry([]), labels: ['bug', 'security', 'performance'] });
const ctx = { runId: 'r' } as unknown as ToolContext;

async function debate(a: ReturnType<typeof scripted>, b: ReturnType<typeof scripted>, variant: 'attack' | 'focus' = 'attack') {
    const [pa, pb] = debateProfiles(variant);
    return runDebate({
        variant,
        label: `lens-debate-${variant}`,
        sides: [
            { profile: pa, runner: a as any, spec, modelId: 'm' },
            { profile: pb, runner: b as any, spec, modelId: 'm2' },
        ],
        diffText: 'diff',
        claudeWording: false,
        params: { runner: a as any, modelId: 'm' } as any,
        ctx,
    });
}

describe('runDebate', () => {
    it('reports only what both sides endorse, and stops once both are done', async () => {
        const a = scripted([
            { reasoning: 'r1', suggestions: [finding('a.ts', 'A bug')] },
            { reasoning: 'r2', suggestions: [], keep: ['A1'], objections: [{ id: 'B1', reason: 'guarded in caller' }], done: true },
            { reasoning: 'r3', suggestions: [], keep: ['A1'], objections: [], done: true },
        ]);
        const b = scripted([
            { reasoning: 'r1', suggestions: [finding('b.ts', 'B bug')] },
            { reasoning: 'r2', suggestions: [], keep: ['A1', 'B1'], objections: [], done: false },
            { reasoning: 'r3', suggestions: [], keep: ['A1'], objections: [], done: true },
        ]);
        const out = await debate(a, b);
        expect(out.suggestions.map((s) => s.suggestionContent)).toEqual(['A bug']);
        expect(out.rounds).toBe(3);
        expect(out.stoppedBy).toBe('both-done');
        // B saw A's objection to its finding in round 3.
        expect(b.prompts[2]).toContain('[B1] guarded in caller');
    });

    it('stops after round 1 when neither side found anything', async () => {
        const out = await debate(scripted([{ reasoning: 'none', suggestions: [] }]), scripted([{ reasoning: 'none', suggestions: [] }]));
        expect(out.suggestions).toEqual([]);
        expect(out.rounds).toBe(1);
    });

    it('a finding added late counts only once the other side endorses it', async () => {
        const a = scripted([
            { reasoning: 'r1', suggestions: [] },
            { reasoning: 'r2', suggestions: [finding('c.ts', 'late bug')], keep: ['B1'], objections: [], done: false },
            { reasoning: 'r3', suggestions: [], keep: ['B1', 'A1'], objections: [], done: true },
        ]);
        const b = scripted([
            { reasoning: 'r1', suggestions: [finding('b.ts', 'B bug')] },
            { reasoning: 'r2', suggestions: [], keep: ['B1'], objections: [], done: false },
            { reasoning: 'r3', suggestions: [], keep: ['B1', 'A1'], objections: [], done: true },
        ]);
        const out = await debate(a, b);
        expect(out.suggestions.map((s) => s.suggestionContent).sort()).toEqual(['B bug', 'late bug']);
    });

    it('never goes past the round limit', async () => {
        const open = (n: number) => Array.from({ length: n }, (_, i) =>
            i === 0 ? { reasoning: 'r', suggestions: [finding('a.ts', 'x')] } : { reasoning: 'r', suggestions: [finding(`n${i}.ts`, `new ${i}`)], keep: [], objections: [], done: false },
        );
        const out = await debate(scripted(open(9)), scripted(open(9)));
        expect(out.rounds).toBe(DEBATE_MAX_ROUNDS);
        expect(out.stoppedBy).toBe('max-rounds');
    });

    it('the security side keeps only security findings', async () => {
        const a = scripted([{ reasoning: 'r', suggestions: [finding('a.ts', 'logic')] }]);
        const b = scripted([{ reasoning: 'r', suggestions: [finding('b.ts', 'not security'), finding('c.ts', 'injection', 'security')] }]);
        const out = await debate(a, b, 'focus');
        expect(b.prompts.length).toBeGreaterThan(1);
        expect(b.prompts[1]).toContain('injection');
        expect(b.prompts[1]).not.toContain('not security');
        expect(out.rounds).toBeGreaterThan(1);
    });
});

describe('withDebateFields', () => {
    it('adds keep, objections and done to the done tool', () => {
        const tool = withDebateFields(spec.tools.list().find((t) => t.name === 'submitResult')!);
        const schema = tool.inputSchema as any;
        expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['keep', 'objections', 'done']));
        expect(schema.required).toEqual(expect.arrayContaining(['keep', 'objections', 'done']));
    });
});

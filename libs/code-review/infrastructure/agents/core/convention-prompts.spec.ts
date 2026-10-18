/**
 * Convention findings — the finder-facing contract, zero LLM: the done-tool
 * schema, the findings sanitizer, the system-prompt block and the recall pass.
 * Every one of them must leave a non-custom-agent review byte-identical.
 */
import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import {
    buildFinderAgentSpec,
    runRecallPasses,
    type FinderSuggestion,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { sanitizeFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';
import { formatConventionFindingRules } from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';

const GUIDE = 'docs/guides/valve-api.md';

const ledger: ProgressLedger = {
    markFromToolCall: () => undefined,
    summary: () => ({
        totalTargets: 0,
        pendingTargets: 0,
        criticalTotal: 0,
        criticalPending: 0,
    }),
    debtNote: () => null,
};

function itemProps(acceptsConventions?: boolean): Record<string, any> {
    const spec = buildFinderAgentSpec({
        systemPrompt: 's',
        modelId: 'mock',
        tools: new InMemoryToolRegistry([]),
        coverageLedger: ledger,
        acceptsConventions,
    });
    const schema = spec.tools.get('submitResult')!.inputSchema as any;
    return schema.properties.suggestions.items.properties;
}

describe('submitResult schema', () => {
    it('offers kind and source only to custom agents with guides', () => {
        expect(itemProps()).not.toHaveProperty('kind');
        expect(itemProps()).not.toHaveProperty('source');
        const props = itemProps(true);
        expect(props.kind.enum).toEqual(['bug', 'convention']);
        expect(props.source.required).toEqual(['file', 'quote']);
        expect(props.source.additionalProperties).toBe(false);
    });
});

describe('sanitizeFindingsResult with kind/source', () => {
    const base = {
        relevantFile: 'src/valves/open-valve.handler.ts',
        suggestionContent: 'c',
        existingCode: 'a',
        improvedCode: 'b',
    };

    it('keeps kind and source', () => {
        const out = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [
                {
                    ...base,
                    kind: 'convention',
                    source: { file: GUIDE, section: 'Handlers', quote: 'q' },
                },
            ],
        } as any);
        expect(out!.suggestions[0].kind).toBe('convention');
        expect(out!.suggestions[0].source).toEqual({
            file: GUIDE,
            section: 'Handlers',
            quote: 'q',
        });
    });

    it('reads an off-schema kind or source as absent instead of dropping the finding', () => {
        const out = sanitizeFindingsResult({
            reasoning: 'r',
            suggestions: [{ ...base, kind: 'style', source: { file: GUIDE } }],
        } as any);
        expect(out!.suggestions).toHaveLength(1);
        expect(out!.suggestions[0].kind).toBeUndefined();
        expect(out!.suggestions[0].source).toBeUndefined();
    });
});

describe('formatConventionFindingRules', () => {
    it('is empty without guides', () => {
        expect(formatConventionFindingRules()).toBe('');
        expect(formatConventionFindingRules([])).toBe('');
    });

    it('asks for kind convention and the verbatim sentence of each linked guide', () => {
        const block = formatConventionFindingRules([
            GUIDE,
            'skills/valves/SKILL.md',
        ]);
        expect(block).toContain(`- ${GUIDE}`);
        expect(block).toContain('- skills/valves/SKILL.md');
        expect(block).toContain('kind "convention"');
        expect(block).toContain('copied verbatim');
        expect(block).toContain('discarded');
    });
});

describe('synthesis rescue with linked guides', () => {
    const finderState = {
        artifacts: [],
        steps: [],
        usage: {},
        status: 'completed',
        trace: [],
    } as unknown as RunState;
    const base = {
        reasoning: 'r',
        suggestions: [
            {
                relevantFile: 'src/a.ts',
                suggestionContent: 'x',
                existingCode: '',
                improvedCode: '',
            } as FinderSuggestion,
        ],
    };

    async function rescuePrompt(conventionGuides?: string[]): Promise<string> {
        const run = jest.fn(async () => finderState);
        await runRecallPasses(
            base,
            {
                runner: { run } as any,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'review',
                conventionGuides,
            },
            { runId: 'rescue' },
        );
        return (run.mock.calls[0] as any[])[1].prompt;
    }

    it('asks for missed guide violations only when guides are linked', async () => {
        const plain = await rescuePrompt();
        expect(plain).not.toContain('LinkedGuides');
        expect(plain).toMatch(/submit an empty suggestions array\.$/);

        const withGuides = await rescuePrompt([GUIDE]);
        expect(withGuides.startsWith(plain)).toBe(true);
        expect(withGuides).toContain(
            `<LinkedGuides>\n- ${GUIDE}\n</LinkedGuides>`,
        );
        expect(withGuides).toContain('MISSED VIOLATIONS');
        expect(withGuides).toContain('kind "convention"');
    });
});

describe('synthesis rescue — team systems (#2172)', () => {
    const TRACKER_TOOL = 'Tracker__get_issue';

    function stateWithCalls(
        calls: Array<{ name: string; input: unknown }>,
    ): RunState {
        return {
            artifacts: [
                {
                    type: 'submitResult',
                    payload: { reasoning: 'r', suggestions: [] },
                },
            ],
            steps: [{ index: 0, message: { toolCalls: calls } }],
            usage: { inputTokens: 1, outputTokens: 1 },
            status: 'done',
        } as any;
    }

    async function rescuePrompt(
        finderState: RunState,
        teamSystemTools?: string[],
    ): Promise<string> {
        const run = jest.fn(async () => finderState);
        await runRecallPasses(
            { reasoning: 'r', suggestions: [] },
            {
                runner: { run } as any,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'review',
                teamSystemTools,
            },
            { runId: 'rescue' },
        );
        return (run.mock.calls[0] as any[])[1].prompt;
    }

    const consulted = stateWithCalls([
        { name: 'readFile', input: { path: 'src/valve.ts' } },
        { name: TRACKER_TOOL, input: { key: 'VALVE-12' } },
    ]);

    it('asks whether a consulted team system states a requirement the change breaks', async () => {
        const plain = await rescuePrompt(consulted);
        const withSystems = await rescuePrompt(consulted, [TRACKER_TOOL]);

        expect(withSystems.startsWith(plain)).toBe(true);
        expect(withSystems).toContain(
            'Did a team system you consulted state a requirement this change breaks?',
        );
        expect(withSystems).toContain(
            `<ConsultedTeamSystems>\n- ${TRACKER_TOOL}({"key":"VALVE-12"})\n</ConsultedTeamSystems>`,
        );
        // Not a code-evidence question: the record is the evidence.
        expect(withSystems).toMatch(/even when the code never mentions it/);
    });

    it('leaves the rescue prompt of an agent without team systems unchanged', async () => {
        const plain = await rescuePrompt(consulted);

        expect(await rescuePrompt(consulted, [])).toBe(plain);
        expect(plain).not.toMatch(/team system/i);
        expect(plain).toMatch(/submit an empty suggestions array\.$/);
    });

    it('says so when no team system was consulted yet', async () => {
        const prompt = await rescuePrompt(
            stateWithCalls([{ name: 'readFile', input: { path: 'a.ts' } }]),
            [TRACKER_TOOL],
        );

        expect(prompt).toContain(
            '<ConsultedTeamSystems>\nNone yet.\n</ConsultedTeamSystems>',
        );
    });
});

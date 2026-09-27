import type { RunState } from '../../domain/contracts/run-state.contract';
import {
    buildVerifierAgentSpec,
    extractVerdict,
    VERIFY_DONE_TOOL,
} from './llm-verdict';

function stateWith(artifacts: RunState['artifacts'], steps: any[] = []): RunState {
    return {
        runId: 'r',
        agentId: 'verifier',
        steps,
        artifacts,
        messages: [],
        usage: {},
    } as unknown as RunState;
}

describe('extractVerdict (fail-open / refute-to-drop)', () => {
    it('reads an explicit keep=false verdict from the artifacts', () => {
        const v = extractVerdict(
            stateWith([
                {
                    type: VERIFY_DONE_TOOL,
                    payload: {
                        keep: false,
                        rationale: 'diff actually satisfies the task',
                        confidence: 'high',
                    },
                } as any,
            ]),
        );
        expect(v.keep).toBe(false);
        expect(v.rationale).toContain('satisfies');
        expect(v.confidence).toBe('high');
    });

    it('reads an explicit keep=true verdict', () => {
        const v = extractVerdict(
            stateWith([
                { type: VERIFY_DONE_TOOL, payload: { keep: true, rationale: 'real gap' } } as any,
            ]),
        );
        expect(v.keep).toBe(true);
    });

    it('defaults to keep=true when no verdict artifact is present (fail-open)', () => {
        const v = extractVerdict(stateWith([]));
        expect(v.keep).toBe(true);
        expect(v.rationale).toMatch(/kept by default/);
    });

    it('defaults to keep=true when the verdict payload is malformed', () => {
        const v = extractVerdict(
            stateWith([{ type: VERIFY_DONE_TOOL, payload: { keep: 'nope' } } as any]),
        );
        expect(v.keep).toBe(true);
    });

    it('uses the LAST verdict artifact when several are present', () => {
        const v = extractVerdict(
            stateWith([
                { type: VERIFY_DONE_TOOL, payload: { keep: true, rationale: 'first' } } as any,
                { type: VERIFY_DONE_TOOL, payload: { keep: false, rationale: 'second' } } as any,
            ]),
        );
        expect(v.keep).toBe(false);
        expect(v.rationale).toBe('second');
    });

    it('attaches investigation tool calls (excluding the verdict tool) to the verdict', () => {
        const v = extractVerdict(
            stateWith(
                [{ type: VERIFY_DONE_TOOL, payload: { keep: false, rationale: 'x' } } as any],
                [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '',
                            toolCalls: [
                                { id: '1', name: 'readFile', input: { path: 'a.ts' }, output: '...' },
                                { id: '2', name: VERIFY_DONE_TOOL, input: { keep: false }, output: 'ok' },
                            ],
                        },
                    },
                ],
            ),
        );
        expect(v.toolCalls).toEqual([
            { name: 'readFile', args: { path: 'a.ts' }, result: '...' },
        ]);
    });
});

describe('buildVerifierAgentSpec', () => {
    const emptyTools = { get: () => undefined, list: () => [] };

    it('appends the verdict tool and wires resultToolName for capture', () => {
        const spec = buildVerifierAgentSpec({
            systemPrompt: 'judge this',
            modelId: 'resolved',
            tools: emptyTools,
        });
        expect(spec.resultToolName).toBe(VERIFY_DONE_TOOL);
        expect(spec.tools.list().some((t) => t.name === VERIFY_DONE_TOOL)).toBe(true);
        expect(spec.systemPrompt).toBe('judge this');
        expect(spec.maxSteps).toBe(6);
    });

    it('preserves caller tools alongside the verdict tool', () => {
        const tools = {
            get: () => undefined,
            list: () => [{ name: 'grep', description: '', inputSchema: {}, execute: async () => ({ output: '' }) }],
        } as any;
        const spec = buildVerifierAgentSpec({ systemPrompt: 's', modelId: 'm', tools });
        const names = spec.tools.list().map((t) => t.name).sort();
        expect(names).toEqual(['grep', VERIFY_DONE_TOOL].sort());
    });
});

// Issue #1937: the model answers in TEXT instead of calling submitVerdict — the
// dominant shape for Anthropic / OpenAI-compatible providers, where strict tool
// use is off. Before the text path, every refutation written that way was
// discarded and the candidate kept.
describe('extractVerdict — verdict written as text (#1937)', () => {
    const textState = (...texts: string[]) =>
        stateWith(
            [],
            texts.map((content, index) => ({
                index,
                message: { role: 'assistant', content, toolCalls: [] },
            })),
        );

    it('recovers keep:false from the final step text', () => {
        const v = extractVerdict(
            textState(
                'The diff does satisfy the requirement.\n' +
                    '{"keep": false, "rationale": "requirement met", "confidence": "high"}',
            ),
        );
        expect(v.keep).toBe(false);
        expect(v.rationale).toBe('requirement met');
        expect(v.confidence).toBe('high');
        expect(v.parseMode).toBe('text');
    });

    it('takes the verdict after a quoted code block, not the block', () => {
        const v = extractVerdict(
            textState(
                '```ts\nconst o = { keep: true };\n```\n' +
                    '```json\n{"keep": false, "rationale": "refuted"}\n```',
            ),
        );
        expect(v.keep).toBe(false);
        expect(v.rationale).toBe('refuted');
    });

    it('reads only the final step', () => {
        const v = extractVerdict(
            textState('{"keep": false, "rationale": "draft"}', 'still looking…'),
        );
        expect(v.keep).toBe(true);
        expect(v.parseMode).toBe('default-keep');
    });

    it('prefers the artifact over the text', () => {
        const v = extractVerdict(
            stateWith(
                [
                    {
                        type: VERIFY_DONE_TOOL,
                        payload: { keep: true, rationale: 'tool' },
                    } as any,
                ],
                [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '{"keep": false, "rationale": "text"}',
                            toolCalls: [],
                        },
                    },
                ],
            ),
        );
        expect(v.keep).toBe(true);
        expect(v.parseMode).toBe('tool');
    });

    it('labels the fail-open default', () => {
        expect(extractVerdict(stateWith([])).parseMode).toBe('default-keep');
    });
});

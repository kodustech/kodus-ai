/**
 * Second pass for convention findings — eval-style, mocked model, zero LLM.
 *
 * Fixture (invented domain): a greenhouse-irrigation service whose team guide
 * says valve handlers log the zone id and never return a bare boolean. The
 * finder reports the SAME findings on both runs:
 *   - two convention findings quoting the guide verbatim,
 *   - one convention finding whose quote the guide does not contain,
 *   - one convention finding backed by an ast-grep match in this run,
 *   - one convention finding citing an ast-grep rule the run never matched,
 *   - one bug finding.
 * The judge behaves like a model under each prompt: under HV2 it refutes the
 * convention findings as "pure code style"; under the convention prompt it
 * keeps a finding whose quoted rule the code breaks.
 *
 * Proves: HV2 alone drops the real convention findings; the convention path
 * keeps them; a quote that is not in the guide is never kept on either path.
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { MockLanguageModelV3 } from 'ai/test';
import { resolveModelConfig } from '@libs/llm/model-invocation';

import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import {
    AstGrepOutputLog,
    recordAstGrepOutputs,
} from '@libs/code-review/infrastructure/agents/core/convention-check';
import {
    buildFinderAgentSpec,
    runFinderWithVerify,
    type FinderSuggestion,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';

const GUIDE = 'docs/guides/valve-api.md';
const GUIDE_TEXT = `# Valve API guide

## Handlers

Every valve handler **must** log the zone id
before it opens a valve.

Handlers return \`ValveResult\`, never a bare boolean.

## Tests

Test helpers may skip logging.
`;

const LOGGING = {
    relevantFile: 'src/valves/open-valve.handler.ts',
    suggestionContent:
        'CONV-LOG: the handler opens the valve without logging the zone id.',
    existingCode: 'await valve.open(zone);',
    improvedCode: 'logger.info({ zoneId: zone.id }); await valve.open(zone);',
    oneSentenceSummary: 'Log the zone id before opening the valve',
    kind: 'convention',
    source: {
        file: GUIDE,
        section: 'Handlers',
        quote: 'Every valve handler must log the zone id before it opens a valve.',
    },
};
const RESULT_TYPE = {
    relevantFile: 'src/valves/drain-valve.handler.ts',
    suggestionContent:
        'CONV-RESULT: the handler returns a bare boolean instead of ValveResult.',
    existingCode: 'return true;',
    improvedCode: "return { status: 'drained' } as ValveResult;",
    oneSentenceSummary: 'Return ValveResult instead of a boolean',
    kind: 'convention',
    source: {
        file: GUIDE,
        section: 'Handlers',
        quote: 'Handlers return ValveResult, never a bare boolean.',
    },
};
const INVENTED = {
    relevantFile: 'src/valves/open-valve.handler.ts',
    suggestionContent:
        'CONV-METRIC: the handler does not emit an opening metric.',
    existingCode: 'await valve.open(zone);',
    improvedCode: "metrics.inc('valve.open'); await valve.open(zone);",
    oneSentenceSummary: 'Emit a metric when a valve opens',
    kind: 'convention',
    source: {
        file: GUIDE,
        section: 'Handlers',
        quote: 'Every valve opening must emit a metric.',
    },
};
const AST_PROVEN = {
    relevantFile: 'src/valves/close-valve.handler.ts',
    suggestionContent: 'CONV-AST: the handler returns a bare boolean.',
    existingCode: 'return false;',
    improvedCode: "return { status: 'closed' } as ValveResult;",
    oneSentenceSummary: 'Return ValveResult instead of a boolean',
    kind: 'convention',
    source: { file: 'ast-grep:no-bare-boolean', quote: 'no bare boolean' },
};
const AST_UNPROVEN = {
    relevantFile: 'src/valves/schedule.handler.ts',
    suggestionContent: 'CONV-AST-FAKE: the handler returns a bare boolean.',
    existingCode: 'return true;',
    improvedCode: "return { status: 'scheduled' } as ValveResult;",
    oneSentenceSummary: 'Return ValveResult instead of a boolean',
    kind: 'convention',
    source: { file: 'ast-grep:no-bare-boolean', quote: 'no bare boolean' },
};
const BUG = {
    relevantFile: 'src/valves/open-valve.handler.ts',
    suggestionContent:
        'BUG: zone can be undefined when the schedule is empty, so zone.id throws.',
    existingCode: 'await valve.open(zone);',
    improvedCode: 'if (!zone) return; await valve.open(zone);',
    oneSentenceSummary: 'Guard against an undefined zone',
    kind: 'bug',
};

const FINDINGS = {
    reasoning: 'six candidates',
    suggestions: [
        LOGGING,
        RESULT_TYPE,
        INVENTED,
        AST_PROVEN,
        AST_UNPROVEN,
        BUG,
    ],
};

/** Prompts the convention judge received (to check it saw the guide). */
let conventionPrompts: string[] = [];
/** Finder steps so far — module level: a fresh mock model is built per call. */
let finderStep = 0;

/** One model drives the finder and both judges on the same runner.
 *  - finder: astGrep(...) then submitResult(FINDINGS)
 *  - HV2 judge: refutes every CONV-* claim as pure code style, keeps BUG
 *  - convention judge: keeps (the code breaks the quoted rule) */
function model() {
    const doGenerate = (async (opts: any) => {
        const all = JSON.stringify(opts?.prompt ?? opts ?? '');
        let tc: any;
        if (all.includes('TEAM CONVENTIONS')) {
            conventionPrompts.push(all);
            tc = {
                id: 'cv',
                name: 'submitVerdict',
                input: { keep: true, rationale: 'code breaks the quoted rule' },
            };
        } else if (all.includes('surgical code review verifier')) {
            const style = all.includes('CONV-');
            tc = {
                id: 'hv',
                name: 'submitVerdict',
                input: style
                    ? {
                          keep: false,
                          rationale: 'pure code style, not a behavior bug',
                      }
                    : { keep: true, rationale: 'confirmed' },
            };
        } else if (finderStep++ === 0) {
            tc = {
                id: 'ag',
                name: 'astGrep',
                input: { rule: 'no-bare-boolean' },
            };
        } else {
            tc = { id: 'f', name: 'submitResult', input: FINDINGS };
        }
        return {
            content: [
                {
                    type: 'tool-call',
                    toolCallId: tc.id,
                    toolName: tc.name,
                    input: JSON.stringify(tc.input),
                },
            ],
            finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
            usage: { inputTokens: 5, outputTokens: 5 },
            warnings: [],
        };
    }) as any;
    return new MockLanguageModelV3({ doGenerate });
}

const mockResolve = resolveModelConfig as jest.Mock;
beforeEach(() => {
    conventionPrompts = [];
    finderStep = 0;
    mockResolve.mockReset();
    mockResolve.mockImplementation(() => ({
        model: model(),
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    }));
});

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
const ctx: ToolContext = { runId: 'convention-second-pass' };

/** ast-grep stand-in: matches the rule in close-valve only. readFile lets the
 *  evidence gate see the finder investigated the files. */
function tools() {
    return new InMemoryToolRegistry([
        {
            name: 'astGrep',
            description: 'structural search',
            inputSchema: {
                type: 'object',
                properties: { rule: { type: 'string' } },
            },
            execute: async () => ({
                output: 'no-bare-boolean src/valves/close-valve.handler.ts:14:  return false;',
            }),
        },
    ]);
}

async function run(withConventionPath: boolean) {
    const astGrepLog = new AstGrepOutputLog();
    const registry = withConventionPath
        ? recordAstGrepOutputs(tools(), astGrepLog)
        : tools();
    const finderSpec = buildFinderAgentSpec({
        systemPrompt: 'review valves against the team guides',
        modelId: 'mock',
        tools: registry,
        coverageLedger: ledger,
        acceptsConventions: withConventionPath,
    });
    finderStep = 0;
    const readGuide = jest.fn(async (file: string) =>
        file === GUIDE ? GUIDE_TEXT : null,
    );
    const r = await runFinderWithVerify(
        {
            runner: new AiSdkAgentRunner(undefined),
            finderSpec,
            modelId: 'mock',
            tools: registry,
            skipHeavyPasses: true,
            ...(withConventionPath && {
                conventionCheck: { readGuide, guideFiles: [GUIDE], astGrepLog },
            }),
        },
        { prompt: 'review' },
        ctx,
    );
    return { r, readGuide };
}

const tagOf = (f: FinderSuggestion) => f.suggestionContent.split(':')[0];

describe('convention findings: HV2 path vs convention path (same findings)', () => {
    it('HV2 alone drops every convention finding as style and keeps the bug', async () => {
        const { r } = await run(false);
        expect(r.kept.map(tagOf)).toEqual(['BUG']);
        expect(r.droppedByVerify.map((d) => tagOf(d.finding)).sort()).toEqual(
            [
                'CONV-AST',
                'CONV-AST-FAKE',
                'CONV-LOG',
                'CONV-METRIC',
                'CONV-RESULT',
            ].sort(),
        );
        expect(r.droppedByQuoteCheck).toEqual([]);
    });

    it('the convention path keeps the real convention findings in finder order', async () => {
        const { r, readGuide } = await run(true);
        expect(r.kept.map(tagOf)).toEqual([
            'CONV-LOG',
            'CONV-RESULT',
            'CONV-AST',
            'BUG',
        ]);
        expect(r.droppedByVerify).toEqual([]);
        expect(r.unverified).toEqual([]);
        // The guide is read once, from the injected target-branch reader.
        expect(readGuide).toHaveBeenCalledTimes(1);
        expect(readGuide).toHaveBeenCalledWith(GUIDE);
        // kind/source survive to the output.
        expect(r.kept[0].kind).toBe('convention');
        expect(r.kept[0].source?.quote).toBe(LOGGING.source.quote);
    });

    it('never keeps an invented quote or an unproven ast-grep citation', async () => {
        for (const withConventionPath of [false, true]) {
            const { r } = await run(withConventionPath);
            const kept = r.kept.map(tagOf);
            expect(kept).not.toContain('CONV-METRIC');
            expect(kept).not.toContain('CONV-AST-FAKE');
        }
        const { r } = await run(true);
        expect(r.droppedByQuoteCheck.map((q) => tagOf(q.finding))).toEqual([
            'CONV-METRIC',
            'CONV-AST-FAKE',
        ]);
        expect(
            r.droppedByQuoteCheck.every((q) => q.reason === 'quote-not-found'),
        ).toBe(true);
    });

    it('the convention judge sees the quoted rule and its guide section; the ast-grep match skips the judge', async () => {
        const { r } = await run(true);
        // Two quoted findings judged; the ast-grep-proven one is not.
        const judged = new Set(
            conventionPrompts.map((p) => /Claim: (CONV-[A-Z-]+):/.exec(p)?.[1]),
        );
        expect([...judged].sort()).toEqual(['CONV-LOG', 'CONV-RESULT']);
        const logPrompt = conventionPrompts.find((p) =>
            p.includes('CONV-LOG'),
        )!;
        expect(logPrompt).toContain('Quoted rule');
        expect(logPrompt).toContain('## Handlers');
        expect(logPrompt).not.toContain('Test helpers may skip logging');
        const astIdx = r.kept.findIndex((f) => tagOf(f) === 'CONV-AST');
        expect(r.keptParseMode[astIdx]).toBe('proof');
    });
});

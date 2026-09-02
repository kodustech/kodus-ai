/**
 * CONTRACT tests for the LLM.run boundary of BaseCodeReviewAgentProvider.
 *
 * The provider does not call `LLM.run` directly — it assembles the request
 * (`loopParams` built field-by-field + `byokConfig` threaded through
 * `loopSecrets`), delegates to the harness engine `runAgentLoopViaCore`
 * (THE LLM.run boundary here — declared output schema D = `AgentLoopOutput`
 * with `findings.suggestions`), then parses the envelope through the pure
 * `mapAgentFindings` and fails safe through `providerErrorFromResult` + a
 * try/catch. The guaranteed return shape is `ReviewAgentOutput`.
 *
 * SCOPE = the DETERMINISTIC layer only: request assembly (exact args /
 * byokConfig threading), envelope parsing (`mapAgentFindings`), fail-safe
 * (harness throw / error-result / abort → classify + re-throw, never a silent
 * empty review), and the always-returned declared shape. We DO NOT test the
 * model's decision quality.
 *
 * These close the LLM I/O contract matrix (42 rows) for THIS boundary. The
 * raw text→JSON envelope rows (wrapper keys, stringified/markdown/prose,
 * provider-envelope leak, truncated/malformed JSON, boolean-verdict encodings,
 * duplicate JSON keys) are owned by the harness parse layer / structured-output
 * gate — a DIFFERENT boundary already contract-backfilled for #1786 in
 * `libs/llm/structured-output-gate.spec.ts` and `verifier.agent.contract.spec.ts`.
 * They are recorded as NA with that reason; this boundary consumes the fixed
 * `AgentLoopOutput` envelope and maps its `suggestions` array.
 */

// ── Mock the collaborators around the boundary (same specifiers the SUT uses) ──
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/model-factory',
    () => ({ resolveReviewAgentModel: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter',
    () => ({ runAgentLoopViaCore: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/review-observability',
    () => ({ runAgentWithTrace: jest.fn() }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/batch-runner',
    () => ({ runChunkedReview: jest.fn() }),
);

import { BaseCodeReviewAgentProvider } from './base-code-review-agent.provider';
import {
    mapAgentFindings,
    resolveSuggestionLabel,
} from '@libs/code-review/infrastructure/agents/collaborators/finding-mapper';
import { resolveReviewAgentModel } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';
import { runAgentLoopViaCore } from '@libs/code-review/infrastructure/agents/core/core-agent-loop.adapter';
import { runAgentWithTrace } from '@libs/code-review/infrastructure/agents/collaborators/review-observability';
import { runChunkedReview } from '@libs/code-review/infrastructure/agents/collaborators/batch-runner';
import { getClassification } from '@libs/llm/error-classifier';
import type {
    ReviewAgentInput,
    AgentProgressEvent,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

const resolveModelMock = resolveReviewAgentModel as jest.Mock;
const runLoopMock = runAgentLoopViaCore as jest.Mock;
const runTraceMock = runAgentWithTrace as jest.Mock;
const runChunkedMock = runChunkedReview as jest.Mock;

// ── Concrete subclass under test (abstract base) ─────────────────────────────
class TestReviewAgent extends BaseCodeReviewAgentProvider {
    protected getIdentity() {
        return {
            name: 'kodus-bug-review-agent',
            description: 'finds bugs',
            goal: 'find bugs',
            expertise: ['bugs'],
        };
    }
    protected getCategoryPrompt(): string {
        return 'Find bugs in the diff.';
    }
    protected getCategoryLabel(): string {
        return 'bug';
    }
}

// A generalist-style subclass that emits per-finding labels (supportsMixed).
class MixedReviewAgent extends BaseCodeReviewAgentProvider {
    protected getIdentity() {
        return {
            name: 'kodus-generalist',
            description: 'g',
            goal: 'g',
            expertise: ['x'],
        };
    }
    protected getCategoryPrompt(): string {
        return 'Review.';
    }
    protected getCategoryLabel(): string {
        return 'generalist';
    }
    protected supportsMixedLabels(): boolean {
        return true;
    }
    protected getAllowedSuggestionLabels() {
        return ['bug', 'security', 'performance'] as Array<
            'bug' | 'security' | 'performance'
        >;
    }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
const CHANGED_FILE = {
    filename: 'src/a.ts',
    patch: '@@ -1,2 +1,3 @@\n+const x = 1;',
    patchWithLinesStr: '@@ -1,2 +1,3 @@\n+const x = 1;',
} as any;

function makeInput(overrides: Partial<ReviewAgentInput> = {}): ReviewAgentInput {
    return {
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        changedFiles: [CHANGED_FILE],
        prNumber: 42,
        repositoryId: 'repo-1',
        repositoryFullName: 'acme/repo',
        prTitle: 'Add feature',
        prBody: 'body',
        baseBranch: 'main',
        languageResultPrompt: 'en-US',
        remoteCommands: undefined,
        ...overrides,
    } as ReviewAgentInput;
}

function makeModel(overrides: any = {}) {
    return {
        byokConfig: { provider: 'openai', model: 'gpt-4o' },
        main: {
            role: 'main',
            modelName: 'openai:gpt-4o',
            maxInputTokens: 1_000_000,
            reasoningEffort: undefined,
            byokProvider: 'openai',
            ...overrides.main,
        },
        ...(overrides.byokConfig !== undefined && {
            byokConfig: overrides.byokConfig,
        }),
    };
}

function makeHarnessResult(overrides: any = {}): any {
    return {
        findings: {
            reasoning: 'looked at it',
            suggestions: [
                {
                    suggestionContent: 'Null deref on x',
                    relevantFile: 'src/a.ts',
                    oneSentenceSummary: 'null deref',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 2,
                    severity: 'high',
                    existingCode: 'const x',
                    improvedCode: 'const x = 1',
                    language: 'typescript',
                },
            ],
        },
        text: 'looked at it',
        steps: 5,
        toolCalls: [{ tool: 'readFile', toolName: 'readFile', args: { path: 'src/a.ts' } }],
        finishReason: 'stop',
        source: 'json-parse',
        usage: {
            inputTokens: 1000,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
            outputTokens: 200,
            reasoningTokens: 50,
            totalTokens: 1200,
        },
        discardedBySeverity: [],
        droppedByVerify: [],
        coverage: { covered: 1, total: 1 },
        verification: null,
        anomalies: {
            stepsLe2: false,
            zeroToolCalls: false,
            zeroStrongEvidenceFiles: false,
            zeroCoverage: false,
            lowCoverage: false,
            lowStrongEvidenceFiles: false,
        },
        warnings: [],
        ...overrides,
    };
}

function mapperCtx(overrides: any = {}) {
    return {
        changedFiles: [{ filename: 'src/a.ts' }] as any,
        kodyRules: [],
        prNumber: 1,
        isKodyRules: false,
        identityName: 'test',
        labelPolicy: {
            categoryLabel: 'bug',
            allowedLabels: ['bug'] as Array<'bug' | 'security' | 'performance'>,
            supportsMixed: false,
        },
        logger: { warn: jest.fn() },
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    resolveModelMock.mockResolvedValue(makeModel());
    runLoopMock.mockResolvedValue(makeHarnessResult());
    // runAgentWithTrace is a transparent passthrough here (Langfuse tracing is
    // exercised separately); it must invoke the real fn so the loop mock runs.
    runTraceMock.mockImplementation(
        (_meta: any, _spanInput: any, fn: () => any) => fn(),
    );
    runChunkedMock.mockResolvedValue({
        suggestions: [],
        agentName: 'kodus-bug-review-agent',
        agentCategory: 'bug',
        turnsUsed: 0,
        durationMs: 1,
    });
});

function newAgent(byokErrorCounter?: any, docSearch?: any) {
    return new TestReviewAgent(
        {} as any,
        {} as any,
        docSearch,
        byokErrorCounter,
    );
}

// ════════════════════════════════════════════════════════════════════════════
// A. Output-shape zoo — how the boundary consumes the AgentLoopOutput envelope
//    and its findings.suggestions payload.
// ════════════════════════════════════════════════════════════════════════════
describe('A. output-shape zoo', () => {
    // Row 1 — exact D, happy path. Side effect (mapping) must be exact.
    it('row 1: exact D → maps the suggestion faithfully and returns declared shape', async () => {
        const out = await newAgent().execute(makeInput());
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0]).toMatchObject({
            relevantFile: 'src/a.ts',
            suggestionContent: 'Null deref on x',
            label: 'bug',
            severity: 'high',
            relevantLinesStart: 1,
            relevantLinesEnd: 2,
        });
        // Guaranteed return shape.
        expect(out).toMatchObject({
            agentName: 'kodus-bug-review-agent',
            agentCategory: 'bug',
            finishReason: 'stop',
            hitHardLimit: false,
        });
        expect(typeof out.turnsUsed).toBe('number');
        expect(typeof out.durationMs).toBe('number');
        expect(Array.isArray(out.warnings)).toBe(true);
    });

    it('row 1 (mapper): exact findings.suggestions payload → exact CodeSuggestion', () => {
        const mapped = mapAgentFindings(
            makeHarnessResult() as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toHaveLength(1);
        expect(mapped.suggestions[0].suggestionContent).toBe('Null deref on x');
    });

    // Row 2 — bare array where an object is expected. The harness result is an
    // array; the boundary must SIGNAL (throw), never ship a silent empty review.
    it('row 2: harness returns a bare array → execute fails explicitly (no silent empty)', async () => {
        runLoopMock.mockResolvedValue([{ suggestionContent: 'x' }] as any);
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });

    it('row 2 (mapper): findings supplied as a bare array → typed-empty (envelope is harness-guaranteed)', () => {
        const mapped = mapAgentFindings(
            { findings: [{ suggestionContent: 'x' }] } as any,
            mapperCtx() as any,
        );
        // Non-conforming top-level envelope collapses to the typed-empty
        // default — observable via suggestions.length, not a wrong answer.
        expect(mapped.suggestions).toEqual([]);
    });

    // Row 3 — single object where an array is expected.
    it('row 3: findings.suggestions is a single object → mapper signals (throws), never silent-keeps', () => {
        expect(() =>
            mapAgentFindings(
                { findings: { suggestions: { suggestionContent: 'x' } } } as any,
                mapperCtx() as any,
            ),
        ).toThrow();
    });

    it('row 3 (execute): single-object suggestions → execute fails explicitly', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: { suggestionContent: 'x' } },
            }),
        );
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });

    // Rows 4,5,6 — wrapper keys / double wrapper / opaque single-key wrap: the
    // raw text→object envelope is produced INSIDE the harness (structured-output
    // gate); this boundary receives the fixed {findings:{suggestions}} shape.
    // NA — see file header.

    // Rows 7,8,9 — stringified / markdown-fenced / prose-wrapped JSON: harness
    // text-parse layer (recoverFindingsFromProse lives inside the adapter). NA.

    // Row 10 — right data, wrong keys (renamed). Key-shaping is the finder
    // schema's job upstream; a finding that reaches here with no suggestionContent
    // is unpostable and is dropped.
    it('row 10: finding with renamed keys (no suggestionContent) → dropped, not shipped', () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        { file: 'src/a.ts', content: 'bug here' } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toEqual([]);
    });

    // Row 11 — case/convention mismatch on the label (mixed reviewer).
    it('row 11: label case is normalized (BUG → bug) under a mixed policy', () => {
        expect(
            resolveSuggestionLabel(
                { label: 'BUG' },
                {
                    categoryLabel: 'generalist',
                    allowedLabels: ['bug', 'security'],
                    supportsMixed: true,
                },
            ),
        ).toBe('bug');
    });

    // Row 12 — partial object: only required-ish keys present → defaults filled.
    it('row 12: partial finding → mapper fills documented defaults', () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'x',
                            relevantFile: 'src/a.ts',
                        } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions[0]).toMatchObject({
            language: '',
            existingCode: '',
            improvedCode: '',
            oneSentenceSummary: '',
            severity: 'medium',
            label: 'bug',
        });
    });

    // Row 13 — extra unknown keys tolerated (not crash, not leaked verbatim).
    it('row 13: extra unknown keys tolerated', () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'x',
                            relevantFile: 'src/a.ts',
                            bogusKey: 'ignore me',
                            another: { nested: true },
                        } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toHaveLength(1);
        expect((mapped.suggestions[0] as any).bogusKey).toBeUndefined();
    });

    // Row 14 — empty object.
    it('row 14: empty finding object → dropped; empty harness object → execute fails explicitly', async () => {
        const mapped = mapAgentFindings(
            { findings: { suggestions: [{} as any] } } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toEqual([]);

        runLoopMock.mockResolvedValue({} as any);
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });

    // Row 15 — empty array → legitimate empty review (typed-empty).
    it('row 15: empty suggestions array → typed-empty, still declared shape', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: [] },
                source: 'empty',
            }),
        );
        const out = await newAgent().execute(makeInput());
        expect(out.suggestions).toEqual([]);
        expect(out.agentName).toBe('kodus-bug-review-agent');
    });

    // Row 16 — empty / whitespace string content.
    it('row 16: empty suggestionContent dropped; whitespace-only content is preserved (no false drop)', () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        { suggestionContent: '', relevantFile: 'src/a.ts' } as any,
                        {
                            suggestionContent: '   ',
                            relevantFile: 'src/a.ts',
                        } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toHaveLength(1);
        expect(mapped.suggestions[0].suggestionContent).toBe('   ');
    });

    // Row 17 — null / undefined return from the boundary.
    it('row 17: null/undefined harness result → execute fails explicitly (never silent success)', async () => {
        runLoopMock.mockResolvedValue(null as any);
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();

        runLoopMock.mockResolvedValue(undefined as any);
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });

    // Row 18 — primitive where object expected.
    it('row 18: primitive harness result → execute fails explicitly', async () => {
        runLoopMock.mockResolvedValue('ok' as any);
        await expect(newAgent().execute(makeInput())).rejects.toBeDefined();
    });

    // Rows 19,20 — provider envelope leak / reasoning-thinking leak: these live
    // in the AI-SDK/harness layer and never reach this boundary. NA.
});

// ════════════════════════════════════════════════════════════════════════════
// B. Semantic-but-wrong (valid JSON, wrong value encoding) at the finding level.
// ════════════════════════════════════════════════════════════════════════════
describe('B. semantic-but-wrong finding fields', () => {
    // Rows 21,22,23 — boolean encodings: no boolean field exists in a review
    // finding; the boolean keep-verdict is the VERIFIER boundary
    // (verifier.agent.contract.spec.ts). NA.

    // Row 24 — enum/severity out of the allowed set → the model's severity is
    // faithfully passed through (only kody-rule severity is overridden). This is
    // faithful passthrough, not a wrong default, so it is asserted with `it`.
    it('row 24: out-of-set severity is passed through verbatim (documented passthrough)', () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'x',
                            relevantFile: 'src/a.ts',
                            severity: 'URGENT',
                        } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions[0].severity).toBe('URGENT');
    });

    // Row 25 — dangling reference: relevantFile not in the PR → dropped WITH a
    // warn (explicit signal), never silently kept against a wrong file.
    it('row 25: relevantFile not in changedFiles → dropped and a @@PATH_MISMATCH@@ warn is logged', () => {
        const warn = jest.fn();
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'x',
                            relevantFile: 'src/GHOST.ts',
                        } as any,
                    ],
                },
            } as any,
            mapperCtx({ logger: { warn } }) as any,
        );
        expect(mapped.suggestions).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('@@PATH_MISMATCH@@'),
            }),
        );
    });

    // Row 26 — duplicate JSON keys (first/last wins): a raw text-parse concern
    // owned by the harness/gate. NA.

    // Row 27 — unicode / escaped newlines / emoji preserved in string fields.
    it('row 27: unicode / emoji / newlines preserved in suggestionContent', () => {
        const content = 'Bug: café ☕\nline2 — 日本語  end';
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        {
                            suggestionContent: content,
                            relevantFile: 'src/a.ts',
                        } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions[0].suggestionContent).toBe(content);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// C. Unparseable / transport — the fail-safe layer. Never throw a bare crash
//    past classification; never mask a provider failure as a clean empty review.
// ════════════════════════════════════════════════════════════════════════════
describe('C. transport / fail-safe', () => {
    // Rows 28,29 — truncated / malformed JSON: raw text-parse, owned by the
    // harness (recoverFindingsFromProse / structured-output gate). NA.

    // Row 30 — LLM.run (the harness) throws → classify + emit progress error +
    // re-throw. It must NOT be swallowed into a clean empty review.
    it('row 30: harness throws → execute re-throws with a classification attached and emits an error progress event', async () => {
        const events: AgentProgressEvent[] = [];
        runLoopMock.mockRejectedValue(new Error('ECONNRESET socket hang up'));
        await expect(
            newAgent().execute(
                makeInput({ onAgentProgress: (e) => events.push(e) }),
            ),
        ).rejects.toThrow('ECONNRESET socket hang up');

        const errEvent = events.find((e) => e.status === 'error');
        expect(errEvent).toBeDefined();
        expect(errEvent?.errorFriendlyMessage).toBeTruthy();
    });

    it('row 30: the thrown error carries a classification (getClassification is truthy)', async () => {
        runLoopMock.mockRejectedValue(new Error('network down'));
        let thrown: unknown;
        try {
            await newAgent().execute(makeInput());
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(getClassification(thrown)).toBeDefined();
    });

    // Row 31 — error object returned instead of a throw: the harness swallows a
    // provider throw into finishReason:'error'. providerErrorFromResult must
    // reconstruct a throwable so the run fails LOUDLY (with status/body threaded
    // for classification — #1568).
    it('row 31: finishReason "error" result → reconstructed throw carries message + statusCode + responseBody', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                finishReason: 'error',
                errorMessage: 'model not found',
                errorName: 'NotFoundError',
                errorStatus: 404,
                errorResponseBody: '{"error":"unknown model"}',
            }),
        );
        let thrown: any;
        try {
            await newAgent().execute(makeInput());
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(thrown.message).toBe('model not found');
        expect(thrown.statusCode).toBe(404);
        expect(thrown.responseBody).toBe('{"error":"unknown model"}');
    });

    // Row 32 — empty success (content:'' / finish stop) is a legitimate empty
    // review; a max-steps/tool-calls stop is a cut-short and must be flagged.
    it('row 32: empty-success stop → typed-empty, hitHardLimit false, finishReason stop', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: [] },
                source: 'empty',
                finishReason: 'stop',
            }),
        );
        const out = await newAgent().execute(makeInput());
        expect(out.suggestions).toEqual([]);
        expect(out.hitHardLimit).toBe(false);
        expect(out.finishReason).toBe('stop');
    });

    it('row 32: empty + tool-calls finish → cut-short flagged (hitHardLimit true, finishReason max-steps)', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: [] },
                source: 'empty',
                finishReason: 'tool-calls',
            }),
        );
        const out = await newAgent().execute(makeInput());
        expect(out.hitHardLimit).toBe(true);
        expect(out.finishReason).toBe('max-steps');
    });

    it('row 32: timeout finish → finishReason timeout, hitHardLimit true', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { suggestions: [] },
                source: 'empty',
                finishReason: 'timeout',
            }),
        );
        const out = await newAgent().execute(makeInput());
        expect(out.finishReason).toBe('timeout');
        expect(out.hitHardLimit).toBe(true);
    });

    // Row 33 — refusal ("I cannot help…" / content_filter): surfaces at this
    // boundary as an empty-success stop (no findings). It must NOT invent
    // suggestions and must not be flagged as a hard-limit crash.
    it('row 33: refusal → empty review, no fabricated suggestions, finishReason stop', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: { reasoning: 'I cannot help with that.', suggestions: [] },
                source: 'empty',
                finishReason: 'stop',
            }),
        );
        const out = await newAgent().execute(makeInput());
        expect(out.suggestions).toEqual([]);
        expect(out.hitHardLimit).toBe(false);
    });

    // Row 34 — abort signal fired mid-call: the parentSignal must be threaded to
    // the loop, and an AbortError must fail the run (not be swallowed as empty).
    it('row 34: parentSignal is threaded into loopParams', async () => {
        const controller = new AbortController();
        await newAgent().execute(
            makeInput({ parentSignal: controller.signal }),
        );
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(loopParams.parentSignal).toBe(controller.signal);
    });

    it('row 34: an AbortError from the harness fails the run (not a silent empty)', async () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        runLoopMock.mockRejectedValue(abortErr);
        await expect(newAgent().execute(makeInput())).rejects.toThrow(
            'The operation was aborted',
        );
    });
});

// ════════════════════════════════════════════════════════════════════════════
// D. Input variants — feed the boundary with a happy harness mock and assert
//    the invariant holds.
// ════════════════════════════════════════════════════════════════════════════
describe('D. input variants', () => {
    // Row 35 — empty input (0 changed files).
    it('row 35: empty changedFiles → runs a single batch and returns declared shape', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({ findings: { suggestions: [] } }),
        );
        const out = await newAgent().execute(
            makeInput({ changedFiles: [] }),
        );
        expect(runLoopMock).toHaveBeenCalledTimes(1);
        expect(runChunkedMock).not.toHaveBeenCalled();
        expect(out.suggestions).toEqual([]);
    });

    // Row 36 — single item (the baseline happy path already covers this).
    it('row 36: single changed file → single batch, one loop call', async () => {
        await newAgent().execute(makeInput());
        expect(runLoopMock).toHaveBeenCalledTimes(1);
        expect(runChunkedMock).not.toHaveBeenCalled();
    });

    // Row 37 — large input crossing the batch/token chunk boundary → delegate to
    // runChunkedReview (must not be run as one over-budget batch).
    it('row 37: large PR over budget that genuinely splits → delegates to runChunkedReview', async () => {
        resolveModelMock.mockResolvedValue(
            makeModel({ main: { maxInputTokens: 50_000 } }),
        );
        const bigFiles = Array.from({ length: 6 }, (_, i) => ({
            filename: `src/f${i}.ts`,
            patch: 'x'.repeat(12_000),
            patchWithLinesStr: 'x'.repeat(12_000),
        })) as any;
        await newAgent().execute(
            makeInput({ changedFiles: bigFiles, reviewMode: 'deep' }),
        );
        expect(runChunkedMock).toHaveBeenCalledTimes(1);
    });

    // Row 38 — duplicate items in input: this boundary does NOT dedup (a later
    // stage owns dedup); both must survive, not be silently collapsed.
    it('row 38: duplicate findings from the harness are both preserved (dedup is a later stage)', () => {
        const dup = {
            suggestionContent: 'same bug',
            relevantFile: 'src/a.ts',
        } as any;
        const mapped = mapAgentFindings(
            { findings: { suggestions: [dup, { ...dup }] } } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toHaveLength(2);
    });

    // Row 39 — input item with a null/undefined required field.
    it('row 39: finding with null relevantFile (non-kody) → dropped, no crash', () => {
        const mapped = mapAgentFindings(
            {
                findings: {
                    suggestions: [
                        { suggestionContent: 'x', relevantFile: null } as any,
                    ],
                },
            } as any,
            mapperCtx() as any,
        );
        expect(mapped.suggestions).toEqual([]);
    });

    it('row 39: changedFile with null filename does not crash the mapper', () => {
        expect(() =>
            mapAgentFindings(
                { findings: { suggestions: [] } } as any,
                mapperCtx({
                    changedFiles: [{ filename: null }, { filename: 'src/a.ts' }],
                }) as any,
            ),
        ).not.toThrow();
    });

    // Row 40 — special chars / whitespace-only diff.
    it('row 40: special-char / whitespace-only diff → runs without crash, returns declared shape', async () => {
        const weird = {
            filename: 'src/weird.ts',
            patch: '@@\n\t     \\n💥 <script>`${x}`',
            patchWithLinesStr: '@@\n\t     \\n💥 <script>`${x}`',
        } as any;
        const out = await newAgent().execute(
            makeInput({ changedFiles: [weird] }),
        );
        expect(Array.isArray(out.suggestions)).toBe(true);
    });

    // Row 41 — off-by-one: prompt overflows the budget (overhead-dominated) but
    // the chunker would pack every file into ONE chunk → must NOT recurse into
    // executeChunked; fall through to a single batch (the recursion-guard fix).
    it('row 41: over-budget but a single all-files chunk → single batch, NOT chunked', async () => {
        resolveModelMock.mockResolvedValue(
            makeModel({ main: { maxInputTokens: 28_000 } }),
        );
        const tinyFiles = Array.from({ length: 4 }, (_, i) => ({
            filename: `src/t${i}.ts`,
            patch: 'y'.repeat(200),
            patchWithLinesStr: 'y'.repeat(200),
        })) as any;
        await newAgent().execute(
            makeInput({ changedFiles: tinyFiles, reviewMode: 'deep' }),
        );
        expect(runChunkedMock).not.toHaveBeenCalled();
        expect(runLoopMock).toHaveBeenCalledTimes(1);
    });

    // Row 42 — order permutation is metamorphic: mapping is order-preserving and
    // set-equivalent under permutation.
    it('row 42: order permutation → equivalent set of mapped suggestions', () => {
        const a = { suggestionContent: 'A', relevantFile: 'src/a.ts' } as any;
        const b = { suggestionContent: 'B', relevantFile: 'src/a.ts' } as any;
        const m1 = mapAgentFindings(
            { findings: { suggestions: [a, b] } } as any,
            mapperCtx() as any,
        );
        const m2 = mapAgentFindings(
            { findings: { suggestions: [b, a] } } as any,
            mapperCtx() as any,
        );
        const contents = (m: any) =>
            m.suggestions.map((s: any) => s.suggestionContent).sort();
        expect(contents(m1)).toEqual(contents(m2));
        expect(contents(m1)).toEqual(['A', 'B']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Request assembly + byokConfig threading — the deterministic wire-out contract.
// ════════════════════════════════════════════════════════════════════════════
describe('request assembly + byokConfig threading', () => {
    it('threads byokConfig from the resolved model into loopSecrets unchanged', async () => {
        const byokConfig = { provider: 'anthropic', model: 'claude-x' };
        resolveModelMock.mockResolvedValue(
            makeModel({ byokConfig, main: { byokProvider: 'anthropic' } }),
        );
        await newAgent().execute(makeInput());
        const [, loopSecrets] = runLoopMock.mock.calls[0];
        expect(loopSecrets.byokConfig).toBe(byokConfig);
        expect(loopSecrets.documentationSearchOptions.byokConfig).toBe(
            byokConfig,
        );
    });

    it('assembles the request with the system + user prompts and category usageRunName', async () => {
        await newAgent().execute(makeInput());
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(typeof loopParams.systemPrompt).toBe('string');
        expect(loopParams.systemPrompt.length).toBeGreaterThan(0);
        expect(typeof loopParams.userPrompt).toBe('string');
        expect(loopParams.userPrompt.length).toBeGreaterThan(0);
        expect(loopParams.usageRunName).toBe('code-review-bug');
        expect(loopParams.agentName).toBe('kodus-bug-review-agent');
    });

    it('forwards model params (modelName, byokProvider, reasoning, contextWindow) onto the wire', async () => {
        resolveModelMock.mockResolvedValue(
            makeModel({
                main: {
                    modelName: 'openai:gpt-4o',
                    byokProvider: 'openai',
                    reasoningEffort: 'high',
                    maxInputTokens: 200_000,
                },
            }),
        );
        await newAgent().execute(makeInput());
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(loopParams.modelName).toBe('openai:gpt-4o');
        expect(loopParams.byokProvider).toBe('openai');
        expect(loopParams.reasoningEffort).toBe('high');
        expect(loopParams.byokRole).toBe('main');
        expect(loopParams.contextWindowTokens).toBe(200_000);
    });

    it('threads the documentation search service into loopSecrets when injected', async () => {
        const docSearch = { search: jest.fn() } as any;
        await newAgent(undefined, docSearch).execute(makeInput());
        const [, loopSecrets] = runLoopMock.mock.calls[0];
        expect(loopSecrets.documentationSearchService).toBe(docSearch);
    });

    it('wires byokErrorReporter → ByokErrorCounter.record when the counter is injected', async () => {
        const counter = { record: jest.fn() };
        await newAgent(counter).execute(makeInput());
        const [, loopSecrets] = runLoopMock.mock.calls[0];
        expect(typeof loopSecrets.byokErrorReporter).toBe('function');
        loopSecrets.byokErrorReporter({
            organizationId: 'org-1',
            provider: 'openai',
            errorMessage: 'boom',
        });
        expect(counter.record).toHaveBeenCalledTimes(1);
    });

    it('omits byokErrorReporter when no counter is injected', async () => {
        await newAgent().execute(makeInput());
        const [, loopSecrets] = runLoopMock.mock.calls[0];
        expect(loopSecrets.byokErrorReporter).toBeUndefined();
    });

    it('forwards heavy-pass / synthesis-rescue / heavy opt-in flags explicitly', async () => {
        await newAgent().execute(
            makeInput({
                skipHeavyPasses: true,
                skipSynthesisRescue: true,
                heavy: true,
                maxSteps: 33,
            }),
        );
        const [loopParams] = runLoopMock.mock.calls[0];
        expect(loopParams.skipHeavyPasses).toBe(true);
        expect(loopParams.skipSynthesisRescue).toBe(true);
        expect(loopParams.heavy).toBe(true);
        expect(loopParams.maxSteps).toBe(33);
    });

    it('AGENT_RECURSION_LIMIT_EXCEEDED at max depth (never loops the worker heap)', async () => {
        await expect(
            newAgent().execute(makeInput({ recursionDepth: 2 })),
        ).rejects.toThrow('AGENT_RECURSION_LIMIT_EXCEEDED');
        expect(runLoopMock).not.toHaveBeenCalled();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// E. Provider / model matrix — the boundary is model-agnostic: it consumes the
//    already-structured AgentLoopOutput regardless of the strict-json_schema vs
//    json_object gate (that gate lives in the harness — structured-output-gate.ts,
//    already #1786-backfilled). Assert request assembly threads the provider and
//    that the fail-safe behaves identically across both gate branches.
// ════════════════════════════════════════════════════════════════════════════
describe('E. N-model policy (boundary is model-agnostic)', () => {
    const STRICT = ['openai', 'anthropic', 'google', 'moonshotai'];
    const FALLBACK = ['kimi', 'glm', 'deepseek', 'z-ai'];

    describe.each([...STRICT, ...FALLBACK])(
        'provider=%s',
        (provider) => {
            it('threads the provider byokConfig onto the wire unchanged', async () => {
                const byokConfig = { provider, model: `${provider}-model` };
                resolveModelMock.mockResolvedValue(
                    makeModel({ byokConfig, main: { byokProvider: provider } }),
                );
                await newAgent().execute(makeInput());
                const [loopParams, loopSecrets] = runLoopMock.mock.calls[0];
                expect(loopSecrets.byokConfig).toBe(byokConfig);
                expect(loopParams.byokProvider).toBe(provider);
            });

            it('an off-schema (single-object) result fails explicitly regardless of provider', async () => {
                resolveModelMock.mockResolvedValue(
                    makeModel({
                        byokConfig: { provider, model: `${provider}-model` },
                        main: { byokProvider: provider },
                    }),
                );
                runLoopMock.mockResolvedValue(
                    makeHarnessResult({
                        findings: { suggestions: { suggestionContent: 'x' } },
                    }),
                );
                await expect(
                    newAgent().execute(makeInput()),
                ).rejects.toBeDefined();
            });
        },
    );
});

// ════════════════════════════════════════════════════════════════════════════
// Mixed-label policy (generalist) — label routing lives at the parse layer too.
// ════════════════════════════════════════════════════════════════════════════
describe('mixed-label reviewer', () => {
    it('honors an allowed per-finding label and returns declared shape', async () => {
        runLoopMock.mockResolvedValue(
            makeHarnessResult({
                findings: {
                    suggestions: [
                        {
                            suggestionContent: 'sql injection',
                            relevantFile: 'src/a.ts',
                            label: 'security',
                            severity: 'critical',
                        },
                    ],
                },
            }),
        );
        const agent = new MixedReviewAgent({} as any, {} as any);
        const out = await agent.execute(makeInput());
        expect(out.suggestions[0].label).toBe('security');
    });
});

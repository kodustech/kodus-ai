/**
 * ClassifyCliSessionCaptureUseCase — migrated-consumer parity spec (Phase 3, plan 03-09).
 *
 * Sibling of the 03-01 tracer (classify-session.use-case.spec.ts). Proves the
 * "no behavior change on the happy path" gate after migrating extractWithLLM off
 * the legacy BYOKPromptRunner LangChain path onto the
 * AI SDK path (runStructuredReviewCall, byokConfig: undefined → managed default).
 * Parity is on the parsed decisions[] mapping: a fixed { decisions: [...] } result,
 * returned through the REAL runStructuredReviewCall (real schema conversion + model
 * resolution + span), maps byte-for-byte to the same CliSessionClassifiedDecision[]
 * the pre-migration mapping produced.
 *
 * NOTE: this mocks `tracedGenerateText` (the same seam structured-review-call.spec.ts
 * uses) rather than driving generateText+Output.object against a MockLanguageModelV4 —
 * that structured-output path hangs against an offline model double. Parity here
 * targets the decisions[] mapping, which is exactly the migration's behavior-change risk.
 */
const MODEL_DECISIONS = {
    decisions: [
        {
            type: 'architectural_decision',
            origin: 'human',
            decision: 'Use event sourcing for the audit log',
            rationale: 'Full auditability of every state change',
            confidence: 0.9,
            evidence: ['src/audit/store.ts', 'src/audit/replay.ts'],
        },
        {
            type: 'tooling',
            decision: 'Adopt pnpm as the package manager',
            confidence: 0.4,
        },
    ],
};

// Model builders return sentinels — no real model/network is touched.
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    buildModelFromSlot: jest.fn(() => ({ __model: 'managed-default' })),
    getModelName: jest.fn(() => 'managed-default'),
}));
jest.mock('@libs/llm/byok-model-wrapper', () => ({
    wrapByokModel: jest.fn((model: any) => model),
}));
jest.mock('@libs/llm/llm-call', () => ({
    tracedGenerateText: jest.fn(),
    timeoutSignal: jest.fn(() => undefined),
    LLM_CALL_TIMEOUT_MS: 600000,
}));
jest.mock('@libs/core/log/langfuse', () => ({
    buildLangfuseTelemetry: jest.fn(() => ({ isEnabled: false })),
    toAiSdkTelemetryArgs: jest.fn(() => ({ telemetry: { isEnabled: false } })),
}));

import {
    ClassifyCliSessionCaptureUseCase,
    LLMDecisionExtractionSchema,
} from './classify-cli-session-capture.use-case';
import { setLlmObservability } from '@libs/llm/llm-observability';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { LLM } from '@libs/llm/llm';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const cliSessionCaptureRepository = {} as any;

function buildUseCase(): ClassifyCliSessionCaptureUseCase {
    return new ClassifyCliSessionCaptureUseCase(
        cliSessionCaptureRepository,
        observabilityService,
    );
}

const capture = {
    organizationId: 'org-123',
    summary: 'Designed the audit log',
    signals: {
        prompt: 'Design the audit log',
        assistantMessage: 'I chose event sourcing.',
        modifiedFiles: ['src/audit/store.ts', 'src/audit/replay.ts'],
        toolUses: [{ tool: 'Edit', filePath: 'src/audit/store.ts' }],
    },
};

describe('ClassifyCliSessionCaptureUseCase.extractWithLLM — migration parity (AI SDK path)', () => {
    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
        // LLM.run records its span through the observability port — register the mock.
        setLlmObservability(observabilityService);
        mockGenerate.mockResolvedValue({ experimental_output: MODEL_DECISIONS });
    });

    it('maps the model decisions[] byte-for-byte to CliSessionClassifiedDecision[]', async () => {
        const useCase = buildUseCase();

        const decisions = await (useCase as any).extractWithLLM(capture);

        expect(decisions).toEqual([
            {
                type: 'architectural_decision',
                origin: 'human',
                decision: 'Use event sourcing for the audit log',
                rationale: 'Full auditability of every state change',
                confidence: 0.9,
                evidence: ['src/audit/store.ts', 'src/audit/replay.ts'],
                // 0.9 >= 0.7 and architectural_decision is auto-promotable.
                autoPromoteCandidate: true,
            },
            {
                type: 'tooling',
                origin: undefined,
                decision: 'Adopt pnpm as the package manager',
                rationale: undefined,
                confidence: 0.4,
                evidence: [],
                // 0.4 < 0.7 → not a candidate.
                autoPromoteCandidate: false,
            },
        ]);
    });

    it('routes through exactly one AI SDK span path (runAiSdkLLMInSpan), no LangChain wrapper', async () => {
        const useCase = buildUseCase();

        await (useCase as any).extractWithLLM(capture);

        expect(observabilityService.runAiSdkLLMInSpan).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    it('empty decisions → empty mapping (no throw)', async () => {
        mockGenerate.mockResolvedValue({
            experimental_output: { decisions: [] },
        });
        const useCase = buildUseCase();

        const decisions = await (useCase as any).extractWithLLM(capture);

        expect(decisions).toEqual([]);
    });
});

/**
 * LLM.run I/O CONTRACT MATRIX — full closure for the capture-classification
 * boundary. See scratchpad/llm-io-contract-matrix.md. The boundary this file
 * uniquely owns is the DETERMINISTIC parse layer in `extractWithLLM`:
 *   - request assembly (schema/system/user/runName/organizationId/byokConfig)
 *   - envelope parsing: `const rawDecisions = result?.decisions ?? []` (L193)
 *   - the per-decision mapping (normalizeConfidence / trim / evidence /
 *     shouldAutoPromote / type|origin passthrough at L198-199)
 *   - the guaranteed return type: ALWAYS CliSessionClassifiedDecision[]
 *   - the pipeline fail-safe in `execute`: try/catch → extractWithHeuristics,
 *     with an OBSERVABLE origin flag ('llm' | 'heuristic' | 'heuristic-fallback').
 *
 * These specs SPY on the real LLM.run boundary (the seam the task names) and
 * feed it the output-shape zoo directly, so the assertions pin what THIS layer
 * does with each shape. The off-schema RECOVERY (fence/prose/wrong-keys →
 * repair/reissue) and the N-model policy branches live in the shared executor
 * (structured-review-call.ts + structured-output-gate.ts): LLM.run's contract
 * is "returns the schema-validated object, or throws". Rows whose recovery is
 * owned there are marked NA-delegated in the matrix bookkeeping below and are
 * covered by that module's own spec — here we assert the boundary correctly
 * TRUSTS a validated result and FAILS SAFE when the contract throws.
 */
describe('ClassifyCliSessionCaptureUseCase — LLM.run I/O contract matrix', () => {
    let runSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.clearAllMocks();
        // Fully replace the boundary: the executor/tracer are bypassed so each
        // test controls exactly what LLM.run returns or throws.
        runSpy = jest.spyOn(LLM as any, 'run');
    });

    afterEach(() => {
        // RESTORE so the migration-parity describe above keeps driving the real
        // runStructuredReviewCall through the tracedGenerateText seam.
        runSpy.mockRestore();
    });

    const baseCapture = {
        organizationId: 'org-123',
        summary: 'Designed the audit log',
        signals: {
            prompt: 'Design the audit log',
            assistantMessage: 'I chose event sourcing.',
            modifiedFiles: ['src/audit/store.ts'],
            toolUses: [{ tool: 'Edit', filePath: 'src/audit/store.ts' }],
        },
    };

    const validDecision = {
        type: 'architectural_decision',
        origin: 'human',
        decision: 'Use event sourcing for the audit log',
        rationale: 'Full auditability',
        confidence: 0.9,
        evidence: ['src/audit/store.ts'],
    };

    function useCase(): ClassifyCliSessionCaptureUseCase {
        return new ClassifyCliSessionCaptureUseCase({} as any, {} as any);
    }

    // The seven keys the mapping is contracted to always emit.
    const DECISION_KEYS = [
        'type',
        'origin',
        'decision',
        'rationale',
        'confidence',
        'evidence',
        'autoPromoteCandidate',
    ].sort();

    // ───────────────────────── Request assembly ─────────────────────────
    describe('request assembly (exact args threaded into LLM.run)', () => {
        it('sends the declared schema, system prompt, JSON user payload, runName, org and byokConfig:undefined', async () => {
            runSpy.mockResolvedValue({ decisions: [] });

            await (useCase() as any).extractWithLLM(baseCapture);

            expect(runSpy).toHaveBeenCalledTimes(1);
            const arg = runSpy.mock.calls[0][0];

            // Exact schema identity — the declared output contract D.
            expect(arg.schema).toBe(LLMDecisionExtractionSchema);
            // byokConfig threaded as undefined → managed default (per source note).
            expect(arg.byokConfig).toBeUndefined();
            expect(arg.organizationId).toBe('org-123');
            expect(arg.runName).toBe(
                'ClassifyCliSessionCaptureUseCase::classifyCliSessionCapture',
            );
            // System prompt carries the shape contract + allowed enums.
            expect(typeof arg.system).toBe('string');
            expect(arg.system).toContain('"decisions"');
            expect(arg.system).toContain('architectural_decision');
            // User payload is the exact JSON-stringified assembled object.
            expect(arg.user).toBe(
                JSON.stringify({
                    summary: 'Designed the audit log',
                    prompt: 'Design the audit log',
                    assistantMessage: 'I chose event sourcing.',
                    modifiedFiles: ['src/audit/store.ts'],
                    toolUses: [
                        { tool: 'Edit', filePath: 'src/audit/store.ts' },
                    ],
                }),
            );
        });

        it('threads the capture organizationId through unchanged (BYOK routing key)', async () => {
            runSpy.mockResolvedValue({ decisions: [] });

            await (useCase() as any).extractWithLLM({
                ...baseCapture,
                organizationId: 'org-XYZ',
            });

            expect(runSpy.mock.calls[0][0].organizationId).toBe('org-XYZ');
        });
    });

    // ─────────────── Row 1 — Exact D, mapping side-effects exact ───────────────
    describe('Row 1 — exact D: mapping is byte-exact and deterministic', () => {
        it('maps a valid decision to the full CliSessionClassifiedDecision shape', async () => {
            runSpy.mockResolvedValue({ decisions: [validDecision] });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out).toEqual([
                {
                    type: 'architectural_decision',
                    origin: 'human',
                    decision: 'Use event sourcing for the audit log',
                    rationale: 'Full auditability',
                    confidence: 0.9,
                    evidence: ['src/audit/store.ts'],
                    autoPromoteCandidate: true,
                },
            ]);
        });

        it('normalizeConfidence clamps out-of-range confidence into [0,1]', async () => {
            runSpy.mockResolvedValue({
                decisions: [
                    { type: 'tooling', decision: 'a', confidence: 1.7 },
                    { type: 'tooling', decision: 'b', confidence: -0.4 },
                ],
            });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out[0].confidence).toBe(1);
            expect(out[1].confidence).toBe(0);
        });

        it('normalizeConfidence maps NaN / non-number / missing confidence to undefined', async () => {
            runSpy.mockResolvedValue({
                decisions: [
                    { type: 'tooling', decision: 'a', confidence: NaN },
                    { type: 'tooling', decision: 'b' },
                ],
            });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out[0].confidence).toBeUndefined();
            expect(out[1].confidence).toBeUndefined();
            // undefined confidence is never auto-promotable.
            expect(out[0].autoPromoteCandidate).toBe(false);
            expect(out[1].autoPromoteCandidate).toBe(false);
        });

        it('trims decision (>500) and rationale (>1000) with an ellipsis suffix', async () => {
            const longDecision = 'D'.repeat(600);
            const longRationale = 'R'.repeat(1200);
            runSpy.mockResolvedValue({
                decisions: [
                    {
                        type: 'tooling',
                        decision: longDecision,
                        rationale: longRationale,
                        confidence: 0.5,
                    },
                ],
            });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out[0].decision).toHaveLength(500);
            expect(out[0].decision.endsWith('...')).toBe(true);
            expect(out[0].rationale).toHaveLength(1000);
            expect(out[0].rationale.endsWith('...')).toBe(true);
        });

        it('evidence: trims each item to 300, drops empties, and caps at 5', async () => {
            runSpy.mockResolvedValue({
                decisions: [
                    {
                        type: 'tooling',
                        decision: 'x',
                        confidence: 0.5,
                        evidence: [
                            'a',
                            '',
                            'E'.repeat(400),
                            'b',
                            'c',
                            'd',
                            'e', // 7 non-empty after one '' → cap 5
                        ],
                    },
                ],
            });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out[0].evidence).toHaveLength(5);
            expect(out[0].evidence).not.toContain('');
            expect(out[0].evidence[1]).toHaveLength(300);
        });

        it('shouldAutoPromote: >=0.7 AND promotable type only', async () => {
            runSpy.mockResolvedValue({
                decisions: [
                    { type: 'architectural_decision', decision: 'a', confidence: 0.7 },
                    { type: 'architectural_decision', decision: 'b', confidence: 0.69 },
                    { type: 'convention', decision: 'c', confidence: 0.8 },
                    { type: 'tradeoff', decision: 'd', confidence: 0.95 },
                    { type: 'tooling', decision: 'e', confidence: 0.99 },
                    { type: 'implementation_detail', decision: 'f', confidence: 0.99 },
                    { type: 'other', decision: 'g', confidence: 0.99 },
                ],
            });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out.map((d: any) => d.autoPromoteCandidate)).toEqual([
                true, // architectural_decision @0.7
                false, // architectural_decision @0.69
                true, // convention @0.8
                true, // tradeoff @0.95
                false, // tooling (not promotable)
                false, // implementation_detail (not promotable)
                false, // other (not promotable)
            ]);
        });

        it('every mapped decision carries exactly the declared key set (return-shape invariant)', async () => {
            runSpy.mockResolvedValue({
                decisions: [validDecision, { type: 'other', decision: 'z' }],
            });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            for (const d of out) {
                expect(Object.keys(d).sort()).toEqual(DECISION_KEYS);
            }
        });
    });

    // ──────────── Row 13 — extra unknown keys tolerated ────────────
    it('Row 13 — extra unknown keys on a decision are ignored, not surfaced', async () => {
        runSpy.mockResolvedValue({
            decisions: [{ ...validDecision, foo: 'bar', nested: { a: 1 } }],
        });

        const out = await (useCase() as any).extractWithLLM(baseCapture);

        expect(out[0]).not.toHaveProperty('foo');
        expect(out[0]).not.toHaveProperty('nested');
        expect(Object.keys(out[0]).sort()).toEqual(DECISION_KEYS);
    });

    // ──────────── Row 27 — unicode / newlines / emoji preserved ────────────
    it('Row 27 — unicode, escaped newlines and emoji in string fields survive the mapping', async () => {
        const text = '🚀 use\nevent-sourcing 中文 — café';
        runSpy.mockResolvedValue({
            decisions: [
                {
                    type: 'other',
                    decision: text,
                    confidence: 0.5,
                    evidence: ['✅ src/x.ts'],
                },
            ],
        });

        const out = await (useCase() as any).extractWithLLM(baseCapture);

        expect(out[0].decision).toBe(text);
        expect(out[0].evidence).toEqual(['✅ src/x.ts']);
    });

    // ─────── Rows 14-18 — no-payload envelope shapes → safe typed-empty [] ───────
    describe('Rows 14-18 — non-D shapes with no recoverable payload → typed empty []', () => {
        const noPayload: Array<[string, unknown]> = [
            ['Row 14 — empty object {}', {}],
            ['Row 15 — empty decisions array', { decisions: [] }],
            ['Row 16 — empty string', ''],
            ['Row 16 — whitespace-only string', '   '],
            ['Row 17 — null return', null],
            ['Row 17 — undefined return', undefined],
            ['Row 18 — primitive true', true],
            ['Row 18 — primitive 0', 0],
            ['Row 18 — primitive "ok"', 'ok'],
            ['Row 31 — {error} object instead of D', { error: 'model exploded' }],
            ['Row 32 — empty-success (no output field)', { output: undefined }],
        ];

        it.each(noPayload)(
            '%s → extractWithLLM returns [] (never throws past the boundary)',
            async (_label, shape) => {
                runSpy.mockResolvedValue(shape);

                const out = await (useCase() as any).extractWithLLM(baseCapture);

                expect(out).toEqual([]);
            },
        );
    });

    // ─────── Rows 2 & 4 — silently-dropped real payloads (#1786 class, L193) ───────
    // LLM.run's contract returns schema-validated D or throws, so the shared
    // executor guards these shapes upstream. But `result?.decisions ?? []` at the
    // mapping layer would SILENTLY discard a real payload if the contract were ever
    // violated (a bare array of decisions, or a {result:D} wrapper), returning []
    // exactly as it does for a genuinely-empty result — no signal. Pinned as the
    // CORRECT behavior (recover the payload); green today, RED when the boundary is
    // hardened to unwrap. Source: classify-cli-session-capture.use-case.ts:193.
    it.failing(
        'Row 2 — bare array of decisions must be RECOVERED, not silently dropped (L193)',
        async () => {
            runSpy.mockResolvedValue([validDecision]);

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out).toHaveLength(1);
        },
    );

    it.failing(
        'Row 4 — {result:D} wrapper must be RECOVERED, not silently dropped (L193)',
        async () => {
            runSpy.mockResolvedValue({ result: { decisions: [validDecision] } });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            expect(out).toHaveLength(1);
        },
    );

    // ─────── Row 24 — invalid enum passthrough (#1786 class, L198-199) ───────
    // The mapping does `decision.type as CliSessionDecisionType` /
    // `decision.origin as CliSessionDecisionOrigin` — a raw cast, no runtime check.
    // An out-of-set type/origin (guarded upstream by the zod enum, but unchecked
    // here) ships verbatim. Pinned as CORRECT = reject the invalid enum; green now,
    // RED when the boundary validates. Source: use-case.ts:198-199.
    it.failing(
        'Row 24 — an out-of-set decision.type must be rejected/normalized, not passed through (L198)',
        async () => {
            runSpy.mockResolvedValue({
                decisions: [
                    { type: 'URGENT', decision: 'x', confidence: 0.9 },
                ],
            });

            const out = await (useCase() as any).extractWithLLM(baseCapture);

            // Correct: the invalid enum value must not survive to the output.
            expect(out).toHaveLength(0);
        },
    );

    // ─────────────── C / fail-safe rows via execute() pipeline ───────────────
    // At this boundary the transport zoo (truncated/malformed JSON, network
    // throw, refusal, abort) surfaces as "LLM.run rejects" (the executor either
    // recovers to valid D or throws). execute() MUST degrade to the heuristic
    // fallback with an OBSERVABLE origin, and never throw past the boundary.
    describe('execute() fail-safe: LLM failure → heuristic fallback, never throw', () => {
        function makeRepo() {
            return {
                findByCaptureId: jest.fn(),
                markSkipped: jest.fn().mockResolvedValue(undefined),
                markProcessing: jest.fn().mockResolvedValue(undefined),
                markCompleted: jest.fn().mockResolvedValue(undefined),
                markFailed: jest.fn().mockResolvedValue(undefined),
            };
        }

        // A capture that yields heuristic decisions (candidate keyword present).
        const stopCapture = {
            captureId: 'cap-1',
            organizationId: 'org-1',
            event: 'stop',
            summary: 'We chose event sourcing because it gives full audit.',
            signals: {
                prompt: 'design audit',
                assistantMessage: 'I chose event sourcing.',
                modifiedFiles: ['src/audit/store.ts'],
                toolUses: [],
            },
        };

        function build(repo: any) {
            return new ClassifyCliSessionCaptureUseCase(repo, {} as any);
        }

        it('Row 1 (pipeline) — valid decisions → markCompleted origin "llm"', async () => {
            const repo = makeRepo();
            repo.findByCaptureId.mockResolvedValue(stopCapture);
            runSpy.mockResolvedValue({ decisions: [validDecision] });

            await build(repo).execute('cap-1');

            expect(repo.markCompleted).toHaveBeenCalledTimes(1);
            const [id, decisions, origin] = repo.markCompleted.mock.calls[0];
            expect(id).toBe('cap-1');
            expect(origin).toBe('llm');
            expect(decisions).toHaveLength(1);
        });

        it('Rows 28/29/30/33/34 — LLM.run rejects → origin "heuristic-fallback", no throw', async () => {
            const errors: Array<[string, Error]> = [
                ['Row 28/29 — unparseable JSON escalated to throw', new Error('NoObjectGeneratedError: bad json')],
                ['Row 30 — network/timeout throw', new Error('ETIMEDOUT')],
                ['Row 33 — refusal escalated to throw', new Error('content_filter refusal')],
                ['Row 34 — abort fired mid-call', Object.assign(new Error('aborted'), { name: 'AbortError' })],
            ];

            for (const [, err] of errors) {
                const repo = makeRepo();
                repo.findByCaptureId.mockResolvedValue(stopCapture);
                runSpy.mockRejectedValue(err);

                await expect(build(repo).execute('cap-1')).resolves.toBeUndefined();

                expect(repo.markFailed).not.toHaveBeenCalled();
                expect(repo.markCompleted).toHaveBeenCalledTimes(1);
                expect(repo.markCompleted.mock.calls[0][2]).toBe(
                    'heuristic-fallback',
                );
            }
        });

        it('Row 31 — {error} object return → empty LLM result → origin "heuristic"', async () => {
            const repo = makeRepo();
            repo.findByCaptureId.mockResolvedValue(stopCapture);
            runSpy.mockResolvedValue({ error: 'model exploded' });

            await build(repo).execute('cap-1');

            expect(repo.markFailed).not.toHaveBeenCalled();
            expect(repo.markCompleted.mock.calls[0][2]).toBe('heuristic');
        });

        it('Row 32 — undefined/empty-success return → origin "heuristic"', async () => {
            const repo = makeRepo();
            repo.findByCaptureId.mockResolvedValue(stopCapture);
            runSpy.mockResolvedValue(undefined);

            await build(repo).execute('cap-1');

            expect(repo.markCompleted.mock.calls[0][2]).toBe('heuristic');
        });

        it('Row 3 — single object where an array is expected → thrown TypeError caught → fallback', async () => {
            // `{decisions:<object>}` makes `rawDecisions.map` throw; execute must
            // catch and degrade rather than crash the stage.
            const repo = makeRepo();
            repo.findByCaptureId.mockResolvedValue(stopCapture);
            runSpy.mockResolvedValue({ decisions: { not: 'an array' } });

            await expect(build(repo).execute('cap-1')).resolves.toBeUndefined();

            expect(repo.markFailed).not.toHaveBeenCalled();
            expect(repo.markCompleted.mock.calls[0][2]).toBe(
                'heuristic-fallback',
            );
        });

        it('never calls LLM.run for a non-stop event (markSkipped short-circuit)', async () => {
            const repo = makeRepo();
            repo.findByCaptureId.mockResolvedValue({
                ...stopCapture,
                event: 'other',
            });

            await build(repo).execute('cap-1');

            expect(runSpy).not.toHaveBeenCalled();
            expect(repo.markSkipped).toHaveBeenCalledTimes(1);
        });

        it('Row 35 (pipeline) — empty textual context → markSkipped, no LLM.run', async () => {
            const repo = makeRepo();
            repo.findByCaptureId.mockResolvedValue({
                captureId: 'cap-1',
                event: 'stop',
                summary: '',
                signals: { prompt: '', assistantMessage: '', modifiedFiles: [], toolUses: [] },
            });

            await build(repo).execute('cap-1');

            expect(runSpy).not.toHaveBeenCalled();
            expect(repo.markSkipped).toHaveBeenCalledTimes(1);
            expect(repo.markProcessing).not.toHaveBeenCalled();
        });
    });

    // ─────────────────── D — input variants (assembly invariants) ───────────────────
    describe('D — input variants feed a happy LLM.run; assert the assembled boundary', () => {
        function assembledUserPayload() {
            return JSON.parse(runSpy.mock.calls[0][0].user);
        }

        it('Row 35 — empty input assembles empty strings/arrays (no crash)', async () => {
            runSpy.mockResolvedValue({ decisions: [] });

            await (useCase() as any).extractWithLLM({});

            expect(runSpy).toHaveBeenCalledTimes(1);
            expect(assembledUserPayload()).toEqual({
                summary: '',
                prompt: '',
                assistantMessage: '',
                modifiedFiles: [],
                toolUses: [],
            });
        });

        it('Row 36 — single file / single tool use is threaded through', async () => {
            runSpy.mockResolvedValue({ decisions: [] });

            await (useCase() as any).extractWithLLM({
                summary: 's',
                signals: {
                    modifiedFiles: ['only.ts'],
                    toolUses: [{ tool: 'Read' }],
                },
            });

            const payload = assembledUserPayload();
            expect(payload.modifiedFiles).toEqual(['only.ts']);
            expect(payload.toolUses).toEqual([{ tool: 'Read' }]);
        });

        it('Rows 37 & 41 — a large input is sent WHOLE in exactly one call (no batching/off-by-one)', async () => {
            runSpy.mockResolvedValue({ decisions: [] });
            const modifiedFiles = Array.from(
                { length: 5000 },
                (_v, i) => `src/f${i}.ts`,
            );

            await (useCase() as any).extractWithLLM({
                summary: 'big',
                signals: { modifiedFiles, toolUses: [] },
            });

            // Single-shot boundary: no chunking, no per-batch fan-out.
            expect(runSpy).toHaveBeenCalledTimes(1);
            expect(assembledUserPayload().modifiedFiles).toHaveLength(5000);
        });

        it('Row 38 — duplicate input items are preserved verbatim (no dedup at the boundary)', async () => {
            runSpy.mockResolvedValue({ decisions: [] });

            await (useCase() as any).extractWithLLM({
                summary: 's',
                signals: {
                    modifiedFiles: ['x.ts', 'x.ts'],
                    toolUses: [{ tool: 'Edit' }, { tool: 'Edit' }],
                },
            });

            const payload = assembledUserPayload();
            expect(payload.modifiedFiles).toEqual(['x.ts', 'x.ts']);
            expect(payload.toolUses).toHaveLength(2);
        });

        it('Row 39 — null/undefined required fields coalesce to ""/[] (no null leak)', async () => {
            runSpy.mockResolvedValue({ decisions: [] });

            await (useCase() as any).extractWithLLM({
                summary: undefined,
                signals: {
                    prompt: null,
                    assistantMessage: undefined,
                    modifiedFiles: null,
                    toolUses: null,
                },
            });

            expect(assembledUserPayload()).toEqual({
                summary: '',
                prompt: '',
                assistantMessage: '',
                modifiedFiles: [],
                toolUses: [],
            });
        });

        it('Row 40 — special chars / whitespace / huge diff are JSON-escaped, not dropped', async () => {
            runSpy.mockResolvedValue({ decisions: [] });
            const nasty = 'a\t"b"\n\\c 🚀   中文';

            await (useCase() as any).extractWithLLM({
                summary: nasty,
                signals: { modifiedFiles: [], toolUses: [] },
            });

            // Round-trips cleanly through JSON.stringify → JSON.parse.
            expect(assembledUserPayload().summary).toBe(nasty);
        });

        it('Row 42 — output mapping is independent of input order (metamorphic)', async () => {
            runSpy.mockResolvedValue({ decisions: [validDecision] });

            const outA = await (useCase() as any).extractWithLLM({
                summary: 's',
                signals: { modifiedFiles: ['a.ts', 'b.ts'], toolUses: [] },
            });
            const outB = await (useCase() as any).extractWithLLM({
                summary: 's',
                signals: { modifiedFiles: ['b.ts', 'a.ts'], toolUses: [] },
            });

            expect(outA).toEqual(outB);
        });
    });
});

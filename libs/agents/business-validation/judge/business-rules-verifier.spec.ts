import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { VERIFY_DONE_TOOL } from '@libs/agent-harness/infrastructure/verify/llm-verdict';
import {
    applyBusinessRulesVerdict,
    BusinessRulesVerifier,
    shouldVerifyValidationResult,
} from './business-rules-verifier';
import type { ValidationResult } from './validation.types';

function runStateWithVerdict(keep: boolean, rationale = 'r'): RunState {
    return {
        runId: 'r',
        agentId: 'business-rules-verifier',
        steps: [],
        artifacts: [{ type: VERIFY_DONE_TOOL, payload: { keep, rationale } }],
        messages: [],
        usage: {},
    } as unknown as RunState;
}

const claim: ValidationResult = {
    needsMoreInfo: false,
    summary: 'PR never revokes sessions on soft-delete',
    reason: 'missing_logic' as any,
    confidence: 'high',
};

describe('BusinessRulesVerifier.verify', () => {
    const ctx = { runId: 'x', signal: new AbortController().signal } as any;

    it('passes the diff, task, and analyzer claim into the verify prompt', async () => {
        const runner = { run: jest.fn(async () => runStateWithVerdict(true)) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'DIFF_MARKER',
            taskContext: 'TASK_MARKER',
        });
        await verifier.verify(claim, ctx);
        const prompt = (runner.run.mock.calls as any[])[0][1].prompt as string;
        expect(prompt).toContain('DIFF_MARKER');
        expect(prompt).toContain('TASK_MARKER');
        expect(prompt).toContain('PR never revokes sessions'); // the claim summary
    });

    it('instructs the rationale to be written in the configured language', async () => {
        const runner = { run: jest.fn(async () => runStateWithVerdict(true)) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'd',
            taskContext: 't',
            userLanguage: 'pt-BR',
        });
        await verifier.verify(claim, ctx);
        expect((runner.run.mock.calls as any[])[0][0].systemPrompt).toContain(
            'pt-BR',
        );
    });

    it('fails open (keep=true) when the run produces no verdict', async () => {
        const emptyState = {
            ...runStateWithVerdict(true),
            artifacts: [],
        } as RunState;
        const runner = { run: jest.fn(async () => emptyState) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'd',
            taskContext: 't',
        });
        const verdict = await verifier.verify(claim, ctx);
        expect(verdict.keep).toBe(true);
    });

    // Issue #1937: this verifier shares the harness extractVerdict, so a model
    // that writes its verdict as TEXT instead of calling submitVerdict — the
    // shape Anthropic and the OpenAI-compatible providers take, where strict
    // tool use is off — must still refute the claim instead of failing open.
    it('reads a keep=false the model wrote as text instead of calling submitVerdict', async () => {
        const textState = {
            ...runStateWithVerdict(true),
            artifacts: [],
            steps: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content:
                            'The diff does revoke sessions.\n' +
                            '{"keep": false, "rationale": "diff covers it"}',
                        toolCalls: [],
                    },
                },
            ],
        } as unknown as RunState;
        const runner = { run: jest.fn(async () => textState) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'd',
            taskContext: 't',
        });
        const verdict = await verifier.verify(claim, ctx);
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toBe('diff covers it');
        expect(verdict.parseMode).toBe('text');
    });
});

describe('shouldVerifyValidationResult (opt-in gate)', () => {
    const ready: ValidationResult = {
        needsMoreInfo: false,
        summary: 's',
        reason: 'analysis_ready' as any,
    };

    it('is false when the flag is off (default)', () => {
        expect(shouldVerifyValidationResult(ready, {})).toBe(false);
        expect(
            shouldVerifyValidationResult(ready, {
                verifyAnalyzerResult: false,
            }),
        ).toBe(false);
    });

    it('is true for a completed analysis when opted in', () => {
        expect(
            shouldVerifyValidationResult(ready, { verifyAnalyzerResult: true }),
        ).toBe(true);
    });

    it('skips gating/failure states (needsMoreInfo or non-analysis_ready)', () => {
        const policy = { verifyAnalyzerResult: true };
        expect(
            shouldVerifyValidationResult(
                { ...ready, needsMoreInfo: true },
                policy,
            ),
        ).toBe(false);
        expect(
            shouldVerifyValidationResult(
                { ...ready, reason: 'parser_fallback' as any },
                policy,
            ),
        ).toBe(false);
        expect(
            shouldVerifyValidationResult(
                { ...ready, reason: 'task_context_missing' as any },
                policy,
            ),
        ).toBe(false);
    });
});

describe('applyBusinessRulesVerdict (refute-to-drop)', () => {
    it('leaves the result untouched when keep=true', () => {
        const out = applyBusinessRulesVerdict(claim, { keep: true });
        expect(out).toEqual(claim);
    });

    it('drops the violation when refuted (keep=false): clears reason, marks verified', () => {
        const out = applyBusinessRulesVerdict(claim, {
            keep: false,
            rationale: 'diff implements it',
            confidence: 'medium',
        });
        expect(out.reason).toBeUndefined();
        expect(out.needsMoreInfo).toBe(false);
        expect(out.confidence).toBe('medium');
        // Summary = the verifier's rationale verbatim (written in the configured
        // language), NOT an English prefix that would mix languages.
        expect(out.summary).toBe('diff implements it');
    });

    it('falls back to the original summary when the verdict has no rationale', () => {
        const out = applyBusinessRulesVerdict(claim, { keep: false });
        expect(out.summary).toBe(claim.summary);
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * LLM.run I/O CONTRACT MATRIX — full closure for this boundary.
 *
 * The LLM.run site is `runner.run(spec, input, ctx)` (business-rules-verifier.ts
 * L108). The model's structured decision arrives as the submitVerdict tool call,
 * which the runner materializes into `RunState.artifacts` as
 * `{type: 'submitVerdict', payload: <the tool args>}`. The DETERMINISTIC parse
 * layer is `extractVerdict(state)` (llm-verdict.ts L111-136), reached verbatim
 * through `verify()` (L124).
 *
 * Declared schema D = VERDICT_SCHEMA = {keep:boolean, rationale:string,
 * confidence?:'high'|'medium'|'low'}. The gate the system acts on is `keep`.
 *
 * NON-DEGRADATION (#1786): this boundary is FAIL-OPEN by explicit contract —
 * "only an explicit keep:false drops the candidate". So every off-schema payload
 * must degrade to keep=true carrying the OBSERVABLE marker rationale
 * 'no parseable verdict — kept by default'. That marker is the signal that makes
 * the safe-default observable rather than silent. Each A/B row below asserts BOTH
 * keep=true AND the marker, proving the degrade is signalled, not silent.
 * ──────────────────────────────────────────────────────────────────────────── */

const NO_VERDICT_MARKER = 'no parseable verdict — kept by default';

/** RunState carrying exactly one submitVerdict artifact with the given payload. */
function stateWithPayload(
    payload: unknown,
    opts: {
        status?: RunState['status'];
        usage?: RunState['usage'];
        steps?: RunState['steps'];
        extraArtifacts?: RunState['artifacts'];
    } = {},
): RunState {
    return {
        runId: 'r',
        agentId: 'business-rules-verifier',
        status: opts.status ?? 'completed',
        steps: opts.steps ?? [],
        artifacts: [
            ...(opts.extraArtifacts ?? []),
            { type: VERIFY_DONE_TOOL, payload },
        ],
        stopReason: undefined,
        usage: opts.usage ?? {},
        trace: [],
    } as unknown as RunState;
}

const matrixClaim: ValidationResult = {
    needsMoreInfo: false,
    summary: 'PR never revokes sessions on soft-delete',
    reason: 'analysis_ready' as any,
    confidence: 'high',
};

function makeVerifier(
    runnerRun: jest.Mock,
    params: Partial<
        ConstructorParameters<typeof BusinessRulesVerifier>[1]
    > = {},
): BusinessRulesVerifier {
    return new BusinessRulesVerifier(
        { run: runnerRun } as any,
        {
            modelId: 'resolved',
            diff: 'd',
            taskContext: 't',
            ...params,
        } as any,
    );
}

const matrixCtx = { runId: 'x', signal: new AbortController().signal } as any;

/** Run verify() with a happy runner that returns the given RunState. */
async function verdictFrom(
    state: RunState,
    params?: Partial<ConstructorParameters<typeof BusinessRulesVerifier>[1]>,
) {
    const run = jest.fn(async () => state);
    const verifier = makeVerifier(run, params);
    const verdict = await verifier.verify(matrixClaim, matrixCtx);
    return { verdict, run, verifier };
}

/** The universal boundary invariant: whatever the model returns, the Verdict
 *  ALWAYS carries a real boolean gate — the type contract never breaks. */
function assertBooleanGate(v: { keep: unknown }) {
    expect(typeof v.keep).toBe('boolean');
}

afterEach(() => jest.restoreAllMocks());

describe('MATRIX A — output-shape zoo (payload that is not D)', () => {
    it('row 1 — exact D recovers keep/rationale/confidence verbatim', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({
                keep: false,
                rationale: 'diff covers it',
                confidence: 'medium',
            }),
        );
        assertBooleanGate(verdict);
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toBe('diff covers it');
        expect(verdict.confidence).toBe('medium');
    });

    it('row 12 — partial object with just keep recovers; without keep degrades', async () => {
        const present = await verdictFrom(stateWithPayload({ keep: false }));
        expect(present.verdict.keep).toBe(false);
        expect(present.verdict.rationale).toBeUndefined();

        const absent = await verdictFrom(
            stateWithPayload({ rationale: 'no keep here' }),
        );
        expect(absent.verdict.keep).toBe(true);
        expect(absent.verdict.rationale).toBe(NO_VERDICT_MARKER);
    });
});

describe('MATRIX B — semantic-but-wrong (valid JSON, wrong value encoding)', () => {
    // row 24 — off-enum confidence. The gate is safe (keep honored), but the
    // parser passes `confidence` through VERBATIM with no enum validation
    // (llm-verdict.ts L126: `confidence: obj.confidence as ...`), so an off-enum
    // value ships silently on the Verdict. Pinned as the correct behavior that
    // the fix would introduce (normalize/drop off-enum confidence).
    it.failing(
        'row 24 — off-enum confidence should NOT ship verbatim (llm-verdict.ts:126)',
        async () => {
            const { verdict } = await verdictFrom(
                stateWithPayload({ keep: false, confidence: 'URGENT' }),
            );
            // Correct behavior on the fix: an off-enum confidence is normalized
            // to undefined (or a valid enum), never shipped as-is.
            expect(
                ['high', 'medium', 'low', undefined].includes(
                    verdict.confidence as any,
                ),
            ).toBe(true);
        },
    );
});

describe('MATRIX C — unparseable / transport (fail-safe layer)', () => {
    it('row 30 — runner.run throws: verify() propagates (fail-safe is the caller)', async () => {
        // The verify boundary does NOT catch runner.run errors (L108, no
        // try/catch); the fail-open safety net is the caller,
        // maybeVerifyValidationResult (businessRulesValidationAgent.ts L402/L437).
        const run = jest.fn(async () => {
            throw new Error('network down');
        });
        const verifier = makeVerifier(run);
        await expect(verifier.verify(matrixClaim, matrixCtx)).rejects.toThrow(
            'network down',
        );
    });

    it('row 33 — refusal (model produced prose, never called submitVerdict) fails open', async () => {
        const state = {
            ...stateWithPayload(null),
            status: 'completed',
            artifacts: [],
            steps: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: 'I cannot help with this request.',
                    },
                },
            ],
        } as unknown as RunState;
        const { verdict } = await verdictFrom(state);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 34 — abort: ctx threaded to runner.run; a rejected run propagates', async () => {
        const controller = new AbortController();
        const abortCtx = { runId: 'x', signal: controller.signal } as any;
        const run = jest.fn(async () => {
            controller.abort();
            throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        });
        const verifier = makeVerifier(run);
        await expect(verifier.verify(matrixClaim, abortCtx)).rejects.toThrow(
            'aborted',
        );
        // ctx (carrying the abort signal) is threaded verbatim as the 3rd arg.
        expect((run.mock.calls as any[])[0][2]).toBe(abortCtx);
    });
});

describe('MATRIX D — input variants (happy runner, assert the invariant)', () => {
    const happy = () => jest.fn(async () => stateWithPayload({ keep: true }));

    it('row 35 — empty diff & taskContext render the "(none provided)" fallbacks', async () => {
        const run = happy();
        const verifier = makeVerifier(run, { diff: '', taskContext: '' });
        await verifier.verify(matrixClaim, matrixCtx);
        const prompt = (run.mock.calls as any[])[0][1].prompt as string;
        expect(prompt).toContain('(none provided)');
    });

    it('row 37 — large diff crossing any chunk boundary is passed whole (no truncation)', async () => {
        const bigDiff = '+ line\n'.repeat(80_000); // ~560k chars
        const run = happy();
        const verifier = makeVerifier(run, { diff: bigDiff });
        await verifier.verify(matrixClaim, matrixCtx);
        const prompt = (run.mock.calls as any[])[0][1].prompt as string;
        expect(prompt).toContain(bigDiff);
    });

    it('row 39 — null/undefined candidate fields use "(no summary)" and omit Reason', async () => {
        const run = happy();
        const verifier = makeVerifier(run);
        await verifier.verify(
            { needsMoreInfo: false, summary: undefined as any } as any,
            matrixCtx,
        );
        const prompt = (run.mock.calls as any[])[0][1].prompt as string;
        expect(prompt).toContain('(no summary)');
        expect(prompt).not.toContain('Reason:');
    });

    it('row 40 — whitespace-only diff is truthy: passed literally, NOT replaced by fallback', async () => {
        const run = happy();
        const verifier = makeVerifier(run, { diff: '   \t  ' });
        await verifier.verify(matrixClaim, matrixCtx);
        const prompt = (run.mock.calls as any[])[0][1].prompt as string;
        const diffSection = prompt.split('## PR diff')[1];
        expect(diffSection).toContain('   \t  ');
        expect(diffSection).not.toContain('(none provided)');
    });
});

describe('BOUNDARY — request assembly & return-shape guarantees', () => {
    // Every payload whose `keep` is not a real boolean — wrapped, renamed,
    // stringified, fenced, truncated, coerced ("false" would silently DROP if
    // coerced), empty or primitive — fails open with the observable marker.
    it('fails open with the marker on every payload whose keep is not a boolean', async () => {
        const offSchema: unknown[] = [
            [{ keep: false, rationale: 'x' }],
            [],
            {},
            null,
            undefined,
            '',
            '   ',
            true,
            0,
            'ok',
            '{"keep":false,"rationale":"x"}',
            '```json\n{"keep":false}\n```',
            'Here is the verdict: {"keep":false}. Thanks!',
            '{"keep":fal',
            "{'keep':false}",
            { result: { keep: false } },
            { result: { result: { keep: false } } },
            { '0': { keep: false } },
            { content: { keep: false } },
            { shouldKeep: false, reason: 'diff covers it' },
            { Keep: false },
            { KEEP: false },
            { keep: 'false', rationale: 'x' },
            { keep: 'true' },
            { keep: 'no' },
            { keep: 0 },
            { keep: 1 },
            { error: 'rate_limit_exceeded' },
            { choices: [{ message: { content: '{"keep":false}' } }] },
        ];
        for (const payload of offSchema) {
            const { verdict } = await verdictFrom(stateWithPayload(payload));
            assertBooleanGate(verdict);
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('builds the spec with the verifier system prompt, submitVerdict result tool, and default maxSteps', async () => {
        const run = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(run).verify(matrixClaim, matrixCtx);
        const spec = (run.mock.calls as any[])[0][0];
        expect(spec.systemPrompt).toContain(
            'You audit a business-rules validation verdict',
        );
        expect(spec.resultToolName).toBe(VERIFY_DONE_TOOL);
        expect(
            spec.tools.list().some((t: any) => t.name === VERIFY_DONE_TOOL),
        ).toBe(true);
        expect(spec.maxSteps).toBe(4);
    });

    it('threads cost labels onto the spec ONLY when provided', async () => {
        const withLabels = jest.fn(async () =>
            stateWithPayload({ keep: true }),
        );
        await makeVerifier(withLabels, {
            agentName: 'A',
            phase: 'P',
            runName: 'R',
            spanName: 'S',
        }).verify(matrixClaim, matrixCtx);
        const s1 = (withLabels.mock.calls as any[])[0][0];
        expect(s1).toMatchObject({
            agentName: 'A',
            phase: 'P',
            runName: 'R',
            spanName: 'S',
        });

        const without = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(without).verify(matrixClaim, matrixCtx);
        const s2 = (without.mock.calls as any[])[0][0];
        expect(s2).not.toHaveProperty('agentName');
        expect(s2).not.toHaveProperty('phase');
    });

    it('threads providerOptions (BYOK reasoning knob) onto the spec verbatim', async () => {
        const providerOptions = {
            anthropic: { thinking: { type: 'enabled' } },
        };
        const run = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(run, { providerOptions }).verify(
            matrixClaim,
            matrixCtx,
        );
        expect((run.mock.calls as any[])[0][0].providerOptions).toEqual(
            providerOptions,
        );
    });

    it('respects a maxSteps override', async () => {
        const run = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(run, { maxSteps: 9 }).verify(matrixClaim, matrixCtx);
        expect((run.mock.calls as any[])[0][0].maxSteps).toBe(9);
    });

    it('forwards telemetryMetadata into the run input only when provided', async () => {
        const meta = { organizationId: 'org', teamId: 'team' } as any;
        const withMeta = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(withMeta, { telemetryMetadata: meta }).verify(
            matrixClaim,
            matrixCtx,
        );
        expect((withMeta.mock.calls as any[])[0][1].telemetryMetadata).toEqual(
            meta,
        );

        const without = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(without).verify(matrixClaim, matrixCtx);
        expect((without.mock.calls as any[])[0][1]).not.toHaveProperty(
            'telemetryMetadata',
        );
    });

    it('captures token usage from the run state after verify()', async () => {
        const usage = { inputTokens: 11, outputTokens: 7 };
        const run = jest.fn(async () =>
            stateWithPayload({ keep: true }, { usage }),
        );
        const verifier = makeVerifier(run);
        await verifier.verify(matrixClaim, matrixCtx);
        expect(verifier.usage).toEqual(usage);
    });

    it('when multiple submitVerdict artifacts exist, the last valid one wins', async () => {
        const state = {
            ...stateWithPayload({ keep: true, rationale: 'second' }),
            artifacts: [
                {
                    type: VERIFY_DONE_TOOL,
                    payload: { keep: false, rationale: 'first' },
                },
                {
                    type: VERIFY_DONE_TOOL,
                    payload: { keep: true, rationale: 'second' },
                },
            ],
        } as unknown as RunState;
        const { verdict } = await verdictFrom(state);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe('second');
    });

    it('when the last artifact is malformed, an earlier valid verdict is recovered', async () => {
        const state = {
            ...stateWithPayload(null),
            artifacts: [
                {
                    type: VERIFY_DONE_TOOL,
                    payload: { keep: false, rationale: 'valid' },
                },
                { type: VERIFY_DONE_TOOL, payload: { keep: 'nope' } },
            ],
        } as unknown as RunState;
        const { verdict } = await verdictFrom(state);
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toBe('valid');
    });
});

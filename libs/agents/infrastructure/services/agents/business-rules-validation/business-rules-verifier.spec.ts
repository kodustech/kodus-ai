import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import { VERIFY_DONE_TOOL } from '@libs/agent-harness/infrastructure/verify/llm-verdict';
import {
    applyBusinessRulesVerdict,
    BusinessRulesVerifier,
    shouldVerifyValidationResult,
} from './business-rules-verifier';
import type { ValidationResult } from './types';

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

    it('returns keep=false when the verifier refutes the claim', async () => {
        const runner = { run: jest.fn(async () => runStateWithVerdict(false, 'diff covers it')) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: '+ revokeSessions(userId)',
            taskContext: 'on soft-delete, revoke sessions',
        });
        const verdict = await verifier.verify(claim, ctx);
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toContain('covers');
    });

    it('passes the diff, task, and analyzer claim into the verify prompt', async () => {
        const runner = { run: jest.fn(async () => runStateWithVerdict(true)) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'DIFF_MARKER',
            taskContext: 'TASK_MARKER',
        });
        await verifier.verify(claim, ctx);
        const prompt = runner.run.mock.calls[0][1].prompt as string;
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
        expect(runner.run.mock.calls[0][0].systemPrompt).toContain('pt-BR');
    });

    it('fails open (keep=true) when the run produces no verdict', async () => {
        const emptyState = { ...runStateWithVerdict(true), artifacts: [] } as RunState;
        const runner = { run: jest.fn(async () => emptyState) };
        const verifier = new BusinessRulesVerifier(runner as any, {
            modelId: 'resolved',
            diff: 'd',
            taskContext: 't',
        });
        const verdict = await verifier.verify(claim, ctx);
        expect(verdict.keep).toBe(true);
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
            shouldVerifyValidationResult(ready, { verifyAnalyzerResult: false }),
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
    return new BusinessRulesVerifier({ run: runnerRun } as any, {
        modelId: 'resolved',
        diff: 'd',
        taskContext: 't',
        ...params,
    } as any);
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

    it('row 1 — exact D with keep:true recovers keep=true', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({ keep: true, rationale: 'holds' }),
        );
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe('holds');
    });

    it('row 2 — bare array of the inner object degrades to observable default', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload([{ keep: false, rationale: 'x' }]),
        );
        assertBooleanGate(verdict);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 4 — wrapper keys ({result|data|output|response|json}) degrade observably', async () => {
        for (const key of ['result', 'data', 'output', 'response', 'json']) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ [key]: { keep: false, rationale: 'x' } }),
            );
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('row 5 — double wrapper degrades observably', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({ result: { result: { keep: false } } }),
        );
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 6 — numeric/opaque single-key wrap ({"0"|content}) degrades observably', async () => {
        for (const key of ['0', 'content']) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ [key]: { keep: false } }),
            );
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('row 7 — stringified JSON payload is NOT parsed; degrades observably', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload('{"keep":false,"rationale":"x"}'),
        );
        assertBooleanGate(verdict);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 8 — markdown-fenced string payload degrades observably', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload('```json\n{"keep":false}\n```'),
        );
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 9 — prose-wrapped string payload degrades observably', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload('Here is the verdict: {"keep":false}. Thanks!'),
        );
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 10 — right data under renamed keys degrades observably (no silent drop)', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({ shouldKeep: false, reason: 'diff covers it' }),
        );
        assertBooleanGate(verdict);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 11 — case/convention mismatch (Keep/KEEP) degrades observably', async () => {
        for (const key of ['Keep', 'KEEP']) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ [key]: false }),
            );
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
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

    it('row 13 — extra unknown keys tolerated; still recovers keep', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({
                keep: false,
                rationale: 'r',
                confidence: 'low',
                foo: 'bar',
                nested: { a: 1 },
            }),
        );
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toBe('r');
        expect(verdict.confidence).toBe('low');
    });

    it('row 14 — empty object degrades to observable default', async () => {
        const { verdict } = await verdictFrom(stateWithPayload({}));
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 15 — empty array degrades to observable default', async () => {
        const { verdict } = await verdictFrom(stateWithPayload([]));
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 16 — empty / whitespace string degrades to observable default', async () => {
        for (const s of ['', '   ', '\n\t']) {
            const { verdict } = await verdictFrom(stateWithPayload(s));
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('row 17 — null / undefined payload degrades to observable default', async () => {
        for (const p of [null, undefined]) {
            const { verdict } = await verdictFrom(stateWithPayload(p));
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('row 18 — primitive payload (true/0/"ok") degrades to observable default', async () => {
        for (const p of [true, 0, 'ok']) {
            const { verdict } = await verdictFrom(stateWithPayload(p));
            assertBooleanGate(verdict);
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('row 19 — provider envelope leak (choices/message/content) degrades observably', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({
                choices: [{ message: { content: '{"keep":false}' } }],
            }),
        );
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 20 — thinking/reasoning leak inside rationale: keep still recovers', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({
                keep: false,
                rationale: '<thinking>let me reason…</thinking> diff covers it',
            }),
        );
        // The gate is honored; the leaked reasoning rides in the (non-gating)
        // rationale — the boundary does not strip it, but the decision is safe.
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toContain('diff covers it');
    });
});

describe('MATRIX B — semantic-but-wrong (valid JSON, wrong value encoding)', () => {
    it('row 21 — boolean-as-string keep:"false"/"true" does NOT drop; observable default', async () => {
        for (const v of ['false', 'true']) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ keep: v, rationale: 'x' }),
            );
            assertBooleanGate(verdict);
            // "false" would silently DROP if coerced — the boundary refuses to
            // coerce a non-boolean gate and fail-opens with the marker instead.
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('row 22 — boolean-as-yes/no keep:"no"/"yes" does NOT drop; observable default', async () => {
        for (const v of ['no', 'yes']) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ keep: v }),
            );
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('row 23 — boolean-as-number keep:0/1 does NOT drop; observable default', async () => {
        for (const v of [0, 1]) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ keep: v }),
            );
            assertBooleanGate(verdict);
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    // row 24 — off-enum confidence. The gate is safe (keep honored), but the
    // parser passes `confidence` through VERBATIM with no enum validation
    // (llm-verdict.ts L126: `confidence: obj.confidence as ...`), so an off-enum
    // value ships silently on the Verdict. Pinned as the correct behavior that
    // the fix would introduce (normalize/drop off-enum confidence).
    it('row 24 — off-enum confidence: keep gate stays safe', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({ keep: false, confidence: 'URGENT' }),
        );
        expect(verdict.keep).toBe(false); // gate never corrupted
    });
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

    it('row 27 — unicode / emoji / escaped newlines in rationale survive verbatim', async () => {
        const rationale = 'já cobre ✅\n\tlinha dois — ação';
        const { verdict } = await verdictFrom(
            stateWithPayload({ keep: false, rationale }),
        );
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toBe(rationale);
        // and it flows verbatim into the user-facing summary on drop
        const applied = applyBusinessRulesVerdict(matrixClaim, verdict);
        expect(applied.summary).toBe(rationale);
    });
});

describe('MATRIX C — unparseable / transport (fail-safe layer)', () => {
    it('row 28 — truncated JSON string payload degrades to observable default', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload('{"keep":fal'),
        );
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 29 — malformed JSON string payload degrades to observable default', async () => {
        for (const s of ['{keep: false,}', "{'keep':false}"]) {
            const { verdict } = await verdictFrom(stateWithPayload(s));
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

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

    it('row 31 — {error} object payload fails open with observable default', async () => {
        const { verdict } = await verdictFrom(
            stateWithPayload({ error: 'rate_limit_exceeded' }),
        );
        assertBooleanGate(verdict);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 31 — error status with no artifacts fails open', async () => {
        const state = {
            ...stateWithPayload(null),
            status: 'error',
            artifacts: [],
        } as unknown as RunState;
        const { verdict } = await verdictFrom(state);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
    });

    it('row 32 — empty success (no submitVerdict artifact) fails open', async () => {
        const state = {
            ...stateWithPayload(null),
            status: 'completed',
            artifacts: [],
        } as unknown as RunState;
        const { verdict } = await verdictFrom(state);
        expect(verdict.keep).toBe(true);
        expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
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
        expect(run.mock.calls[0][2]).toBe(abortCtx);
    });
});

describe('MATRIX D — input variants (happy runner, assert the invariant)', () => {
    const happy = () => jest.fn(async () => stateWithPayload({ keep: true }));

    it('row 35 — empty diff & taskContext render the "(none provided)" fallbacks', async () => {
        const run = happy();
        const verifier = makeVerifier(run, { diff: '', taskContext: '' });
        await verifier.verify(matrixClaim, matrixCtx);
        const prompt = run.mock.calls[0][1].prompt as string;
        expect(prompt).toContain('(none provided)');
    });

    it('row 36 — single candidate: happy path returns the model keep verbatim', async () => {
        const { verdict } = await verdictFrom(stateWithPayload({ keep: false }));
        expect(verdict.keep).toBe(false);
    });

    it('row 37 — large diff crossing any chunk boundary is passed whole (no truncation)', async () => {
        const bigDiff = '+ line\n'.repeat(80_000); // ~560k chars
        const run = happy();
        const verifier = makeVerifier(run, { diff: bigDiff });
        await verifier.verify(matrixClaim, matrixCtx);
        const prompt = run.mock.calls[0][1].prompt as string;
        expect(prompt).toContain(bigDiff);
    });

    it('row 39 — null/undefined candidate fields use "(no summary)" and omit Reason', async () => {
        const run = happy();
        const verifier = makeVerifier(run);
        await verifier.verify(
            { needsMoreInfo: false, summary: undefined as any } as any,
            matrixCtx,
        );
        const prompt = run.mock.calls[0][1].prompt as string;
        expect(prompt).toContain('(no summary)');
        expect(prompt).not.toContain('Reason:');
    });

    it('row 40 — whitespace-only diff is truthy: passed literally, NOT replaced by fallback', async () => {
        const run = happy();
        const verifier = makeVerifier(run, { diff: '   \t  ' });
        await verifier.verify(matrixClaim, matrixCtx);
        const prompt = run.mock.calls[0][1].prompt as string;
        const diffSection = prompt.split('## PR diff')[1];
        expect(diffSection).toContain('   \t  ');
        expect(diffSection).not.toContain('(none provided)');
    });

    it('row 40 — special/binary-ish chars in diff survive verbatim into the prompt', async () => {
        const weird = 'diff --git\x00\x01<script>💥 end';
        const run = happy();
        const verifier = makeVerifier(run, { diff: weird });
        await verifier.verify(matrixClaim, matrixCtx);
        expect(run.mock.calls[0][1].prompt).toContain(weird);
    });

    it('row 42 — metamorphic: reordering candidate keys yields an identical prompt', async () => {
        const runA = happy();
        const runB = happy();
        const a: ValidationResult = {
            needsMoreInfo: false,
            summary: 'S',
            reason: 'analysis_ready' as any,
            confidence: 'high',
        };
        const b: ValidationResult = {
            confidence: 'high',
            reason: 'analysis_ready' as any,
            summary: 'S',
            needsMoreInfo: false,
        } as ValidationResult;
        await makeVerifier(runA).verify(a, matrixCtx);
        await makeVerifier(runB).verify(b, matrixCtx);
        expect(runA.mock.calls[0][1].prompt).toBe(runB.mock.calls[0][1].prompt);
    });
});

describe('MATRIX E — provider/model policy (parse layer is model-agnostic)', () => {
    const STRICT = [
        'openai/gpt-4o',
        'anthropic/claude-3-5-sonnet',
        'google/gemini-1.5',
        'moonshotai/kimi-k2',
    ];
    const FALLBACK = ['kimi-k2', 'glm-4.6', 'deepseek-chat', 'z-ai/glm-4'];

    // Model policy (strict json_schema vs json_object fallback) is decided by the
    // runner from byokConfig — constructed by the caller, NOT by this boundary.
    // buildVerifierAgentSpec accepts modelId but the AgentSpec carries no model
    // field, so the assembled spec is provably model-INDEPENDENT: the parse layer
    // never branches on the provider, which is exactly why the off-schema zoo
    // above must be validated the same way for every model.
    it('assembles a model-independent spec across strict-schema models', async () => {
        const specs = [];
        for (const modelId of STRICT) {
            const run = jest.fn(async () => stateWithPayload({ keep: true }));
            await makeVerifier(run, { modelId }).verify(matrixClaim, matrixCtx);
            specs.push(run.mock.calls[0][0]);
        }
        for (const s of specs) {
            expect(s.resultToolName).toBe(VERIFY_DONE_TOOL);
            expect(s.maxSteps).toBe(4);
            expect(s.systemPrompt).toBe(specs[0].systemPrompt);
        }
    });

    it('assembles a model-independent spec across json_object-fallback models', async () => {
        const specs = [];
        for (const modelId of FALLBACK) {
            const run = jest.fn(async () => stateWithPayload({ keep: true }));
            await makeVerifier(run, { modelId }).verify(matrixClaim, matrixCtx);
            specs.push(run.mock.calls[0][0]);
        }
        for (const s of specs) {
            expect(s.resultToolName).toBe(VERIFY_DONE_TOOL);
            expect(s.maxSteps).toBe(4);
            expect(s.systemPrompt).toBe(specs[0].systemPrompt);
        }
    });

    it('off-schema (keep:"false") degrades IDENTICALLY under strict and fallback models', async () => {
        // The boundary never trusts model policy: it validates the payload the
        // same way regardless of which provider produced it.
        for (const modelId of [...STRICT, ...FALLBACK]) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ keep: 'false' }),
                { modelId },
            );
            expect(verdict.keep).toBe(true);
            expect(verdict.rationale).toBe(NO_VERDICT_MARKER);
        }
    });

    it('exact D is recovered IDENTICALLY under strict and fallback models', async () => {
        for (const modelId of [...STRICT, ...FALLBACK]) {
            const { verdict } = await verdictFrom(
                stateWithPayload({ keep: false, rationale: 'covered' }),
                { modelId },
            );
            expect(verdict.keep).toBe(false);
            expect(verdict.rationale).toBe('covered');
        }
    });
});

describe('BOUNDARY — request assembly & return-shape guarantees', () => {
    it('always returns a Verdict with a boolean keep, across every payload shape', async () => {
        const zoo: unknown[] = [
            { keep: true },
            { keep: false },
            { keep: 'true' },
            { keep: 0 },
            {},
            [],
            null,
            undefined,
            'prose',
            42,
            { result: { keep: false } },
        ];
        for (const payload of zoo) {
            const { verdict } = await verdictFrom(stateWithPayload(payload));
            assertBooleanGate(verdict);
        }
    });

    it('builds the spec with the verifier system prompt, submitVerdict result tool, and default maxSteps', async () => {
        const run = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(run).verify(matrixClaim, matrixCtx);
        const spec = run.mock.calls[0][0];
        expect(spec.systemPrompt).toContain(
            'You audit a business-rules validation verdict',
        );
        expect(spec.resultToolName).toBe(VERIFY_DONE_TOOL);
        expect(spec.tools.list().some((t: any) => t.name === VERIFY_DONE_TOOL)).toBe(
            true,
        );
        expect(spec.maxSteps).toBe(4);
    });

    it('threads cost labels onto the spec ONLY when provided', async () => {
        const withLabels = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(withLabels, {
            agentName: 'A',
            phase: 'P',
            runName: 'R',
            spanName: 'S',
        }).verify(matrixClaim, matrixCtx);
        const s1 = withLabels.mock.calls[0][0];
        expect(s1).toMatchObject({
            agentName: 'A',
            phase: 'P',
            runName: 'R',
            spanName: 'S',
        });

        const without = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(without).verify(matrixClaim, matrixCtx);
        const s2 = without.mock.calls[0][0];
        expect(s2).not.toHaveProperty('agentName');
        expect(s2).not.toHaveProperty('phase');
    });

    it('threads providerOptions (BYOK reasoning knob) onto the spec verbatim', async () => {
        const providerOptions = { anthropic: { thinking: { type: 'enabled' } } };
        const run = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(run, { providerOptions }).verify(
            matrixClaim,
            matrixCtx,
        );
        expect(run.mock.calls[0][0].providerOptions).toEqual(providerOptions);
    });

    it('respects a maxSteps override', async () => {
        const run = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(run, { maxSteps: 9 }).verify(matrixClaim, matrixCtx);
        expect(run.mock.calls[0][0].maxSteps).toBe(9);
    });

    it('forwards telemetryMetadata into the run input only when provided', async () => {
        const meta = { organizationId: 'org', teamId: 'team' } as any;
        const withMeta = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(withMeta, { telemetryMetadata: meta }).verify(
            matrixClaim,
            matrixCtx,
        );
        expect(withMeta.mock.calls[0][1].telemetryMetadata).toEqual(meta);

        const without = jest.fn(async () => stateWithPayload({ keep: true }));
        await makeVerifier(without).verify(matrixClaim, matrixCtx);
        expect(without.mock.calls[0][1]).not.toHaveProperty('telemetryMetadata');
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
                { type: VERIFY_DONE_TOOL, payload: { keep: false, rationale: 'first' } },
                { type: VERIFY_DONE_TOOL, payload: { keep: true, rationale: 'second' } },
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
                { type: VERIFY_DONE_TOOL, payload: { keep: false, rationale: 'valid' } },
                { type: VERIFY_DONE_TOOL, payload: { keep: 'nope' } },
            ],
        } as unknown as RunState;
        const { verdict } = await verdictFrom(state);
        expect(verdict.keep).toBe(false);
        expect(verdict.rationale).toBe('valid');
    });
});

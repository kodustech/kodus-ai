/**
 * Parity spec for the runStructuredReviewCall migration (03-05).
 *
 * Same seam-mock strategy as structured-review-call.spec.ts: mock
 * tracedGenerateText so the real runStructuredReviewCall runs but no provider
 * is hit (MockLanguageModelV4 hangs on the structured path). The assertions
 * prove the migrated merge/resolve sites return the same parsed object shapes
 * the STRING parser produced, which the downstream KodyIssuesManagementService
 * consumes via `?.matches` / `?.issueVerificationResults`.
 */
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    buildModelFromSlot: jest.fn(() => ({ __model: 'main' })),
    getModelName: jest.fn(() => 'test-model'),
    // structured-review-call's error path checks the per-slot limiter cooldown;
    // no limiter in unit tests → undefined (not in cooldown) so the error propagates.
    getLimiterForSlot: jest.fn(() => undefined),
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
    toAiSdkTelemetryArgs: jest.fn(() => ({
        telemetry: { isEnabled: false },
    })),
}));
jest.mock('@ai-sdk/openai-compatible', () => ({
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
}));

import {
    NoObjectGeneratedError,
    JSONParseError,
    TypeValidationError,
} from 'ai';
import { KodyIssuesAnalysisService } from './kodyIssuesAnalysis.service';
import { tracedGenerateText } from '@libs/llm/llm-call';
import {
    mayUseJsonSchema,
    isJsonSchemaUnsupportedError,
    markJsonSchemaUnsupported,
    getModelName,
} from '@libs/llm/byok-to-vercel';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

describe('KodyIssuesAnalysisService — runStructuredReviewCall parity', () => {
    let service: KodyIssuesAnalysisService;

    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });

    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();

        service = new KodyIssuesAnalysisService(observabilityService);
    });

    it('mergeSuggestionsIntoIssues returns the parsed matches object', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                matches: [
                    { suggestionId: 's1', existingIssueId: 'i1' },
                    { suggestionId: 's2', existingIssueId: null },
                ],
            }),
        );

        const out = await service.mergeSuggestionsIntoIssues(
            { organizationId: 'org-1' } as any,
            { number: 42 },
            { filePath: 'a.ts', existingIssues: [], newSuggestions: [] },
            null,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out.matches).toHaveLength(2);
        expect(out.matches[0]).toEqual({
            suggestionId: 's1',
            existingIssueId: 'i1',
        });
        // `null` (no match) survives so the consumer's `if (existingIssueId)`
        // guard behaves exactly as under the old STRING parser.
        expect(out.matches[1].existingIssueId).toBeNull();
    });

    it('resolveExistingIssues returns the parsed issueVerificationResults object', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                issueVerificationResults: [
                    {
                        issueId: 'i1',
                        issueTitle: 'Null check',
                        contributingSuggestionIds: ['s1'],
                        isIssuePresentInCode: false,
                        verificationConfidence: 'high',
                        reasoning: 'fixed',
                    },
                ],
            }),
        );

        const context = {
            organizationAndTeamData: { organizationId: 'org-1' },
            repository: { id: 'repo-1' },
            pullRequest: { number: 42 },
        } as any;

        const out = await service.resolveExistingIssues(
            context,
            { filePath: 'a.ts', issues: [] },
            null,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out.issueVerificationResults).toHaveLength(1);
        expect(out.issueVerificationResults[0].issueId).toBe('i1');
        expect(out.issueVerificationResults[0].isIssuePresentInCode).toBe(
            false,
        );
    });

    it('propagates the error when the LLM call fails (no silent swallow)', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('provider down'));

        await expect(
            service.mergeSuggestionsIntoIssues(
                { organizationId: 'org-1' } as any,
                { number: 42 },
                { filePath: 'a.ts' },
                // BYOK config with no fallback → main failure must throw,
                // never cascade to managed Groq.
                { main: { provider: 'openai' } } as any,
            ),
        ).rejects.toThrow('provider down');
    });
});

/* ────────────────────────────────────────────────────────────────────────────
 * FULL LLM.run I/O CONTRACT MATRIX for the two structured boundaries in this
 * service: mergeSuggestionsIntoIssues (D = { matches: [...] }) and
 * resolveExistingIssues (D = { issueVerificationResults: [...] }).
 *
 * SCOPE = the DETERMINISTIC layer only (request assembly, envelope parse,
 * recovery/fallback, guaranteed return shape). The model's decision QUALITY is
 * out of scope (separate eval track).
 *
 * How the shape-zoo is exercised faithfully: in production the model's output
 * reaches this boundary through `generateText({ output: Output.object })`, whose
 * `parseCompleteOutput` does `JSON.parse` + validate against the strict-wire zod
 * schema. So an off-schema return is NOT a resolved value here — the SDK THROWS
 * `NoObjectGeneratedError` (`.cause` = JSONParseError for non-JSON text, or
 * TypeValidationError for valid JSON of the wrong shape; `.text` = raw output).
 * We therefore simulate rows A2–A26/B/C by REJECTING the mocked
 * `tracedGenerateText` with the appropriate error and asserting the real
 * recovery layer either RECOVERS the real payload (deterministic salvage) or
 * SIGNALS (a json_object re-ask — a 2nd generateText call, never silent).
 *
 * #1786 non-degradation note: this boundary is structurally safe against the
 * "truthy-but-invalid envelope" class because (a) the schema is a zod strict-wire
 * schema carrying a validate fn (Output.object throws on off-schema, never
 * resolves garbage), (b) a shape mismatch triggers `reissueDowngraded` (an
 * observable re-ask, not a silent keep-all), and (c) the service throws on any
 * falsy `result`. A truthy-but-invalid object can only reach the service if the
 * SDK validation is bypassed — which cannot happen in production — so there is no
 * silent-degrade row to pin as `it.failing` here (recorded in notes, not as a
 * red test). Where the mock returns a raw shape (resolve path) it is used only
 * for rows the SDK genuinely resolves (exact D / extra-keys-tolerated).
 * ──────────────────────────────────────────────────────────────────────────── */

const MERGE_D = {
    matches: [
        { suggestionId: 's1', existingIssueId: 'i1' },
        { suggestionId: 's2' },
    ],
};

const RESOLVE_D = {
    issueVerificationResults: [
        { issueId: 'i1', isIssuePresentInCode: true },
        {
            issueId: 'i2',
            issueTitle: 'Race',
            contributingSuggestionIds: ['s3'],
            isIssuePresentInCode: false,
            verificationConfidence: 'high' as const,
            reasoning: 'resolved',
        },
    ],
};

const PR = { number: 42 };
const RESOLVE_CTX = {
    organizationAndTeamData: { organizationId: 'org-1' },
    repository: { id: 'repo-1' },
    pullRequest: PR,
} as any;

// A slot whose provider is NOT in the real REGISTRY → resolveStructuredPlan
// short-circuits to 'as-is', keeping every test on the main try/catch path (no
// reroute-json branch). It still proves byokConfig threading end-to-end.
const FAKE_SLOT = { provider: 'acme-test-provider', model: 'acme-1' } as any;

const callMerge = (
    promptData: any = { filePath: 'a.ts', existingIssues: [], newSuggestions: [] },
    byok: any = null,
) =>
    new KodyIssuesAnalysisService(observabilityService).mergeSuggestionsIntoIssues(
        { organizationId: 'org-1' } as any,
        PR,
        promptData,
        byok,
    );

const callResolve = (
    promptData: any = { filePath: 'a.ts', issues: [] },
    byok: any = null,
) =>
    new KodyIssuesAnalysisService(observabilityService).resolveExistingIssues(
        RESOLVE_CTX,
        promptData,
        byok,
    );

/** A NoObjectGeneratedError whose cause is a JSON PARSE error (non-JSON text) —
 *  the deterministic-salvage path (fence / prose / trailing comma / truncated). */
const parseFail = (text: string) =>
    new NoObjectGeneratedError({
        message: 'no object generated',
        cause: new JSONParseError({ text, cause: new Error('parse') }),
        text,
    } as any);

/** A NoObjectGeneratedError whose cause is a TYPE validation error (valid JSON,
 *  wrong shape) — salvage returns undefined → the executor re-asks the model. */
const shapeFail = (value: unknown) =>
    new NoObjectGeneratedError({
        message: 'no object generated',
        cause: new TypeValidationError({ value, cause: new Error('shape') }),
        text: JSON.stringify(value),
    } as any);

const resetContractMocks = () => {
    mockGenerate.mockReset();
    (mayUseJsonSchema as jest.Mock).mockReset().mockReturnValue(true);
    (isJsonSchemaUnsupportedError as jest.Mock).mockReset().mockReturnValue(false);
    (markJsonSchemaUnsupported as jest.Mock).mockReset();
    (getModelName as jest.Mock).mockReset().mockReturnValue('test-model');
    observabilityService.runAiSdkLLMInSpan.mockClear();
};

describe('KodyIssuesAnalysisService — LLM.run I/O contract matrix', () => {
    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });
    beforeEach(resetContractMocks);

    // ── A. Output-shape zoo ────────────────────────────────────────────────

    it('Row 1 — exact D: returns the parsed object verbatim (side effect exact)', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out).toEqual(MERGE_D);
    });

    it.each([
        ['Row 2 — bare array', [{ suggestionId: 's1' }]],
        ['Row 3 — single object where array expected', { matches: { suggestionId: 's1' } }],
        ['Row 4 — wrapper key {result:D}', { result: MERGE_D }],
        ['Row 5 — double wrapper {result:{result:D}}', { result: { result: MERGE_D } }],
        ['Row 6 — numeric/opaque single-key wrap', { '0': MERGE_D }],
        ['Row 10 — right data, wrong keys', { duplicateMatches: MERGE_D.matches }],
        ['Row 11 — case/convention mismatch', { Matches: MERGE_D.matches }],
        ['Row 12 — partial object (missing required key)', { notMatches: 1 }],
        ['Row 14 — empty object', {}],
        ['Row 15 — bare empty array', []],
        ['Row 18 — primitive where object expected', true],
        ['Row 19 — provider envelope leak', { choices: [{ message: { content: '{}' } }] }],
    ])(
        '%s: valid-JSON-wrong-shape → re-asks the model (SIGNAL, not silent), never returns the bad shape',
        async (_label, badShape) => {
            mockGenerate
                .mockRejectedValueOnce(shapeFail(badShape))
                .mockResolvedValueOnce(ok(MERGE_D));
            const out = await callMerge();
            // The mismatch is NOT swallowed: a 2nd json_object re-ask fires.
            expect(mockGenerate).toHaveBeenCalledTimes(2);
            expect(out).toEqual(MERGE_D);
        },
    );

    it('Row 7 — stringified JSON (parses to a string, not an object): re-asks', async () => {
        // Output.object JSON.parses the quoted string → a primitive string →
        // TypeValidationError. Recovery re-asks the model.
        mockGenerate
            .mockRejectedValueOnce(shapeFail(JSON.stringify(MERGE_D)))
            .mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(out).toEqual(MERGE_D);
    });

    it('Row 8 — markdown-fenced JSON: deterministic salvage recovers, NO model re-ask', async () => {
        const text = '```json\n' + JSON.stringify(MERGE_D) + '\n```';
        mockGenerate.mockRejectedValueOnce(parseFail(text));
        const out = await callMerge();
        // Free deterministic repair → exactly one generateText call.
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out).toEqual(MERGE_D);
    });

    it('Row 9 — prose-wrapped JSON: deterministic salvage recovers the real payload', async () => {
        const text =
            'Here is the result: ' +
            JSON.stringify(MERGE_D) +
            '\n\nLet me know if you need anything else.';
        mockGenerate.mockRejectedValueOnce(parseFail(text));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out).toEqual(MERGE_D);
    });

    it('Row 13 — extra unknown keys alongside the right ones: tolerated (not a crash)', async () => {
        // Non-strict zod strips unknowns; the boundary must return D with its
        // required keys intact and never throw over the extras.
        mockGenerate.mockResolvedValueOnce(
            ok({ ...MERGE_D, _debug: 'x', trace_id: 42 }),
        );
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out.matches).toHaveLength(2);
    });

    it('Row 16 — empty/whitespace text: no JSON to salvage → re-asks the model', async () => {
        mockGenerate
            .mockRejectedValueOnce(parseFail('   \n  '))
            .mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(out).toEqual(MERGE_D);
    });

    it('Row 17 — null/undefined return (no experimental_output): fail-safe THROW, never returns null', async () => {
        mockGenerate.mockResolvedValueOnce({ usage: {} }); // readOutput → undefined
        await expect(callMerge()).rejects.toThrow(/No response from LLM/);
    });

    it('Row 20 — reasoning/thinking leak before the JSON: salvage slices the payload out', async () => {
        const text =
            'Let me reason through this carefully step by step.\n' +
            JSON.stringify(MERGE_D);
        mockGenerate.mockRejectedValueOnce(parseFail(text));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out).toEqual(MERGE_D);
    });

    // ── B. Semantic-but-wrong (asserted on the resolve boundary — it has the
    //       boolean + enum fields the merge schema lacks) ────────────────────

    it.each([
        ['Row 21 — boolean as string', { issueId: 'i1', isIssuePresentInCode: 'false' }],
        ['Row 22 — boolean as yes/no', { issueId: 'i1', isIssuePresentInCode: 'no' }],
        ['Row 23 — boolean as number', { issueId: 'i1', isIssuePresentInCode: 0 }],
        [
            'Row 24 — enum out of allowed set',
            {
                issueId: 'i1',
                isIssuePresentInCode: true,
                verificationConfidence: 'URGENT',
            },
        ],
    ])(
        '%s: NOT silently coerced → re-asks the model, then returns the valid payload',
        async (_label, badItem) => {
            mockGenerate
                .mockRejectedValueOnce(
                    shapeFail({ issueVerificationResults: [badItem] }),
                )
                .mockResolvedValueOnce(ok(RESOLVE_D));
            const out = await callResolve();
            expect(mockGenerate).toHaveBeenCalledTimes(2);
            expect(out.issueVerificationResults[0].isIssuePresentInCode).toBe(
                true,
            );
        },
    );

    it('Row 26 — duplicate keys in JSON object: deterministic last-wins parse', async () => {
        // JSON.parse keeps the LAST value for a repeated key; salvage must apply
        // that deterministically (and validate the result).
        const text =
            '{"matches":[{"suggestionId":"OLD"}],"matches":[{"suggestionId":"NEW"}]}';
        mockGenerate.mockRejectedValueOnce(parseFail(text));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out.matches).toHaveLength(1);
        expect(out.matches[0].suggestionId).toBe('NEW');
    });

    it('Row 27 — unicode / escaped newlines / emoji in string fields: preserved exactly', async () => {
        const d = {
            issueVerificationResults: [
                {
                    issueId: 'i1',
                    isIssuePresentInCode: true,
                    reasoning: 'café \n line2 \t 🎉 — naïve façade',
                },
            ],
        };
        mockGenerate.mockResolvedValueOnce(ok(d));
        const out = await callResolve();
        expect(out.issueVerificationResults[0].reasoning).toBe(
            'café \n line2 \t 🎉 — naïve façade',
        );
    });

    // ── C. Unparseable / transport (fail-safe layer) ───────────────────────

    it('Row 28 — truncated JSON (unclosed): salvage cannot repair → re-asks the model', async () => {
        mockGenerate
            .mockRejectedValueOnce(parseFail('{"matches":[{"suggestionId":"s1"'))
            .mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(out).toEqual(MERGE_D);
    });

    it('Row 29 — malformed JSON (trailing commas): deterministic salvage repairs it', async () => {
        const text =
            '{"matches":[{"suggestionId":"s1","existingIssueId":"i1"},],}';
        mockGenerate.mockRejectedValueOnce(parseFail(text));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out.matches[0].suggestionId).toBe('s1');
    });

    it('Row 30a — LLM.run throws a non-retryable error: fail-safe re-throw (never crash silently)', async () => {
        mockGenerate.mockRejectedValueOnce(new Error('provider exploded'));
        await expect(callMerge()).rejects.toThrow('provider exploded');
    });

    it('Row 30b — LLM.run throws a transient (5xx) error: ONE same-model re-issue, then succeeds', async () => {
        mockGenerate
            .mockRejectedValueOnce(
                Object.assign(new Error('upstream unavailable'), { status: 503 }),
            )
            .mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge();
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(out).toEqual(MERGE_D);
    });

    it('Row 31 — {error} envelope with no output: fail-safe THROW, never returns the error object', async () => {
        // No experimental_output/output on the result → readOutput undefined →
        // the service treats it as "no response" and throws.
        mockGenerate.mockResolvedValueOnce({
            error: { message: 'model refused' },
            usage: {},
        });
        await expect(callMerge()).rejects.toThrow(/No response from LLM/);
    });

    it('Row 32 — empty success (content:"", finish_reason:length): fail-safe THROW', async () => {
        mockGenerate.mockResolvedValueOnce({
            text: '',
            finishReason: 'length',
            usage: {},
        });
        await expect(callMerge()).rejects.toThrow(/No response from LLM/);
    });

    it('Row 33 — refusal prose ("I cannot help"): no JSON → re-asks, then propagates if still bad', async () => {
        mockGenerate
            .mockRejectedValueOnce(parseFail('I cannot help with that request.'))
            .mockRejectedValueOnce(parseFail('I cannot help with that request.'));
        await expect(callMerge()).rejects.toBeInstanceOf(NoObjectGeneratedError);
        // Re-ask fired (signal), and the persistent failure is NOT swallowed.
        expect(mockGenerate).toHaveBeenCalledTimes(2);
    });

    it('Row 34 — abort signal fired mid-call: re-throws WITHOUT a same-model re-issue', async () => {
        mockGenerate.mockRejectedValueOnce(
            Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
            }),
        );
        await expect(callMerge()).rejects.toThrow(/aborted/i);
        // An aborted/timed-out call must never be re-issued (would burn the budget).
        expect(mockGenerate).toHaveBeenCalledTimes(1);
    });

    // ── D. Input variants (happy LLM.run mock; assert the request invariant) ─

    it('Row 35 — empty input (0 suggestions): threaded verbatim, ONE call, empty D returned', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ matches: [] }));
        const promptData = { filePath: 'a.ts', existingIssues: [], newSuggestions: [] };
        const out = await callMerge(promptData);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(
            JSON.stringify(promptData),
        );
        expect(out.matches).toEqual([]);
    });

    it('Row 36 — single item: passed through unchanged', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        const promptData = {
            filePath: 'a.ts',
            newSuggestions: [{ id: 's1', body: 'one' }],
        };
        await callMerge(promptData);
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(
            JSON.stringify(promptData),
        );
    });

    it('Row 37 — large input: sent as ONE call, whole payload in `user` (no split/truncation)', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        const big = {
            filePath: 'a.ts',
            newSuggestions: Array.from({ length: 5000 }, (_, i) => ({
                id: `s${i}`,
                body: 'x'.repeat(64),
            })),
        };
        await callMerge(big);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(JSON.stringify(big));
    });

    it('Row 38 — duplicate items in input: forwarded verbatim (no dedup at this layer)', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        const dup = {
            filePath: 'a.ts',
            newSuggestions: [{ id: 's1' }, { id: 's1' }, { id: 's1' }],
        };
        await callMerge(dup);
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(JSON.stringify(dup));
    });

    it('Row 39 — input with null/undefined required fields: no crash, JSON.stringify semantics', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        const nullish = {
            filePath: null,
            newSuggestions: [{ id: 's1', body: undefined }],
        };
        const out = await callMerge(nullish);
        // undefined fields drop, null stays — the boundary just forwards the string.
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(
            JSON.stringify(nullish),
        );
        expect(out).toEqual(MERGE_D);
    });

    it('Row 40 — special chars / whitespace-only diff: escaped safely into `user`', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        const weird = {
            filePath: 'a.ts',
            diff: '\t\n  "quotes" \\ back   null-ish 🚀 <script>',
        };
        await callMerge(weird);
        expect(mockGenerate.mock.calls[0][0].prompt).toBe(JSON.stringify(weird));
    });

    it('Row 42 — order permutation of the same input → equivalent request contract', async () => {
        mockGenerate.mockResolvedValue(ok(MERGE_D));
        const a = { newSuggestions: [{ id: 's1' }, { id: 's2' }] };
        const b = { newSuggestions: [{ id: 's2' }, { id: 's1' }] };
        const outA = await callMerge(a);
        const outB = await callMerge(b);
        // Same system + structured-output channel + schema for both orderings;
        // only the user payload reflects the caller's order (pure pass-through).
        expect(mockGenerate.mock.calls[0][0].system).toBe(
            mockGenerate.mock.calls[1][0].system,
        );
        expect(mockGenerate.mock.calls[0][0].output).toBeDefined();
        expect(mockGenerate.mock.calls[1][0].output).toBeDefined();
        expect(outA).toEqual(outB);
    });

    // ── E. N-model policy branches (structured-output gate) ─────────────────

    it('Row E-strict — json_schema honored: trusts clean D, exactly one call', async () => {
        (mayUseJsonSchema as jest.Mock).mockReturnValue(true);
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge(undefined, FAKE_SLOT);
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(out).toEqual(MERGE_D);
    });

    it('Row E-strict — json_schema advertised but rejected at runtime: caches + re-issues json_object', async () => {
        (mayUseJsonSchema as jest.Mock).mockReturnValue(true);
        (isJsonSchemaUnsupportedError as jest.Mock).mockReturnValue(true);
        mockGenerate
            .mockRejectedValueOnce(new Error('response_format json_schema not supported'))
            .mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge(undefined, FAKE_SLOT);
        expect(markJsonSchemaUnsupported).toHaveBeenCalledTimes(1);
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(out).toEqual(MERGE_D);
    });

    it('Row E-fallback — json_object branch: the full off-schema zoo is recovered via re-ask', async () => {
        (mayUseJsonSchema as jest.Mock).mockReturnValue(false);
        mockGenerate
            .mockRejectedValueOnce(shapeFail({ wrong: 'shape' }))
            .mockResolvedValueOnce(ok(MERGE_D));
        const out = await callMerge(undefined, FAKE_SLOT);
        // Never triggers the json_schema-unsupported path (we didn't send it),
        // but the shape mismatch is still re-asked, not silently kept.
        expect(markJsonSchemaUnsupported).not.toHaveBeenCalled();
        expect(mockGenerate).toHaveBeenCalledTimes(2);
        expect(out).toEqual(MERGE_D);
    });

    // ── byokConfig threading + return-shape / non-degradation invariants ────

    it('threads the byokConfig slot end-to-end into the model resolution', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        await callMerge(undefined, FAKE_SLOT);
        // getModelName is called with the resolved slot → the slot flowed
        // service → LLM.run → runStructuredReviewCall → resolveModelConfig.
        expect(getModelName).toHaveBeenCalledWith(FAKE_SLOT, undefined);
    });

    it('no byokConfig → resolves the managed default (undefined slot), never a stray slot', async () => {
        mockGenerate.mockResolvedValueOnce(ok(MERGE_D));
        await callMerge(undefined, null);
        expect(getModelName).toHaveBeenCalledWith(undefined, undefined);
    });

    it('always sends the structured-output channel + a system prompt (request assembly)', async () => {
        mockGenerate.mockResolvedValueOnce(ok(RESOLVE_D));
        await callResolve();
        const args = mockGenerate.mock.calls[0][0];
        expect(args.output).toBeDefined(); // Output.object → schema threaded
        expect(typeof args.system).toBe('string');
        expect(args.system.length).toBeGreaterThan(0);
    });

    it('non-degradation: every success returns the declared shape; every failure throws (never a wrong/empty default silently)', async () => {
        // Success → declared type.
        mockGenerate.mockResolvedValueOnce(ok(RESOLVE_D));
        const good = await callResolve();
        expect(Array.isArray(good.issueVerificationResults)).toBe(true);

        // Unrecoverable failure → surfaces as a throw, not a typed-empty default.
        mockGenerate.mockReset();
        (mayUseJsonSchema as jest.Mock).mockReturnValue(true);
        mockGenerate
            .mockRejectedValueOnce(shapeFail({ nope: 1 }))
            .mockRejectedValueOnce(shapeFail({ nope: 1 }));
        await expect(callResolve()).rejects.toBeInstanceOf(
            NoObjectGeneratedError,
        );
    });
});

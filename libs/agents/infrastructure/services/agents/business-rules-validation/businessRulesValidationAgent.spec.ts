/**
 * businessRulesValidationAgent — LLM.run I/O CONTRACT tests.
 *
 * SCOPE = the DETERMINISTIC layer around the analyzer LLM.run boundary:
 *   - envelope parsing (`parseBusinessRulesValidationResult`, the tolerant
 *     free-text → ValidationResult parser the analyzer feeds its `content` into),
 *   - fail-safe + retry (`executeAnalyzerWithRetries` / `buildAnalyzerFailureResult`),
 *   - request assembly (`callLLM`: system/user split, seedMessages, maxOutputTokens,
 *     byokConfig + telemetry threading into the runner),
 *   - the guaranteed ValidationResult return shape across every layer.
 *
 * NOT in scope: whether a flagged violation is CORRECT (the model's judgment
 * quality) — that is the separate eval track.
 *
 * The declared output schema D for the analyzer boundary is `ValidationResult`
 * = { needsMoreInfo:boolean, summary:string, missingInfo?, mode?, reason?,
 *     taskContextStatus?, prDiffStatus?, confidence? }.
 *
 * Rows map to /scratchpad/llm-io-contract-matrix.md. Each applicable row has an
 * explicit assertion; #1786-class silent degradations are pinned as `it.failing`
 * (green today, red on the fix) with the source line recorded.
 *
 * Provider policy (E): this boundary does NOT call the structured-output-gate —
 * the analyzer is a plain free-text completion (maxSteps 1, no json_schema) and
 * its output is ALWAYS run through the tolerant parser. There is therefore no
 * "strict json_schema trusts clean D" branch to exercise separately; the full
 * A/B/C zoo is in scope for every provider, and the parse is provider-agnostic
 * (see the "provider policy (E)" describe block).
 */
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';

import { BusinessRulesValidationAgentProvider } from './businessRulesValidationAgent';
import { parseBusinessRulesValidationResult } from './validation-result.parser';
import type { ValidationResult } from './types';

// --- helpers ---------------------------------------------------------------

/** Construct the provider with inert deps — enough to reach the private
 *  deterministic methods via `(provider as any)`. */
function makeProvider(): BusinessRulesValidationAgentProvider {
    return new BusinessRulesValidationAgentProvider(
        {} as any, // permissionValidationService
        {} as any, // parametersService
        {} as any, // observabilityService
        {} as any, // genericSkillRunner
    );
}

const isValidationResultShape = (r: unknown): r is ValidationResult =>
    !!r &&
    typeof r === 'object' &&
    typeof (r as ValidationResult).needsMoreInfo === 'boolean' &&
    typeof (r as ValidationResult).summary === 'string';

/** parser_fallback is the boundary's explicit "I could not read the model
 *  output" signal — the observable safe-default, NOT a silent pass. */
const isParserFallback = (r: ValidationResult): boolean =>
    r.needsMoreInfo === true && r.reason === 'parser_fallback';

const EXACT_D: ValidationResult = {
    needsMoreInfo: false,
    summary: '## Business Rules Validation\n**Status:** OK',
    mode: 'full_analysis',
    reason: 'analysis_ready',
    taskContextStatus: 'usable',
    prDiffStatus: 'usable',
    confidence: 'high',
};

afterEach(() => jest.restoreAllMocks());

// ===========================================================================
// A. Output-shape zoo — fed to the envelope parser directly.
// ===========================================================================
describe('envelope parse — A. output-shape zoo', () => {
    it('row 1 — exact D: preserves keys/types verbatim', () => {
        const out = parseBusinessRulesValidationResult(EXACT_D);
        expect(out.needsMoreInfo).toBe(false);
        expect(out.summary).toContain('Business Rules Validation');
        expect(out.mode).toBe('full_analysis');
        expect(out.reason).toBe('analysis_ready');
        expect(out.taskContextStatus).toBe('usable');
        expect(out.prDiffStatus).toBe('usable');
        expect(out.confidence).toBe('high');
    });

    it('row 2 — bare array of the inner object: no known keys → explicit parser_fallback (not a silent pass)', () => {
        const out = parseBusinessRulesValidationResult([
            { needsMoreInfo: false, summary: 'x' },
        ]);
        expect(isParserFallback(out)).toBe(true);
    });

    // row 3 (single object where D expects an array / vice-versa) → rowsNA:
    // the analyzer D is a flat object, never an array; the array-return case is
    // row 2.

    it('row 4a — {result:D} wrapper: unwrapped and recovered', () => {
        const out = parseBusinessRulesValidationResult({ result: EXACT_D });
        expect(out.summary).toContain('Business Rules Validation');
        expect(out.reason).toBe('analysis_ready');
    });

    it('row 4b — {data:D}/{output:D} unknown wrappers: no known keys → parser_fallback signal', () => {
        expect(
            isParserFallback(
                parseBusinessRulesValidationResult({ data: EXACT_D }),
            ),
        ).toBe(true);
        expect(
            isParserFallback(
                parseBusinessRulesValidationResult({ output: EXACT_D }),
            ),
        ).toBe(true);
    });

    it('row 5 — double wrapper {result:{result:D}}: unwrapped and recovered', () => {
        const out = parseBusinessRulesValidationResult({
            result: { result: EXACT_D },
        });
        expect(out.summary).toContain('Business Rules Validation');
    });

    it('row 6 — opaque single-key wrap {"0":D}/{content:D-object}: parser_fallback signal', () => {
        expect(
            isParserFallback(
                parseBusinessRulesValidationResult({ '0': EXACT_D }),
            ),
        ).toBe(true);
        expect(
            isParserFallback(
                parseBusinessRulesValidationResult({ content: EXACT_D }),
            ),
        ).toBe(true);
    });

    it('row 7 — stringified JSON of D: parsed and recovered', () => {
        const out = parseBusinessRulesValidationResult(JSON.stringify(EXACT_D));
        expect(out.needsMoreInfo).toBe(false);
        expect(out.summary).toContain('Business Rules Validation');
    });

    it('row 8 — markdown-fenced JSON: fence stripped, recovered', () => {
        const out = parseBusinessRulesValidationResult(
            '```json\n' + JSON.stringify(EXACT_D) + '\n```',
        );
        expect(out.summary).toContain('Business Rules Validation');
        expect(out.reason).toBe('analysis_ready');
    });

    it('row 9 — prose-wrapped JSON: sliced out of the prose, recovered', () => {
        const out = parseBusinessRulesValidationResult(
            'Here is the result: {"needsMoreInfo":false,"summary":"PROSE_OK"}\n\nLet me know!',
        );
        expect(out.needsMoreInfo).toBe(false);
        expect(out.summary).toBe('PROSE_OK');
    });

    it('row 10 — right data, wrong (renamed) keys: no known keys → parser_fallback signal', () => {
        const out = parseBusinessRulesValidationResult({
            requiresMoreContext: true,
            summaryText: 'renamed payload',
        });
        expect(isParserFallback(out)).toBe(true);
    });

    it('row 11 — case/convention mismatch on keys (snake_case): parser_fallback signal', () => {
        const out = parseBusinessRulesValidationResult({
            needs_more_info: true,
            summary_markdown: 'snake',
        });
        expect(isParserFallback(out)).toBe(true);
    });

    it('row 12 — partial object (only summary): tolerated, needsMoreInfo defaults to false', () => {
        const out = parseBusinessRulesValidationResult({ summary: 'partial' });
        expect(out.summary).toBe('partial');
        expect(out.needsMoreInfo).toBe(false);
        expect(out.mode).toBe('full_analysis');
    });

    it('row 13 — extra unknown keys alongside the right ones: tolerated, does not crash', () => {
        const out = parseBusinessRulesValidationResult({
            needsMoreInfo: false,
            summary: 'ok',
            extraneous: { deeply: [1, 2, 3] },
            another: 42,
        });
        expect(out.summary).toBe('ok');
        expect(out.needsMoreInfo).toBe(false);
    });

    it('row 14 — empty object {}: parser_fallback signal', () => {
        expect(isParserFallback(parseBusinessRulesValidationResult({}))).toBe(
            true,
        );
    });

    it('row 15 — empty array []: parser_fallback signal', () => {
        expect(isParserFallback(parseBusinessRulesValidationResult([]))).toBe(
            true,
        );
    });

    it('row 16 — empty / whitespace-only string: parser_fallback signal', () => {
        expect(isParserFallback(parseBusinessRulesValidationResult(''))).toBe(
            true,
        );
        expect(
            isParserFallback(parseBusinessRulesValidationResult('   \n\t  ')),
        ).toBe(true);
    });

    it('row 17 — null / undefined: parser_fallback signal', () => {
        expect(isParserFallback(parseBusinessRulesValidationResult(null))).toBe(
            true,
        );
        expect(
            isParserFallback(parseBusinessRulesValidationResult(undefined)),
        ).toBe(true);
    });

    it('row 18 — primitive where object expected (true / 0 / short "ok"): parser_fallback signal', () => {
        expect(isParserFallback(parseBusinessRulesValidationResult(true))).toBe(
            true,
        );
        expect(isParserFallback(parseBusinessRulesValidationResult(0))).toBe(
            true,
        );
        expect(isParserFallback(parseBusinessRulesValidationResult('ok'))).toBe(
            true,
        );
    });

    it('row 19 — provider envelope leak {choices:[{message:{content}}]}: parser_fallback signal', () => {
        const out = parseBusinessRulesValidationResult({
            choices: [{ message: { content: JSON.stringify(EXACT_D) } }],
        });
        expect(isParserFallback(out)).toBe(true);
    });

    it('row 20 — reasoning/thinking leak before the JSON: prose sliced away, recovered', () => {
        const out = parseBusinessRulesValidationResult(
            'Let me reason step by step. The diff covers the requirement.\n' +
                '{"needsMoreInfo":false,"summary":"THINK_OK"}',
        );
        expect(out.needsMoreInfo).toBe(false);
        expect(out.summary).toBe('THINK_OK');
    });
});

// ===========================================================================
// B. Semantic-but-wrong (valid JSON, wrong value encoding).
// ===========================================================================
describe('envelope parse — B. semantic-but-wrong', () => {
    // rows 21/22/23: needsMoreInfo carried as a truthy-but-off-schema value.
    // Prod coerces with `record.needsMoreInfo === true` (validation-result.parser.ts:182),
    // so a model that asked for more info ships as a SILENT clean pass
    // (needsMoreInfo:false) with no signal — the #1786 class. Pinned as
    // it.failing asserting the CORRECT behavior (do not silently pass).
    it.failing(
        'row 21 — boolean-as-string needsMoreInfo:"true" must NOT become a silent clean pass',
        () => {
            const out = parseBusinessRulesValidationResult({
                needsMoreInfo: 'true',
                summary: 'I need the task acceptance criteria',
            });
            // correct: either coerced to true, or signalled as parser_fallback
            expect(out.needsMoreInfo === true || isParserFallback(out)).toBe(
                true,
            );
        },
    );

    it.failing(
        'row 22 — boolean-as-yes needsMoreInfo:"yes" must NOT become a silent clean pass',
        () => {
            const out = parseBusinessRulesValidationResult({
                needsMoreInfo: 'yes',
                summary: 'need more info',
            });
            expect(out.needsMoreInfo === true || isParserFallback(out)).toBe(
                true,
            );
        },
    );

    it.failing(
        'row 23 — boolean-as-number needsMoreInfo:1 must NOT become a silent clean pass',
        () => {
            const out = parseBusinessRulesValidationResult({
                needsMoreInfo: 1,
                summary: 'need more info',
            });
            expect(out.needsMoreInfo === true || isParserFallback(out)).toBe(
                true,
            );
        },
    );

    it('row 24 — enum values out of the allowed set are rejected to undefined (not passed through, no crash)', () => {
        const out = parseBusinessRulesValidationResult({
            needsMoreInfo: false,
            summary: 'ok',
            confidence: 'URGENT',
            reason: 'WHATEVER',
            mode: 'nope',
            taskContextStatus: 'bogus',
            prDiffStatus: 'bogus',
        });
        expect(out.confidence).toBeUndefined();
        expect(out.reason).toBeUndefined();
        expect(out.taskContextStatus).toBeUndefined();
        expect(out.prDiffStatus).toBeUndefined();
        // mode falls back to the needsMoreInfo-derived default, never the junk value.
        expect(out.mode).toBe('full_analysis');
    });

    // row 25 (index out of range / dangling reference) → rowsNA: ValidationResult
    // has no index/reference fields.

    it('row 26 — duplicate keys in stringified JSON: JSON.parse last-wins is honored', () => {
        const out = parseBusinessRulesValidationResult(
            '{"needsMoreInfo":true,"summary":"first","needsMoreInfo":false}',
        );
        // last-wins → false
        expect(out.needsMoreInfo).toBe(false);
    });

    it('row 27 — unicode / escaped newlines / emoji inside string fields are preserved', () => {
        const out = parseBusinessRulesValidationResult({
            needsMoreInfo: false,
            summary: '✅ Café done\nsecond líne — 你好',
        });
        expect(out.summary).toContain('✅');
        expect(out.summary).toContain('Café');
        expect(out.summary).toContain('你好');
        expect(out.summary).toContain('\n');
    });
});

// ===========================================================================
// C. Unparseable / transport — the fail-safe layer.
// Envelope-level rows via the parser; retry/throw rows via executeAnalyzerWithRetries.
// ===========================================================================
describe('fail-safe — C. unparseable / transport', () => {
    it('row 28 — truncated JSON (mid-object): does not throw, returns a valid ValidationResult', () => {
        const out = parseBusinessRulesValidationResult(
            '{"needsMoreInfo":false, "summary":"partial payload that never clo',
        );
        expect(isValidationResultShape(out)).toBe(true);
    });

    it('row 29a — malformed JSON with a trailing comma: repaired and recovered', () => {
        const out = parseBusinessRulesValidationResult(
            '{"needsMoreInfo":false,"summary":"TRAILING_OK",}',
        );
        expect(out.summary).toBe('TRAILING_OK');
        expect(out.needsMoreInfo).toBe(false);
    });

    it('row 29b — malformed JSON (single quotes / unquoted keys): does not throw, returns valid shape', () => {
        const out = parseBusinessRulesValidationResult(
            "{needsMoreInfo: false, summary: 'x'}",
        );
        expect(isValidationResultShape(out)).toBe(true);
    });

    it('row 30 — LLM.run throws: fail-safe to analyzer_failure, never crashes the stage', async () => {
        const provider = makeProvider();
        jest.spyOn(provider as any, 'callLLM').mockRejectedValue(
            new Error('network down'),
        );

        const out: ValidationResult = await (
            provider as any
        ).executeAnalyzerWithRetries({
            ctx: {},
            analyzerInstructions: 'sys',
            prompt: 'p',
            maxAttempts: 1,
            timeoutMs: 5000,
        });

        expect(isValidationResultShape(out)).toBe(true);
        expect(out.needsMoreInfo).toBe(true);
        expect(out.reason).toBe('analyzer_failure');
        expect(out.missingInfo).toContain('network down');
    });

    it('row 31 — error object returned as content ({error:...}): parser_fallback signal, no throw', () => {
        const out = parseBusinessRulesValidationResult({ error: 'boom' });
        expect(isParserFallback(out)).toBe(true);
    });

    it('row 32 — empty-success content: parser_fallback, and a retry recovers a later clean answer', async () => {
        // single-shot: empty success → parser_fallback surfaced (observable).
        expect(
            isParserFallback(parseBusinessRulesValidationResult('')),
        ).toBe(true);

        // retry loop: first attempt empty (parser_fallback), second attempt clean.
        const provider = makeProvider();
        const spy = jest
            .spyOn(provider as any, 'callLLM')
            .mockResolvedValueOnce({ content: '' })
            .mockResolvedValueOnce({
                content: JSON.stringify({
                    needsMoreInfo: false,
                    summary: 'RETRIED_OK',
                }),
            });

        const out: ValidationResult = await (
            provider as any
        ).executeAnalyzerWithRetries({
            ctx: {},
            analyzerInstructions: 'sys',
            prompt: 'p',
            maxAttempts: 2,
            timeoutMs: 5000,
        });

        expect(spy).toHaveBeenCalledTimes(2);
        expect(out.summary).toBe('RETRIED_OK');
        expect(out.needsMoreInfo).toBe(false);
    });

    it.failing(
        'row 33 — refusal prose ("I cannot help…") must NOT ship as a silent clean validation pass',
        () => {
            const out = parseBusinessRulesValidationResult(
                'I cannot help with that request.',
            );
            // correct: a refusal is not a completed validation — signal it.
            expect(out.needsMoreInfo === true || isParserFallback(out)).toBe(
                true,
            );
        },
    );

    it('row 34 — abort/timeout mid-call: withTimeout rejects → fail-safe to analyzer_failure', async () => {
        const provider = makeProvider();
        // never-resolving call → the per-attempt withTimeout fires.
        jest.spyOn(provider as any, 'callLLM').mockImplementation(
            () => new Promise(() => {}),
        );

        const out: ValidationResult = await (
            provider as any
        ).executeAnalyzerWithRetries({
            ctx: {},
            analyzerInstructions: 'sys',
            prompt: 'p',
            maxAttempts: 1,
            timeoutMs: 20,
        });

        expect(isValidationResultShape(out)).toBe(true);
        expect(out.needsMoreInfo).toBe(true);
        expect(out.reason).toBe('analyzer_failure');
    });
});

// ===========================================================================
// D. Input variants — request assembly at the real LLM.run boundary (callLLM).
// The runner is spied so no real model runs; we assert the args threading.
// ===========================================================================
describe('request assembly — D. input variants', () => {
    let runSpy: jest.SpyInstance;

    const fakeState = {
        steps: [{ message: { content: 'ANSWER' } }],
        usage: { inputTokens: 4, outputTokens: 2 },
    };

    beforeEach(() => {
        runSpy = jest
            .spyOn(AiSdkAgentRunner.prototype, 'run')
            .mockResolvedValue(fakeState as any);
    });

    const callArgs = () => {
        const [spec, input] = runSpy.mock.calls[0];
        return { spec, input };
    };

    it('row 35 — empty input (0 messages): assembles empty system+prompt, no throw', async () => {
        const provider = makeProvider();
        const res = await (provider as any).callLLM(
            [],
            {},
            'businessRulesAnalyzer',
            {},
        );
        const { spec, input } = callArgs();
        expect(spec.systemPrompt).toBe('');
        expect(input.prompt).toBe('');
        expect(input.seedMessages).toBeUndefined();
        expect(res.content).toBe('ANSWER');
    });

    it('row 36 — single user message: becomes the prompt, no seedMessages', async () => {
        const provider = makeProvider();
        await (provider as any).callLLM(
            [
                { role: 'system', content: 'SYS' },
                { role: 'user', content: 'ONLY_TURN' },
            ],
            { maxTokens: 4242 },
            'businessRulesAnalyzer',
            {},
        );
        const { spec, input } = callArgs();
        expect(spec.systemPrompt).toBe('SYS');
        expect(spec.maxOutputTokens).toBe(4242);
        expect(input.prompt).toBe('ONLY_TURN');
        expect(input.seedMessages).toBeUndefined();
    });

    // row 37 (large input crossing a batch/token chunk boundary) → rowsNA: this
    // boundary is a single-shot completion with no batching/chunking layer.

    it('row 38 — duplicate user messages: last is the prompt, earlier ones become seedMessages (no dedup crash)', async () => {
        const provider = makeProvider();
        await (provider as any).callLLM(
            [
                { role: 'user', content: 'DUP' },
                { role: 'user', content: 'DUP' },
            ],
            {},
            'businessRulesAnalyzer',
            {},
        );
        const { input } = callArgs();
        expect(input.prompt).toBe('DUP');
        expect(input.seedMessages).toEqual([{ role: 'user', content: 'DUP' }]);
    });

    it('row 39 — null/undefined fields (missing content, no metadata): no throw, prompt defaults to ""', async () => {
        const provider = makeProvider();
        (provider as any).byokConfig = { provider: 'openai' };
        const res = await (provider as any).callLLM(
            [{ role: 'user' } as any],
            {},
            'businessRulesAnalyzer',
            undefined,
        );
        const { input } = callArgs();
        expect(input.prompt).toBe('');
        // byokConfig provider still threaded onto telemetry even with no metadata arg.
        expect(input.telemetryMetadata.provider).toBe('openai');
        expect(res.content).toBe('ANSWER');
    });

    it('row 40 — special chars / emoji / whitespace content: threaded verbatim into the prompt', async () => {
        const provider = makeProvider();
        const weird = '  🚀 <diff>\n\t"quoted" \\ backslash — café 你好  ';
        await (provider as any).callLLM(
            [{ role: 'user', content: weird }],
            {},
            'businessRulesAnalyzer',
            {},
        );
        const { input } = callArgs();
        expect(input.prompt).toBe(weird);
    });

    // row 41 (input exactly at the batch boundary, off-by-one) → rowsNA: no
    // batching layer in this boundary.
    // row 42 (order permutation → equivalent decision, metamorphic) → rowsNA:
    // no set-valued input to permute; the message list is ordered by design
    // (last turn = prompt), and the parser consumes a single content string.

    it('threads org/team/PR/repo metadata + byok provider onto the runner telemetry', async () => {
        const provider = makeProvider();
        (provider as any).byokConfig = { provider: 'anthropic' };
        await (provider as any).callLLM(
            [{ role: 'user', content: 'x' }],
            {},
            'businessRulesAnalyzer',
            {
                organizationId: 'org-1',
                teamId: 'team-1',
                pullRequestId: 7,
                repositoryId: 'repo-9',
            },
        );
        const { spec, input } = callArgs();
        expect(spec.agentName).toBe('BusinessRulesValidation');
        expect(spec.phase).toBe('businessRulesAnalyzer');
        expect(input.telemetryMetadata).toMatchObject({
            organizationId: 'org-1',
            teamId: 'team-1',
            pullRequestId: 7,
            repositoryId: 'repo-9',
            provider: 'anthropic',
        });
    });
});

// ===========================================================================
// E. Provider / model policy — this boundary has a single (tolerant) branch.
// ===========================================================================
describe('provider policy (E) — free-text parse is provider-agnostic', () => {
    // Strict json_schema providers (openai/anthropic/google/moonshotai) would, at
    // a gated boundary, be trusted to return clean D. This boundary never gates,
    // so a clean D is parsed identically for any provider — assert the recover.
    it('strict-provider clean D parses to the recovered result (no schema-trust shortcut needed)', () => {
        const out = parseBusinessRulesValidationResult(JSON.stringify(EXACT_D));
        expect(out.summary).toContain('Business Rules Validation');
        expect(out.reason).toBe('analysis_ready');
    });

    // json_object-fallback providers (kimi/glm/deepseek/z-ai) return the full
    // zoo — and because there is no schema trust, the SAME tolerant recovery
    // applies. A fenced/prose payload recovers regardless of provider.
    it('fallback-provider fenced+prose payload recovers via the same tolerant path', () => {
        const out = parseBusinessRulesValidationResult(
            'Sure! ```json\n{"needsMoreInfo":false,"summary":"E_OK"}\n``` hope that helps',
        );
        expect(out.summary).toBe('E_OK');
        expect(out.needsMoreInfo).toBe(false);
    });
});

// ===========================================================================
// Guaranteed return shape — the boundary ALWAYS returns a ValidationResult.
// ===========================================================================
describe('guaranteed return shape (declared type across all layers)', () => {
    const zoo: unknown[] = [
        EXACT_D,
        [{ summary: 'x' }],
        { result: EXACT_D },
        { data: EXACT_D },
        JSON.stringify(EXACT_D),
        '```json\n{}\n```',
        'Here is the result: {"needsMoreInfo":false,"summary":"z"}',
        {},
        [],
        '',
        '   ',
        null,
        undefined,
        true,
        0,
        'ok',
        { choices: [{ message: { content: '{}' } }] },
        { needsMoreInfo: 'true', summary: 's' },
        { confidence: 'URGENT', summary: 's', needsMoreInfo: false },
        '{"needsMoreInfo":false,"summary":"trunc',
        "{needsMoreInfo:false, summary:'x'}",
        { error: 'boom' },
        'I cannot help with that.',
    ];

    it('never throws and always returns a well-formed ValidationResult for the whole zoo', () => {
        for (const input of zoo) {
            const out = parseBusinessRulesValidationResult(input);
            expect(isValidationResultShape(out)).toBe(true);
        }
    });

    it('applyValidationDefaults fills mode/reason/confidence so the return shape is complete', () => {
        const provider = makeProvider();
        const filled: ValidationResult = (provider as any).applyValidationDefaults(
            { needsMoreInfo: false, summary: 's' },
            {},
        );
        expect(filled.mode).toBe('full_analysis');
        expect(filled.reason).toBe('analysis_ready');
        expect(filled.confidence).toBe('medium');
        expect(typeof filled.summary).toBe('string');
        expect(typeof filled.needsMoreInfo).toBe('boolean');
    });
});

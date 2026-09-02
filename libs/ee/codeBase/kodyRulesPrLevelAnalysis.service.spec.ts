/**
 * Parity spec for the runStructuredReviewCall migration (03-05).
 *
 * We mock the model/network seam (tracedGenerateText) exactly like
 * structured-review-call.spec.ts so the REAL runStructuredReviewCall runs
 * (schema conversion + span plumbing) but hits no provider. Driving over
 * MockLanguageModelV4 HANGS on the structured path (Phase 0 + 03-01), so we
 * stop at the tracedGenerateText boundary and return a canned structured
 * object. The assertions prove the migrated call-sites map the structured
 * output onto the same downstream shapes the STRING parser produced.
 */
jest.mock('@libs/llm/byok-to-vercel', () => ({
    mayUseJsonSchema: jest.fn(() => true),
    markJsonSchemaUnsupported: jest.fn(),
    isJsonSchemaUnsupportedError: jest.fn(() => false),
    buildModelFromSlot: jest.fn(() => ({ __model: 'main' })),
    getModelName: jest.fn(() => 'test-model'),
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
    createOpenAICompatible: jest.fn(() => (modelId: string) => ({
        __model: 'groq',
        modelId,
    })),
}));

import { KodyRulesPrLevelAnalysisService } from './kodyRulesPrLevelAnalysis.service';
import {
    prLevelAnalyzerSchema,
    prLevelGroupSchema,
} from './kodyRulesPrLevelAnalysis.service';
import { LLM } from '@libs/llm/llm';
import { tracedGenerateText } from '@libs/llm/llm-call';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result.
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

const orgData: any = { organizationId: 'org-1', teamId: 'team-1' };
const PR_NUMBER = 42;

describe('KodyRulesPrLevelAnalysisService — runStructuredReviewCall parity', () => {
    let service: KodyRulesPrLevelAnalysisService;

    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });

    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();

        service = new KodyRulesPrLevelAnalysisService(
            {} as any, // kodyRulesService
            {} as any, // tokenChunkingService
            observabilityService,
            {} as any, // externalReferenceLoaderService
        );
    });

    const buildContext = (): any => ({
        pullRequest: {
            title: 'Add feature',
            body: 'desc',
            user: { login: 'octocat' },
            tags: [],
            stats: {
                total_additions: 1,
                total_deletions: 0,
                total_files: 1,
                total_lines_changed: 1,
            },
        },
        codeReviewConfig: { byokConfig: undefined, kodyMemoryRules: [] },
    });

    it('maps a structured analyzer result to violated rules (analyzer site)', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                rules: [
                    {
                        ruleId: 'rule-1',
                        violations: [
                            {
                                violatedFileSha: ['sha1'],
                                relatedFileSha: ['sha2'],
                                oneSentenceSummary: 'Do the thing',
                                suggestionContent:
                                    'Fix it. Kody Rule violation: rule-1',
                            },
                        ],
                    },
                ],
            }),
        );

        const kodyRules = [
            { uuid: 'rule-1', title: 'Rule One', rule: 'do it' },
        ] as any;

        const result = await (service as any).processChunk(
            buildContext(),
            [{ filename: 'a.ts', patch: '@@', status: 'modified' }],
            kodyRules,
            'en-US',
            'gemini-2.5-pro',
            0,
            PR_NUMBER,
            orgData,
            undefined,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(result).toHaveLength(1);
        expect(result[0].uuid).toBe('rule-1');
        expect(result[0].violations[0].suggestionContent).toContain('rule-1');
        expect(result[0].violations[0].oneSentenceSummary).toBe('Do the thing');
    });

    it('returns null when the analyzer reports no violations', async () => {
        mockGenerate.mockResolvedValueOnce(ok({ rules: [] }));

        const result = await (service as any).processChunk(
            buildContext(),
            [{ filename: 'a.ts', patch: '@@', status: 'modified' }],
            [{ uuid: 'rule-1', title: 'Rule One', rule: 'do it' }] as any,
            'en-US',
            'gemini-2.5-pro',
            0,
            PR_NUMBER,
            orgData,
            undefined,
        );

        expect(result).toBeNull();
    });

    it('consolidates duplicate suggestions via the structured grouper (grouper site)', async () => {
        mockGenerate.mockResolvedValueOnce(
            ok({
                ruleId: 'rule-1',
                violations: [
                    {
                        violatedFileSha: ['sha1', 'sha2'],
                        relatedFileSha: [],
                        oneSentenceSummary: 'Grouped summary',
                        suggestionContent: 'Grouped content',
                    },
                ],
            }),
        );

        const rule = { uuid: 'rule-1', title: 'Rule One', rule: 'desc' } as any;
        const duplicated = [
            {
                id: 'a',
                suggestionContent: 'c1',
                oneSentenceSummary: 's1',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-1'],
                deliveryStatus: 'not_sent',
                files: { violatedFileSha: ['sha1'], relatedFileSha: [] },
            },
            {
                id: 'b',
                suggestionContent: 'c2',
                oneSentenceSummary: 's2',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-1'],
                deliveryStatus: 'not_sent',
                files: { violatedFileSha: ['sha2'], relatedFileSha: [] },
            },
        ] as any;

        const grouped = await (service as any).processRuleGrouping(
            rule,
            duplicated,
            'en-US',
            orgData,
            PR_NUMBER,
            undefined,
        );

        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(grouped.suggestionContent).toBe('Grouped content');
        expect(grouped.oneSentenceSummary).toBe('Grouped summary');
        expect(grouped.files.violatedFileSha).toEqual(['sha1', 'sha2']);
    });
});

/**
 * LLM.run I/O contract matrix — full 42-row closure for the two PR-level
 * boundaries in this service:
 *   - analyzer: processChunk → LLM.run(prLevelAnalyzerSchema) → analysis.rules
 *               → processAnalyzerResponse
 *   - grouper:  processRuleGrouping → LLM.run(prLevelGroupSchema) → grouping
 *
 * SCOPE = the deterministic layer only: request assembly (args/schema/system/
 * user/byokConfig threading), envelope parsing, fallback, and the guaranteed
 * return shape. Model decision QUALITY is out of scope (separate eval track).
 *
 * We spy on the REAL LLM.run boundary and restore it after each test, so the
 * parity suite above (which drives the real runStructuredReviewCall over the
 * mocked tracedGenerateText seam) keeps passing untouched.
 *
 * KEY FINDING (the #1786 class): neither boundary does its own envelope
 * recovery. The analyzer reads `analysis.rules` (service ln 1019) with no
 * unwrap/alias/parse, and `processAnalyzerResponse` coerces a non-array to `[]`
 * (ln 333) and skips rule results whose `ruleId`/`violations` keys are absent
 * (ln 353 / ln 384). So any off-schema-but-truthy envelope — bare array, wrapper
 * key, stringified/markdown/prose JSON, renamed keys, {error} envelope, refusal
 * prose — is silently downgraded to "no violations" with no signal. Those rows
 * are pinned as `it.failing` asserting the CORRECT (recover-or-signal) behavior:
 * green today, red the moment recovery lands.
 */
describe('KodyRulesPrLevelAnalysisService — LLM.run I/O contract matrix', () => {
    let service: KodyRulesPrLevelAnalysisService;
    let runSpy: jest.SpyInstance;

    const makeService = () =>
        new KodyRulesPrLevelAnalysisService(
            { findById: jest.fn().mockResolvedValue(null) } as any,
            { chunkDataByTokens: jest.fn() } as any,
            {
                runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
            } as any,
            {
                loadReferencesForRules: jest
                    .fn()
                    .mockResolvedValue({ referencesMap: new Map() }),
            } as any,
        );

    const buildCtx = (byok?: any): any => ({
        pullRequest: {
            title: 't',
            body: 'b',
            user: { login: 'u' },
            tags: [],
            stats: {
                total_additions: 0,
                total_deletions: 0,
                total_files: 0,
                total_lines_changed: 0,
            },
        },
        codeReviewConfig: { byokConfig: byok, kodyMemoryRules: [] },
    });

    const KODY_RULES = [
        { uuid: 'rule-1', title: 'R1', rule: 'do it', severity: 'high' },
    ] as any;

    const oneFile = [{ filename: 'a.ts', patch: '@@', status: 'modified' }];

    const violation = () => ({
        violatedFileSha: ['sha1'],
        relatedFileSha: ['sha2'],
        oneSentenceSummary: 'summary',
        suggestionContent: 'content',
    });

    const exactAnalyzerD = () => ({
        rules: [{ ruleId: 'rule-1', violations: [violation()] }],
    });

    const callAnalyzer = () =>
        (service as any).processChunk(
            buildCtx(),
            oneFile,
            KODY_RULES,
            'en-US',
            'gemini-2.5-pro',
            0,
            42,
            orgData,
            undefined,
        );

    const dupSuggestions = () =>
        [
            {
                id: 'a',
                suggestionContent: 'original-1',
                oneSentenceSummary: 'orig summary 1',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-1'],
                deliveryStatus: 'not_sent',
                severity: 'high',
                files: { violatedFileSha: ['sha1'], relatedFileSha: [] },
            },
            {
                id: 'b',
                suggestionContent: 'original-2',
                oneSentenceSummary: 'orig summary 2',
                label: 'kody_rules',
                brokenKodyRulesIds: ['rule-1'],
                deliveryStatus: 'not_sent',
                severity: 'high',
                files: { violatedFileSha: ['sha2'], relatedFileSha: [] },
            },
        ] as any;

    const rule = { uuid: 'rule-1', title: 'R1', rule: 'desc' } as any;

    const callGrouper = (byok?: any) =>
        (service as any).processRuleGrouping(
            rule,
            dupSuggestions(),
            'en-US',
            orgData,
            42,
            byok,
        );

    beforeEach(() => {
        service = makeService();
        runSpy = jest.spyOn(LLM as any, 'run');
    });

    afterEach(() => {
        runSpy.mockRestore();
    });

    // ───────────────────────── Request assembly ─────────────────────────
    // The deterministic "what goes out": exact schema / system / user /
    // runName / byokConfig threading. (Matrix preamble: "exact args/schema/
    // system/user/byokConfig threading".)
    describe('request assembly (args/schema/system/user/byok threading)', () => {
        it('analyzer threads schema, byokConfig, fixed user turn and runName', async () => {
            const byok = { provider: 'openai', model: 'gpt-4o' } as any;
            runSpy.mockResolvedValue(exactAnalyzerD());

            await (service as any).processChunk(
                buildCtx(byok),
                oneFile,
                KODY_RULES,
                'en-US',
                'gemini-2.5-pro',
                3,
                42,
                orgData,
                undefined,
            );

            expect(runSpy).toHaveBeenCalledTimes(1);
            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(prLevelAnalyzerSchema);
            expect(arg.byokConfig).toBe(byok);
            expect(typeof arg.system).toBe('string');
            expect(arg.user).toBe(
                'Please analyze the provided information and return the response in the specified format',
            );
            expect(arg.runName).toBe(
                `${KodyRulesPrLevelAnalysisService.name}::prLevelKodyRulesAnalyzer`,
            );
            expect(arg.organizationId).toBe(orgData.organizationId);
            expect(arg.attrs.provider).toBe('openai');
            expect(arg.attrs.fallback).toBe(false);
        });

        it('grouper threads the group schema, byokConfig, fixed user turn and runName', async () => {
            const byok = { provider: 'openai', model: 'gpt-4o' } as any;
            runSpy.mockResolvedValue({
                ruleId: 'rule-1',
                violations: [violation()],
            });

            await callGrouper(byok);

            expect(runSpy).toHaveBeenCalledTimes(1);
            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(prLevelGroupSchema);
            expect(arg.byokConfig).toBe(byok);
            expect(arg.user).toBe(
                'Please consolidate the provided violations into a single coherent comment following the instructions.',
            );
            expect(arg.runName).toBe(
                `${KodyRulesPrLevelAnalysisService.name}::prLevelKodyRulesGrouper`,
            );
        });
    });

    // ───────────────────── A. Output-shape zoo ─────────────────────
    describe('A. output-shape zoo (analyzer envelope)', () => {
        // Row 1 — exact D, happy path, exact side effect.
        it('row 1: exact D → maps the violation onto the matched rule', async () => {
            runSpy.mockResolvedValue(exactAnalyzerD());
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
            expect(result[0].uuid).toBe('rule-1');
            expect(result[0].violations).toHaveLength(1);
            expect(result[0].violations[0].suggestionContent).toBe('content');
        });

        // Row 2 — bare array when D is an object. analysis.rules is undefined
        // (ln 1019) → processAnalyzerResponse([]) → null. Real violations dropped.
        it('row 2: bare array of rule-results → SHOULD recover, not drop to null', async () => {
            runSpy.mockResolvedValue([
                { ruleId: 'rule-1', violations: [violation()] },
            ]);
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
            expect(result[0].uuid).toBe('rule-1');
        });

        // Row 3 — single object where an array is expected (inner rules array).
        it.failing(
            'row 3: rules as a single object → SHOULD recover, not coerce to []',
            async () => {
                const result = (service as any).processAnalyzerResponse(
                    KODY_RULES,
                    { ruleId: 'rule-1', violations: [violation()] },
                    oneFile,
                    42,
                    orgData,
                );
                expect(result).toHaveLength(1);
            },
        );

        // Row 4 — wrapper key {result: D}.
        it('row 4: {result: D} wrapper → SHOULD unwrap, not drop to null', async () => {
            runSpy.mockResolvedValue({ result: exactAnalyzerD() });
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
        });

        // Row 5 — double wrapper {result:{result:D}}.
        it('row 5: {result:{result:D}} double wrapper → SHOULD unwrap', async () => {
            runSpy.mockResolvedValue({ result: { result: exactAnalyzerD() } });
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
        });

        // Row 6 — opaque single-key wrap {content: D} / {"0": D}.
        it('row 6: {content: D} opaque wrap → SHOULD unwrap', async () => {
            runSpy.mockResolvedValue({ content: exactAnalyzerD() });
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
        });

        // Row 7 — stringified JSON (classic json_object-fallback shape).
        it('row 7: whole D as a JSON string → SHOULD parse & recover', async () => {
            runSpy.mockResolvedValue(JSON.stringify(exactAnalyzerD()));
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
        });

        // Row 8 — markdown-fenced JSON string.
        it('row 8: markdown-fenced JSON → SHOULD strip fence & recover', async () => {
            runSpy.mockResolvedValue(
                '```json\n' + JSON.stringify(exactAnalyzerD()) + '\n```',
            );
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
        });

        // Row 9 — prose-wrapped JSON.
        it('row 9: prose-wrapped JSON → SHOULD extract & recover', async () => {
            runSpy.mockResolvedValue(
                'Here is the result: ' +
                    JSON.stringify(exactAnalyzerD()) +
                    '\n\nLet me know if you need more.',
            );
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
        });

        // Row 10 — right data, wrong (renamed) keys.
        it.failing(
            'row 10: renamed keys (rule_id/matches) → SHOULD alias, not skip',
            async () => {
                const result = (service as any).processAnalyzerResponse(
                    KODY_RULES,
                    [{ rule_id: 'rule-1', matches: [violation()] }],
                    oneFile,
                    42,
                    orgData,
                );
                expect(result).toHaveLength(1);
            },
        );

        // Row 11 — case/convention mismatch on the violations key.
        it.failing(
            'row 11: case mismatch (Violations) → SHOULD normalize, not skip',
            async () => {
                const result = (service as any).processAnalyzerResponse(
                    KODY_RULES,
                    [{ ruleId: 'rule-1', Violations: [violation()] }],
                    oneFile,
                    42,
                    orgData,
                );
                expect(result).toHaveLength(1);
            },
        );

        // Row 12 — partial object: ruleId present, violations absent → skipped.
        // Correct & observable (a rule with no violations = nothing to report).
        it('row 12: partial (violations absent) → safely skipped → null', async () => {
            const result = (service as any).processAnalyzerResponse(
                KODY_RULES,
                [{ ruleId: 'rule-1' }],
                oneFile,
                42,
                orgData,
            );
            expect(result).toBeNull();
        });

        // Row 13 — extra unknown keys alongside the right ones → tolerated.
        it('row 13: extra unknown keys tolerated, violation still mapped', async () => {
            runSpy.mockResolvedValue({
                rules: [
                    {
                        ruleId: 'rule-1',
                        violations: [{ ...violation(), extra: 'x', n: 123 }],
                        unknownTop: true,
                    },
                ],
                meta: 'ignore-me',
            });
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
            expect(result[0].violations[0].suggestionContent).toBe('content');
        });

        // Row 14 — empty object {} → treated as "no violations" (observable log).
        it('row 14: empty object {} → null (safe no-violations default)', async () => {
            runSpy.mockResolvedValue({});
            const result = await callAnalyzer();
            expect(result).toBeNull();
        });

        // Row 15 — empty array under rules → no violations.
        it('row 15: {rules: []} → null', async () => {
            runSpy.mockResolvedValue({ rules: [] });
            const result = await callAnalyzer();
            expect(result).toBeNull();
        });

        // Row 16 — empty string return → falsy → explicit throw (signal).
        it('row 16: empty-string return → throws (explicit signal, not silent)', async () => {
            runSpy.mockResolvedValue('');
            await expect(callAnalyzer()).rejects.toThrow(
                /No response from LLM/,
            );
        });

        // Row 17 — null/undefined return → falsy → explicit throw (signal).
        it('row 17: null return → throws (explicit signal)', async () => {
            runSpy.mockResolvedValue(null);
            await expect(callAnalyzer()).rejects.toThrow(
                /No response from LLM/,
            );
        });

        // Row 18 — primitive where object expected.
        it('row 18a: falsy primitive 0 → throws (explicit signal)', async () => {
            runSpy.mockResolvedValue(0 as any);
            await expect(callAnalyzer()).rejects.toThrow(
                /No response from LLM/,
            );
        });
        it.failing(
            'row 18b: truthy primitive (true) → SHOULD signal, not silently null',
            async () => {
                runSpy.mockResolvedValue(true as any);
                await expect(callAnalyzer()).rejects.toThrow();
            },
        );

        // Row 19 — provider envelope leak {choices:[{message:{content}}]}.
        it.failing(
            'row 19: provider envelope {choices:[{message:{content}}]} → SHOULD unwrap',
            async () => {
                runSpy.mockResolvedValue({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify(exactAnalyzerD()),
                            },
                        },
                    ],
                });
                const result = await callAnalyzer();
                expect(result).toHaveLength(1);
            },
        );

        // Row 20 — reasoning/thinking leak alongside the payload.
        it.failing(
            'row 20: reasoning leak ({reasoning, text:D}) → SHOULD read the payload',
            async () => {
                runSpy.mockResolvedValue({
                    reasoning: 'let me think about the rules...',
                    text: JSON.stringify(exactAnalyzerD()),
                });
                const result = await callAnalyzer();
                expect(result).toHaveLength(1);
            },
        );
    });

    // ───────────────────── B. Semantic-but-wrong ─────────────────────
    describe('B. semantic-but-wrong', () => {
        // Row 25 — dangling ruleId (no matching stored rule) → skipped w/ log.
        it('row 25: dangling ruleId (not in stored rules) → dropped with signal', async () => {
            runSpy.mockResolvedValue({
                rules: [{ ruleId: 'ghost-rule', violations: [violation()] }],
            });
            const result = await callAnalyzer();
            expect(result).toBeNull();
        });

        // Row 27 — unicode / escaped newlines / emoji preserved intact.
        it('row 27: unicode/emoji/newlines in content preserved end-to-end', async () => {
            const weird = '🚀 café\nlínea 2\t— <ok> é';
            runSpy.mockResolvedValue({
                rules: [
                    {
                        ruleId: 'rule-1',
                        violations: [
                            { ...violation(), suggestionContent: weird },
                        ],
                    },
                ],
            });
            const result = await callAnalyzer();
            expect(result[0].violations[0].suggestionContent).toBe(weird);
        });
    });

    // ───────────────────── C. Unparseable / transport (fail-safe) ─────────────────────
    describe('C. transport / fail-safe', () => {
        const fastBatch = {
            maxConcurrentChunks: 5,
            batchDelay: 0,
            retryAttempts: 1,
            retryDelay: 0,
        };

        // Rows 28 & 29 — truncated / malformed JSON surface as a throw from
        // LLM.run (runStructuredReviewCall parses/validates upstream). The chunk
        // retry wrapper must catch, exhaust retries, and return an error result —
        // never crash past the boundary.
        it.each([
            [
                'row 28: truncated JSON',
                new Error('Unexpected end of JSON input'),
            ],
            ['row 29: malformed JSON', new SyntaxError('Unexpected token }')],
        ])(
            '%s → LLM.run throws → chunk returns error result (fail-safe)',
            async (_label, err) => {
                runSpy.mockRejectedValue(err);
                const res = await (service as any).processChunkWithRetry(
                    oneFile,
                    0,
                    buildCtx(),
                    KODY_RULES,
                    'en-US',
                    'gemini-2.5-pro',
                    42,
                    orgData,
                    { ...fastBatch, retryAttempts: 2 },
                    undefined,
                );
                expect(res.result).toBeNull();
                expect(res.error).toBeInstanceOf(Error);
                expect(runSpy).toHaveBeenCalledTimes(2); // retried
            },
        );

        // Row 30 — LLM.run throws: some chunks succeed, some fail → partial result,
        // no throw. All fail → aggregate throw (documented fail-safe escalation).
        it('row 30: mixed chunk failures → partial result, no crash', async () => {
            runSpy
                .mockResolvedValueOnce(exactAnalyzerD())
                .mockRejectedValueOnce(new Error('network'));
            const res = await (service as any).processChunksInBatches(
                [oneFile, oneFile],
                buildCtx(),
                KODY_RULES,
                'en-US',
                'gemini-2.5-pro',
                42,
                orgData,
                fastBatch,
                undefined,
            );
            expect(res).toHaveLength(1);
            expect(res[0].uuid).toBe('rule-1');
        });

        it('row 30: all chunks fail → aggregate throw (explicit escalation)', async () => {
            runSpy.mockRejectedValue(new Error('boom'));
            await expect(
                (service as any).processChunksInBatches(
                    [oneFile, oneFile],
                    buildCtx(),
                    KODY_RULES,
                    'en-US',
                    'gemini-2.5-pro',
                    42,
                    orgData,
                    fastBatch,
                    undefined,
                ),
            ).rejects.toThrow(/analysis failed in 2\/2 chunks/);
        });

        // Row 31 — {error: ...} envelope instead of throwing. It is truthy, so the
        // `!analysis` guard passes and `.rules` is undefined → silently treated as
        // "no violations". SHOULD detect the error envelope and signal.
        it.failing(
            'row 31: {error} envelope → SHOULD signal, not treat as no-violations',
            async () => {
                runSpy.mockResolvedValue({ error: 'model exploded' });
                await expect(callAnalyzer()).rejects.toThrow();
            },
        );

        // Row 32 — empty-success (content '') → falsy → explicit throw (signal).
        it('row 32: empty-success (empty string) → throws (fail-safe signal)', async () => {
            runSpy.mockResolvedValue('');
            await expect(callAnalyzer()).rejects.toThrow(
                /No response from LLM/,
            );
        });

        // Row 33 — refusal prose. Truthy string, no `.rules` → silently "no
        // violations". SHOULD surface the refusal so it can retry/fallback.
        it.failing(
            'row 33: refusal prose → SHOULD signal, not silently report no findings',
            async () => {
                runSpy.mockResolvedValue(
                    "I'm sorry, I can't help with analyzing this content.",
                );
                await expect(callAnalyzer()).rejects.toThrow();
            },
        );

        // Row 34 — abort. The one-shot review calls do NOT thread an abortSignal
        // (no `signal` field in the LLM.run args); an abort manifests as a
        // rejection, handled by the same fail-safe path (no crash past boundary).
        it('row 34: no abortSignal is threaded, and an abort rejection fails safe', async () => {
            runSpy.mockResolvedValue(exactAnalyzerD());
            await callAnalyzer();
            expect(runSpy.mock.calls[0][0].signal).toBeUndefined();

            const abortErr = Object.assign(new Error('Aborted'), {
                name: 'AbortError',
            });
            runSpy.mockRejectedValue(abortErr);
            const res = await (service as any).processChunkWithRetry(
                oneFile,
                0,
                buildCtx(),
                KODY_RULES,
                'en-US',
                'gemini-2.5-pro',
                42,
                orgData,
                fastBatch,
                undefined,
            );
            expect(res.result).toBeNull();
            expect(res.error?.name).toBe('AbortError');
        });

        // Grouper boundary fail-safe — richest documented fallback path.
        it('grouper: null LLM.run → falls back to first suggestion (safe default)', async () => {
            runSpy.mockResolvedValue(null);
            // null → internal throw → catch fallback preserves the base suggestion.
            const grouped = await callGrouper();
            expect(grouped.suggestionContent).toBe('original-1');
            expect(grouped.brokenKodyRulesIds).toEqual(['rule-1']);
            expect(grouped.files).toEqual({
                violatedFileSha: ['sha1'],
                relatedFileSha: [],
            });
        });

        it('grouper: LLM.run throws → falls back to first suggestion (no crash)', async () => {
            runSpy.mockRejectedValue(new Error('grouper down'));
            const grouped = await callGrouper();
            expect(grouped.suggestionContent).toBe('original-1');
            expect(grouped.severity).toBe('high');
        });

        it('grouper: {violations: []} empty-success → first-suggestion fallback', async () => {
            runSpy.mockResolvedValue({ ruleId: 'rule-1', violations: [] });
            const grouped = await callGrouper();
            expect(grouped.suggestionContent).toBe('original-1');
        });
    });

    // ───────────────────── D. Input variants ─────────────────────
    describe('D. input variants', () => {
        // Row 35 — empty input at multiple layers.
        it('row 35: analyzeCodeWithAI with no changed files → {codeSuggestions: []}', async () => {
            const ctx: any = {
                ...buildCtx(),
                codeReviewConfig: {
                    ...buildCtx().codeReviewConfig,
                    kodyRules: [{ uuid: 'rule-1', scope: 'pull_request' }],
                },
                changedFiles: [],
            };
            const result = await service.analyzeCodeWithAI(
                orgData,
                42,
                [] as any,
                undefined as any,
                ctx,
                undefined,
            );
            expect(result).toEqual({ codeSuggestions: [] });
            expect(runSpy).not.toHaveBeenCalled();
        });

        it('row 35: combineChunkResults([]) → {codeSuggestions: []}', async () => {
            const result = await (service as any).combineChunkResults(
                [],
                KODY_RULES,
                orgData,
                42,
                'en-US',
                undefined,
            );
            expect(result).toEqual({ codeSuggestions: [] });
        });

        // Row 36 — single item.
        it('row 36: single file + single rule → single violated rule', async () => {
            runSpy.mockResolvedValue(exactAnalyzerD());
            const result = await callAnalyzer();
            expect(result).toHaveLength(1);
        });

        // Row 37 — large input crossing the batch boundary (multiple batches).
        it('row 37: chunk count > maxConcurrentChunks → all batches aggregated', async () => {
            runSpy.mockResolvedValue(exactAnalyzerD());
            const chunks = Array.from({ length: 5 }, () => oneFile);
            const res = await (service as any).processChunksInBatches(
                chunks,
                buildCtx(),
                KODY_RULES,
                'en-US',
                'gemini-2.5-pro',
                42,
                orgData,
                {
                    maxConcurrentChunks: 2,
                    batchDelay: 0,
                    retryAttempts: 1,
                    retryDelay: 0,
                },
                undefined,
            );
            expect(runSpy).toHaveBeenCalledTimes(5);
            expect(res).toHaveLength(5);
        });

        // Row 38 — duplicate items in input → merged, not duplicated.
        it('row 38: duplicate rule uuid across chunks → violations merged', async () => {
            const merged = await (service as any).deduplicateViolatedRules([
                { uuid: 'rule-1', violations: [{ suggestionContent: 'v1' }] },
                { uuid: 'rule-1', violations: [{ suggestionContent: 'v2' }] },
            ]);
            expect(merged).toHaveLength(1);
            expect(merged[0].violations).toHaveLength(2);
        });

        // Row 39 — input items with null/undefined required fields.
        it('row 39: null uuid rule is skipped by dedup; null sha → []', async () => {
            const merged = await (service as any).deduplicateViolatedRules([
                { uuid: undefined, violations: [{}] },
                { uuid: 'rule-1', violations: [{}] },
            ]);
            expect(merged).toHaveLength(1);
            expect(merged[0].uuid).toBe('rule-1');

            expect((service as any).normalizeShaList(null)).toEqual([]);
            expect((service as any).normalizeShaList(undefined)).toEqual([]);
            expect((service as any).normalizeShaList('sha')).toEqual(['sha']);
            expect((service as any).normalizeShaList(['a', 'b'])).toEqual([
                'a',
                'b',
            ]);
        });

        it('row 39: violation with null file-sha maps to empty arrays', async () => {
            const suggestions = await (
                service as any
            ).mapViolatedRulesToSuggestions([
                {
                    uuid: 'rule-1',
                    violations: [
                        {
                            violatedFileSha: null,
                            relatedFileSha: undefined,
                            suggestionContent: 'c',
                            oneSentenceSummary: 's',
                        },
                    ],
                },
            ]);
            expect(suggestions).toHaveLength(1);
            expect(suggestions[0].files.violatedFileSha).toEqual([]);
            expect(suggestions[0].files.relatedFileSha).toEqual([]);
        });

        // Row 40 — special chars / huge / whitespace-only content preserved.
        it('row 40: huge + special-char content passes through untruncated', async () => {
            const huge = 'x'.repeat(20000) + ' <binary>\t   ';
            runSpy.mockResolvedValue({
                rules: [
                    {
                        ruleId: 'rule-1',
                        violations: [
                            { ...violation(), suggestionContent: huge },
                        ],
                    },
                ],
            });
            const result = await callAnalyzer();
            expect(result[0].violations[0].suggestionContent).toBe(huge);
        });

        // Row 41 — batch-boundary off-by-one in the config selector.
        it('row 41: determineBatchConfig thresholds (10 / 11 / 50 / 51)', async () => {
            const c10 = (service as any).determineBatchConfig(10);
            expect(c10.maxConcurrentChunks).toBe(10);
            expect(c10.batchDelay).toBe(0);

            const c11 = (service as any).determineBatchConfig(11);
            expect(c11.maxConcurrentChunks).toBe(7);
            expect(c11.batchDelay).toBe(2000);

            const c50 = (service as any).determineBatchConfig(50);
            expect(c50.maxConcurrentChunks).toBe(7);

            const c51 = (service as any).determineBatchConfig(51);
            expect(c51.maxConcurrentChunks).toBe(5);
            expect(c51.batchDelay).toBe(3000);
        });

        // Row 42 — order permutation → equivalent decision (metamorphic).
        it('row 42: dedup is order-independent (same merged violation set)', async () => {
            const a = await (service as any).deduplicateViolatedRules([
                { uuid: 'r1', violations: [{ c: 1 }] },
                { uuid: 'r2', violations: [{ c: 2 }] },
                { uuid: 'r1', violations: [{ c: 3 }] },
            ]);
            const b = await (service as any).deduplicateViolatedRules([
                { uuid: 'r1', violations: [{ c: 3 }] },
                { uuid: 'r2', violations: [{ c: 2 }] },
                { uuid: 'r1', violations: [{ c: 1 }] },
            ]);
            const norm = (rules: any[]) =>
                rules
                    .map((r) => ({
                        uuid: r.uuid,
                        set: r.violations
                            .map((v: any) => v.c)
                            .sort((x: number, y: number) => x - y),
                    }))
                    .sort((x, y) => x.uuid.localeCompare(y.uuid));
            expect(norm(a)).toEqual(norm(b));
        });

        it('row 42: groupSuggestionsByRule is order-independent', async () => {
            const s1 = { brokenKodyRulesIds: ['r1'] };
            const s2 = { brokenKodyRulesIds: ['r1', 'r2'] };
            const g1 = (service as any).groupSuggestionsByRule([s1, s2]);
            const g2 = (service as any).groupSuggestionsByRule([s2, s1]);
            expect(Object.keys(g1).sort()).toEqual(Object.keys(g2).sort());
            expect(g1['r1']).toHaveLength(2);
            expect(g2['r1']).toHaveLength(2);
        });
    });

    // ───────────────────── E. Provider / model matrix ─────────────────────
    // This boundary DELEGATES model policy to LLM.run (structured-output-gate):
    // it never branches on provider — byokConfig is threaded through verbatim and
    // the parse behavior is identical whether the slot is a strict json_schema
    // provider (openai) or a json_object-fallback provider (kimi/moonshotai).
    // We run representative A/B/C rows under both branches and assert identical
    // outcomes + faithful threading.
    describe('E. provider policy branches (delegated, identical handling)', () => {
        const STRICT = { provider: 'openai', model: 'gpt-4o' } as any;
        const FALLBACK = { provider: 'moonshotai', model: 'kimi-k2' } as any;

        it.each([
            ['strict json_schema (openai)', STRICT],
            ['json_object fallback (kimi/moonshotai)', FALLBACK],
        ])(
            '%s: happy D handled identically + byok threaded',
            async (_l, byok) => {
                runSpy.mockResolvedValue(exactAnalyzerD());
                const result = await (service as any).processChunk(
                    buildCtx(byok),
                    oneFile,
                    KODY_RULES,
                    'en-US',
                    'gemini-2.5-pro',
                    0,
                    42,
                    orgData,
                    undefined,
                );
                expect(result).toHaveLength(1);
                expect(runSpy.mock.calls[0][0].byokConfig).toBe(byok);
                expect(runSpy.mock.calls[0][0].attrs.provider).toBe(
                    byok.provider,
                );
            },
        );

        it.each([
            ['strict json_schema (openai)', STRICT],
            ['json_object fallback (kimi/moonshotai)', FALLBACK],
        ])(
            '%s: off-schema bare array is RECOVERED the SAME way (no per-provider branch)',
            async (_l, byok) => {
                runSpy.mockResolvedValue([
                    { ruleId: 'rule-1', violations: [violation()] },
                ]);
                const result = await (service as any).processChunk(
                    buildCtx(byok),
                    oneFile,
                    KODY_RULES,
                    'en-US',
                    'gemini-2.5-pro',
                    0,
                    42,
                    orgData,
                    undefined,
                );
                // The SHAPE fix (normalizeEnvelope) is model-agnostic: a bare
                // array is lifted to {rules:[…]} and recovered identically under
                // the strict-json_schema and json_object-fallback slots (#1786).
                expect(result).toHaveLength(1);
            },
        );

        it.each([
            ['strict json_schema (openai)', STRICT],
            ['json_object fallback (kimi/moonshotai)', FALLBACK],
        ])('%s: LLM.run throw fails safe identically', async (_l, byok) => {
            runSpy.mockRejectedValue(new Error('boom'));
            await expect(
                (service as any).processChunk(
                    buildCtx(byok),
                    oneFile,
                    KODY_RULES,
                    'en-US',
                    'gemini-2.5-pro',
                    0,
                    42,
                    orgData,
                    undefined,
                ),
            ).rejects.toThrow('boom');
        });
    });

    // ───────────────────── Return-shape invariant (all layers) ─────────────────────
    describe('declared return shape is always honored', () => {
        it('analyzeCodeWithAI returns {codeSuggestions: []} on every early guard', async () => {
            // missing codeReviewConfig
            expect(
                await service.analyzeCodeWithAI(
                    orgData,
                    42,
                    [] as any,
                    undefined as any,
                    {} as any,
                    undefined,
                ),
            ).toEqual({ codeSuggestions: [] });

            // kodyRules not an array
            expect(
                await service.analyzeCodeWithAI(
                    orgData,
                    42,
                    [] as any,
                    undefined as any,
                    { codeReviewConfig: { kodyRules: 'nope' } } as any,
                    undefined,
                ),
            ).toEqual({ codeSuggestions: [] });

            // no PR-level scoped rules
            expect(
                await service.analyzeCodeWithAI(
                    orgData,
                    42,
                    [] as any,
                    undefined as any,
                    {
                        codeReviewConfig: {
                            kodyRules: [{ uuid: 'x', scope: 'file' }],
                        },
                        changedFiles: [{ filename: 'a.ts' }],
                    } as any,
                    undefined,
                ),
            ).toEqual({ codeSuggestions: [] });
        });

        it('processChunk returns ExtendedKodyRule[] | null (never undefined)', async () => {
            runSpy.mockResolvedValue({ rules: [] });
            const r = await callAnalyzer();
            expect(r).toBeNull();
        });

        it('processRuleGrouping always returns a well-formed ISuggestionByPR', async () => {
            runSpy.mockResolvedValue({
                ruleId: 'rule-1',
                violations: [violation()],
            });
            const grouped = await callGrouper();
            expect(grouped).toEqual(
                expect.objectContaining({
                    id: expect.any(String),
                    label: expect.anything(),
                    brokenKodyRulesIds: expect.any(Array),
                    files: expect.objectContaining({
                        violatedFileSha: expect.any(Array),
                        relatedFileSha: expect.any(Array),
                    }),
                }),
            );
        });
    });
});

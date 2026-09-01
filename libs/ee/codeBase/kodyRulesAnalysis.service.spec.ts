// Parity spec for the kody-rules analysis service AFTER its migration off the
// LangChain BYOKPromptRunner onto `runStructuredReviewCall` (Phase 3,
// plan 03-04). The whole point is that the migrated service produces the SAME
// analysis output it did before, on the org's BYOK model, with exactly ONE
// span per call (the old outer `runLLMInSpan` wrapper is gone).
//
// The LLM boundary is mocked at `runStructuredReviewCall` — the same seam the
// sibling migrations use (kodyRulesSync.service.spec.ts). Driving the real
// `runStructuredReviewCall` over `MockLanguageModelV4` HANGS on the structured
// `Output.object` path (Phase 0 + 03-01 finding), so we assert on the mocked
// seam instead; the real MockLanguageModelV4 → SDK → normalize boundary is
// proven by 03-01's conformance harness.
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: jest.fn(),
}));

import { validate as uuidValidate } from 'uuid';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import { KodyRulesAnalysisService } from './kodyRulesAnalysis.service';

const mockRun = runStructuredReviewCall as jest.Mock;

const ORG = { organizationId: 'org-1', teamId: 'team-1' } as any;
const BYOK = { main: { provider: 'openai', model: 'gpt-4o' } } as any;

const GEN_UUID = '9de28bd7-a06d-429a-97ab-02e5fef91096';

// A generator suggestion shaped like kodyRulesGeneratorSchema output.
const GEN_SUGGESTION = {
    id: GEN_UUID,
    relevantFile: 'src/f.ts',
    language: 'typescript',
    suggestionContent: 'bad',
    existingCode: 'a',
    improvedCode: 'b',
    oneSentenceSummary: 's',
    relevantLinesStart: 1,
    relevantLinesEnd: 2,
    label: 'kody_rules',
    severity: 'high',
    brokenKodyRulesIds: ['r1'],
};

/** Route the mocked structured call by runName, mirroring the 4 real calls. */
const routeByRunName = async ({ runName }: any) => {
    if (runName.endsWith('::classifierKodyRulesAnalyzeCodeWithAI')) {
        return { rules: [{ uuid: 'r1', reason: 'violates r1' }] };
    }
    if (runName.endsWith('::suggestionGenerationKodyRulesAnalyzeCodeWithAI')) {
        return { codeSuggestions: [GEN_SUGGESTION] };
    }
    if (runName.endsWith('::updateStandardSuggestionsAnalyzeCodeWithAI')) {
        return { codeSuggestions: [] };
    }
    if (runName.endsWith('::extractKodyRuleIdsFromContent')) {
        return { ids: [] };
    }
    return {};
};

const makeService = () => {
    const kodyRulesService = { findById: jest.fn().mockResolvedValue(null) };
    const codeBaseConfigService = {
        getDirectoryIdForPath: jest.fn().mockResolvedValue(undefined),
    };
    const kodyRulesValidationService = {
        getKodyRulesForFile: jest
            .fn()
            .mockReturnValue([
                { uuid: 'r1', title: 'R1', rule: 'do x', severity: 'high' },
            ]),
    };
    // runLLMInSpan MUST NOT be called — the migration drops the outer wrapper
    // (Q4 / T-03-09). runStructuredReviewCall is mocked, so no AI-SDK span runs.
    const observabilityService = { runLLMInSpan: jest.fn() };
    const externalReferenceLoaderService = {
        loadReferencesForRules: jest
            .fn()
            .mockResolvedValue({ referencesMap: new Map() }),
    };

    const service = new (KodyRulesAnalysisService as any)(
        kodyRulesService,
        codeBaseConfigService,
        kodyRulesValidationService,
        observabilityService,
        externalReferenceLoaderService,
    );

    return {
        service,
        kodyRulesService,
        kodyRulesValidationService,
        observabilityService,
    };
};

describe('KodyRulesAnalysisService — runStructuredReviewCall migration parity', () => {
    beforeEach(() => {
        mockRun.mockReset();
        mockRun.mockImplementation(routeByRunName);
    });

    describe('analyzeCodeWithAI — primary analysis path', () => {
        const fileContext = {
            file: { filename: 'src/f.ts', fileContent: 'code' },
            patchWithLinesStr: '+ const x = 1;',
        } as any;

        const context = {
            organizationAndTeamData: ORG,
            pullRequest: { number: 42 },
            repository: { id: 'repo-1', name: 'repo', language: 'typescript' },
            codeReviewConfig: {
                kodyRules: [{ uuid: 'r1', title: 'R1', severity: 'high' }],
                byokConfig: BYOK,
            },
        } as any;

        it('maps classifier + generator structured results to the same analysis output', async () => {
            const { service } = makeService();

            const result = await service.analyzeCodeWithAI(
                ORG,
                42,
                fileContext,
                undefined as any,
                context,
                undefined,
            );

            expect(result.codeSuggestions).toHaveLength(1);
            const [suggestion] = result.codeSuggestions;
            expect(suggestion.id).toBe(GEN_UUID);
            expect(suggestion.brokenKodyRulesIds).toEqual(['r1']);
            // Severity is resolved from the matching kody rule (severity 'high').
            expect(suggestion.severity).toBe('high');
        });

        it('runs the classifier and generator on the AI SDK path (BYOK threaded, exactly one span each)', async () => {
            const { service, observabilityService } = makeService();

            await service.analyzeCodeWithAI(
                ORG,
                42,
                fileContext,
                undefined as any,
                context,
                undefined,
            );

            // No suggestions passed → updater skipped; classifier + generator only.
            expect(mockRun).toHaveBeenCalledTimes(2);

            const runNames = mockRun.mock.calls.map((c) => c[0].runName);
            expect(runNames).toEqual([
                `${KodyRulesAnalysisService.name}::classifierKodyRulesAnalyzeCodeWithAI`,
                `${KodyRulesAnalysisService.name}::suggestionGenerationKodyRulesAnalyzeCodeWithAI`,
            ]);

            // BYOK config threaded into every call (observability is owned by
            // LLM.run internally, so it is no longer a call arg).
            for (const call of mockRun.mock.calls) {
                expect(call[0].byokConfig).toBe(BYOK);
                expect(call[0].organizationId).toBe(ORG.organizationId);
                expect(typeof call[0].system).toBe('string');
                expect(typeof call[0].user).toBe('string');
            }

            // The dropped outer wrapper: legacy runLLMInSpan is never called.
            expect(observabilityService.runLLMInSpan).not.toHaveBeenCalled();
        });

        it('short-circuits to empty suggestions when the classifier returns no rules', async () => {
            mockRun.mockImplementation(async ({ runName }: any) => {
                if (runName.endsWith('::classifierKodyRulesAnalyzeCodeWithAI')) {
                    return { rules: [] };
                }
                return routeByRunName({ runName });
            });

            const { service } = makeService();

            const result = await service.analyzeCodeWithAI(
                ORG,
                42,
                fileContext,
                undefined as any,
                context,
                undefined,
            );

            expect(result).toEqual({ codeSuggestions: [] });
            // Generator never runs after an empty classification.
            const runNames = mockRun.mock.calls.map((c) => c[0].runName);
            expect(runNames).not.toContain(
                `${KodyRulesAnalysisService.name}::suggestionGenerationKodyRulesAnalyzeCodeWithAI`,
            );
        });
    });

    describe('extractKodyRuleIdsFromContent — structured ID extraction', () => {
        it('returns ids from the structured result and threads BYOK/observability', async () => {
            mockRun.mockResolvedValueOnce({ ids: ['id-a', 'id-b'] });
            const { service } = makeService();

            const ids = await (service as any).extractKodyRuleIdsFromContent(
                'some content',
                ORG,
                7,
                { id: 'sugg-1' },
                BYOK,
            );

            expect(ids).toEqual(['id-a', 'id-b']);
            expect(mockRun).toHaveBeenCalledTimes(1);
            const call = mockRun.mock.calls[0][0];
            expect(call.runName).toBe(
                `${KodyRulesAnalysisService.name}::extractKodyRuleIdsFromContent`,
            );
            expect(call.byokConfig).toBe(BYOK);
            expect(call.organizationId).toBe(ORG.organizationId);
        });

        it('returns [] when no ids are extracted', async () => {
            mockRun.mockResolvedValueOnce({ ids: [] });
            const { service } = makeService();

            const ids = await (service as any).extractKodyRuleIdsFromContent(
                'no ids here',
                ORG,
                7,
                { id: 'sugg-1' },
                BYOK,
            );

            expect(ids).toEqual([]);
        });
    });

    describe('runUpdater — preserves the JSON-string contract for processUpdatedSuggestions', () => {
        it('re-serializes the structured result to a JSON string', async () => {
            const structured = {
                codeSuggestions: [
                    { id: 'u1', suggestionContent: 'x', violatedKodyRulesIds: ['r9'] },
                ],
            };
            mockRun.mockResolvedValueOnce(structured);
            const { service } = makeService();

            const out = await (service as any).runUpdater(
                { organizationAndTeamData: ORG } as any,
                BYOK,
                ORG.organizationId,
                3,
            );

            expect(typeof out).toBe('string');
            expect(JSON.parse(out)).toEqual(structured);
        });
    });
});

// ===========================================================================
// LLM.run I/O CONTRACT MATRIX — kodyRulesAnalysis.service
//
// Scope = the DETERMINISTIC parse/assembly/fallback layer around the 4 LLM.run
// sites, NOT model decision quality (that is the eval track):
//   - runClassifier  (schema kodyRulesClassifierSchema {rules:[{uuid,reason}]})
//        parsed by processClassifierResponse(allRules, response)
//   - runGenerator   (schema kodyRulesGeneratorSchema {codeSuggestions:[...]})
//        parsed by processLLMResponse(...)
//   - runUpdater     (schema kodyRulesUpdateSchema) -> JSON.stringify -> STRING
//        parsed by processUpdatedSuggestions(response: string) via tryParseJSONObject
//   - extractKodyRuleIdsFromContent (schema kodyRulesExtractIdSchema {ids:[]})
//        consumed inline (extraction?.ids)
//
// The object-consuming parse layers (classifier/generator/extract) receive an
// OBJECT from runStructuredReviewCall, so the STRING zoo (markdown/prose/
// truncated/malformed) is exercised on the updater's tryParseJSONObject layer;
// the OBJECT zoo (bare-array/wrapper/wrong-keys/primitive) is exercised on the
// object layers.
//
// #1786 non-degradation rule: for an off-schema row the boundary must RECOVER or
// SIGNAL (throw / null+error-log). Where prod SILENTLY drops present-but-misshaped
// data with no honest signal (a misleading "no rules"/empty), the CORRECT
// behavior is pinned with it.failing (green today, red once prod recovers), and
// the source line is recorded in knownDegradations.
// ===========================================================================

const FILE_CTX = { file: { filename: 'src/f.ts', fileContent: 'code' } } as any;
const PROVIDER = 'test-provider' as any;

/** A generator-shaped suggestion whose id IS a valid uuid (so it is preserved). */
const genSuggestion = (over: Record<string, any> = {}) => ({
    id: GEN_UUID,
    relevantFile: 'src/f.ts',
    language: 'typescript',
    suggestionContent: 'bad',
    existingCode: 'a',
    improvedCode: 'b',
    oneSentenceSummary: 's',
    relevantLinesStart: 1,
    relevantLinesEnd: 2,
    label: 'kody_rules',
    severity: 'high',
    ...over,
});

const callProcessLLM = (service: any, response: any, extendedContext: any = {}) =>
    service.processLLMResponse(ORG, 1, response, FILE_CTX, PROVIDER, extendedContext);

const callProcessUpdate = (service: any, response: any) =>
    service.processUpdatedSuggestions(ORG, 1, response, FILE_CTX, PROVIDER, {});

const callProcessClassifier = (service: any, allRules: any, response: any) =>
    service.processClassifierResponse(allRules, response);

// ---------------------------------------------------------------------------
// A. OUTPUT-SHAPE ZOO — classifier parse layer (processClassifierResponse)
//    D = { rules: [{ uuid, reason }] }  → returns filtered rule array | null
// ---------------------------------------------------------------------------
describe('A. output-shape zoo — processClassifierResponse (classifier D)', () => {
    const RULES = [{ uuid: 'r1', title: 'R1', severity: 'high' }];

    it('row 1 — exact D: maps the reason onto the matching input rule', () => {
        const { service } = makeService();
        const out = callProcessClassifier(service, RULES, {
            rules: [{ uuid: 'r1', reason: 'because' }],
        });
        expect(out).toHaveLength(1);
        expect(out[0].reason).toBe('because');
        expect(out[0].uuid).toBe('r1');
    });

    it('row 12 — partial object (rule without reason) is tolerated', () => {
        const { service } = makeService();
        const out = callProcessClassifier(service, RULES, {
            rules: [{ uuid: 'r1' }],
        });
        expect(out).toHaveLength(1);
        expect(out[0].reason).toBeUndefined();
    });

    it('row 13 — extra unknown keys are ignored, not crashed on', () => {
        const { service } = makeService();
        const out = callProcessClassifier(service, RULES, {
            rules: [{ uuid: 'r1', reason: 'x', confidence: 0.9 }],
            meta: { note: 'ignore me' },
        } as any);
        expect(out).toHaveLength(1);
        expect(out[0].reason).toBe('x');
    });

    it('row 14 — empty object {} → null (no rules found)', () => {
        const { service } = makeService();
        expect(callProcessClassifier(service, RULES, {} as any)).toBeNull();
    });

    it('row 15 — empty array {rules:[]} → null (no rules found)', () => {
        const { service } = makeService();
        expect(callProcessClassifier(service, RULES, { rules: [] })).toBeNull();
    });

    it('row 17 — null / undefined → null (fail-safe)', () => {
        const { service } = makeService();
        expect(callProcessClassifier(service, RULES, null as any)).toBeNull();
        expect(
            callProcessClassifier(service, RULES, undefined as any),
        ).toBeNull();
    });

    it('row 18 — primitive where object expected → null (fail-safe)', () => {
        const { service } = makeService();
        expect(callProcessClassifier(service, RULES, true as any)).toBeNull();
        expect(callProcessClassifier(service, RULES, 0 as any)).toBeNull();
        expect(callProcessClassifier(service, RULES, 'ok' as any)).toBeNull();
    });

    it('row 25 — dangling reference (uuid not in input) → dropped to [] (no false match)', () => {
        const { service } = makeService();
        const out = callProcessClassifier(service, RULES, {
            rules: [{ uuid: 'ghost-uuid', reason: 'x' }],
        });
        expect(out).toEqual([]);
    });

    // ---- #1786 silent-degradation guards (correct behavior pinned) ----------

    // row 2: real rules arrive as a BARE ARRAY (not {rules:[]}); prod reads
    // response.rules === undefined → returns null and logs the misleading
    // "No rules found" → violations silently dropped.
    // Source: kodyRulesAnalysis.service.ts:822 (`!response.rules?.length`).
    it.failing(
        'row 2 — bare array of rules should be RECOVERED, not silently dropped (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessClassifier(service, RULES, [
                { uuid: 'r1', reason: 'because' },
            ] as any);
            expect(out).toHaveLength(1);
            expect(out[0].uuid).toBe('r1');
        },
    );

    // row 4: wrapper key {result:{rules:[...]}} — same silent drop.
    // Source: kodyRulesAnalysis.service.ts:822.
    it.failing(
        'row 4 — {result:{rules:[...]}} wrapper should be unwrapped, not dropped (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessClassifier(service, RULES, {
                result: { rules: [{ uuid: 'r1', reason: 'x' }] },
            } as any);
            expect(out).toHaveLength(1);
        },
    );

    // row 5: double wrapper {result:{result:{rules:[...]}}} — same silent drop.
    it.failing(
        'row 5 — double-wrapped rules should be unwrapped, not dropped (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessClassifier(service, RULES, {
                result: { result: { rules: [{ uuid: 'r1', reason: 'x' }] } },
            } as any);
            expect(out).toHaveLength(1);
        },
    );

    // row 10: right data, renamed key {ruleViolations:[...]} — silent drop.
    // Source: kodyRulesAnalysis.service.ts:822.
    it.failing(
        'row 10 — renamed key (ruleViolations) should be aliased, not dropped (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessClassifier(service, RULES, {
                ruleViolations: [{ uuid: 'r1', reason: 'x' }],
            } as any);
            expect(out).toHaveLength(1);
        },
    );
});

// ---------------------------------------------------------------------------
// A. OUTPUT-SHAPE ZOO — generator parse layer (processLLMResponse)
//    D = { codeSuggestions: [...] }  → returns { codeSuggestions } | null
// ---------------------------------------------------------------------------
describe('A. output-shape zoo — processLLMResponse (generator D)', () => {
    it('row 1 — exact D: preserves a valid suggestion and its id', () => {
        const { service } = makeService();
        const out = callProcessLLM(service, {
            codeSuggestions: [genSuggestion()],
        });
        expect(out.codeSuggestions).toHaveLength(1);
        expect(out.codeSuggestions[0].id).toBe(GEN_UUID);
    });

    it('row 12 — partial suggestion (missing id) gets a generated uuid', () => {
        const { service } = makeService();
        const out = callProcessLLM(service, {
            codeSuggestions: [{ suggestionContent: 'x' }],
        });
        expect(out.codeSuggestions).toHaveLength(1);
        expect(uuidValidate(out.codeSuggestions[0].id)).toBe(true);
    });

    it('row 13 — extra unknown keys tolerated (suggestion preserved)', () => {
        const { service } = makeService();
        const out = callProcessLLM(service, {
            codeSuggestions: [genSuggestion({ mysteryKey: 42 })],
            topLevelJunk: true,
        });
        expect(out.codeSuggestions).toHaveLength(1);
        expect(out.codeSuggestions[0].mysteryKey).toBe(42);
    });

    it('row 14 — empty object {} → typed-empty { codeSuggestions: [] }', () => {
        const { service } = makeService();
        expect(callProcessLLM(service, {})).toEqual({ codeSuggestions: [] });
    });

    it('row 17 — null → null (fail-safe)', () => {
        const { service } = makeService();
        expect(callProcessLLM(service, null)).toBeNull();
    });

    it('row 18 — primitives: 0 → null, true → typed-empty', () => {
        const { service } = makeService();
        expect(callProcessLLM(service, 0)).toBeNull();
        expect(callProcessLLM(service, true)).toEqual({ codeSuggestions: [] });
    });

    // ---- #1786 silent-degradation guards ------------------------------------

    // row 2: bare array of suggestions → response.codeSuggestions undefined →
    // typed-empty ships silently (no log). Source: kodyRulesAnalysis.service.ts:894/931.
    it.failing(
        'row 2 — bare array of suggestions should be RECOVERED, not emptied (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessLLM(service, [genSuggestion()] as any);
            expect(out.codeSuggestions).toHaveLength(1);
        },
    );

    // row 3: single object where an array is expected → .map throws → caught →
    // null; the suggestion is dropped. Source: kodyRulesAnalysis.service.ts:895.
    it.failing(
        'row 3 — single suggestion object should be normalized to a 1-item array (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessLLM(service, {
                codeSuggestions: genSuggestion() as any,
            });
            expect(out.codeSuggestions).toHaveLength(1);
        },
    );

    // row 6: opaque single-key wrap {content:{codeSuggestions:[...]}} → emptied.
    it.failing(
        'row 6 — {content:{codeSuggestions:[...]}} wrap should be unwrapped, not emptied (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessLLM(service, {
                content: { codeSuggestions: [genSuggestion()] },
            } as any);
            expect(out.codeSuggestions).toHaveLength(1);
        },
    );

    // row 11: case/convention mismatch {CodeSuggestions:[...]} → emptied silently.
    it.failing(
        'row 11 — case-mismatched key (CodeSuggestions) should be matched, not emptied (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessLLM(service, {
                CodeSuggestions: [genSuggestion()],
            } as any);
            expect(out.codeSuggestions).toHaveLength(1);
        },
    );

    // row 19: provider envelope leak {choices:[{message:{content}}]} → emptied.
    it.failing(
        'row 19 — provider envelope {choices:[{message:{content}}]} should be unwrapped, not emptied (#1786)',
        () => {
            const { service } = makeService();
            const out = callProcessLLM(service, {
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                codeSuggestions: [genSuggestion()],
                            }),
                        },
                    },
                ],
            } as any);
            expect(out.codeSuggestions).toHaveLength(1);
        },
    );
});

// ---------------------------------------------------------------------------
// A. OUTPUT-SHAPE ZOO (string layer) — processUpdatedSuggestions
//    Receives a STRING (runUpdater re-serializes); parses via tryParseJSONObject.
// ---------------------------------------------------------------------------
describe('A/C. string parse zoo — processUpdatedSuggestions (updater D)', () => {
    it('row 7 — stringified JSON is parsed (the real updater contract)', () => {
        const { service } = makeService();
        const out = callProcessUpdate(
            service,
            JSON.stringify({
                codeSuggestions: [
                    { id: 'not-a-uuid', suggestionContent: 'x' },
                ],
            }),
        );
        expect(out.codeSuggestions).toHaveLength(1);
        expect(uuidValidate(out.codeSuggestions[0].id)).toBe(true);
        expect(out.codeSuggestions[0].suggestionContent).toBe('x');
    });

    it('row 8 — markdown-fenced JSON is stripped and recovered', () => {
        const { service } = makeService();
        const out = callProcessUpdate(
            service,
            '```json\n' +
                JSON.stringify({
                    codeSuggestions: [{ suggestionContent: 'fenced' }],
                }) +
                '\n```',
        );
        expect(out.codeSuggestions).toHaveLength(1);
        expect(out.codeSuggestions[0].suggestionContent).toBe('fenced');
    });

    it('row 14 — "{}" → typed-empty { codeSuggestions: [] }', () => {
        const { service } = makeService();
        expect(callProcessUpdate(service, '{}')).toEqual({
            codeSuggestions: [],
        });
    });

    it('row 16 — empty / whitespace-only string → null (fail-safe)', () => {
        const { service } = makeService();
        expect(callProcessUpdate(service, '')).toBeNull();
        expect(callProcessUpdate(service, '   ')).toBeNull();
    });

    it('row 17 — null / undefined string → null (fail-safe)', () => {
        const { service } = makeService();
        expect(callProcessUpdate(service, null as any)).toBeNull();
        expect(callProcessUpdate(service, undefined as any)).toBeNull();
    });

    it('row 20 — reasoning/thinking leak before JSON → null (documented fallback, logged)', () => {
        const { service } = makeService();
        const out = callProcessUpdate(
            service,
            '<thinking>let me reason</thinking>' +
                JSON.stringify({ codeSuggestions: [{ suggestionContent: 'x' }] }),
        );
        expect(out).toBeNull();
    });

    it('row 26 — duplicate JSON keys resolve last-wins (JSON5/JSON semantics)', () => {
        const { service } = makeService();
        const out = callProcessUpdate(
            service,
            '{"codeSuggestions":[],"codeSuggestions":[{"suggestionContent":"z"}]}',
        );
        expect(out.codeSuggestions).toHaveLength(1);
        expect(out.codeSuggestions[0].suggestionContent).toBe('z');
    });

    it('row 27 — unicode / emoji inside string fields is preserved', () => {
        const { service } = makeService();
        const out = callProcessUpdate(
            service,
            JSON.stringify({
                codeSuggestions: [{ suggestionContent: 'héllo 🎉 world' }],
            }),
        );
        expect(out.codeSuggestions).toHaveLength(1);
        expect(out.codeSuggestions[0].suggestionContent).toContain('🎉');
    });

    it('row 28 — truncated JSON (max_tokens) → null (documented fallback, logged)', () => {
        const { service } = makeService();
        expect(
            callProcessUpdate(service, '{"codeSuggestions":[{"id":"u1"'),
        ).toBeNull();
    });

    it('row 29 — malformed-but-lenient JSON (unquoted keys / single quotes / trailing comma) is recovered by JSON5', () => {
        const { service } = makeService();
        const out = callProcessUpdate(
            service,
            "{codeSuggestions:[{id:'u1',suggestionContent:'x',}]}",
        );
        expect(out.codeSuggestions).toHaveLength(1);
        expect(out.codeSuggestions[0].suggestionContent).toBe('x');
    });

    it('row 9 — prose-wrapped JSON → null (documented fallback, logged)', () => {
        const { service } = makeService();
        expect(
            callProcessUpdate(
                service,
                'Here is the result: {"codeSuggestions":[{"id":"x"}]}',
            ),
        ).toBeNull();
    });

    it('row 33 — refusal prose ("I cannot help") → null (documented fallback, logged)', () => {
        const { service } = makeService();
        expect(
            callProcessUpdate(service, 'I cannot help with that request.'),
        ).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// A/C. OUTPUT-SHAPE ZOO + transport — extractKodyRuleIdsFromContent
//    Schema { ids: string[] }; consumed as extraction?.ids; catch → [].
//    LLM boundary mocked at runStructuredReviewCall (mockRun).
// ---------------------------------------------------------------------------
describe('A/C. extractKodyRuleIdsFromContent boundary ({ids} D)', () => {
    beforeEach(() => {
        mockRun.mockReset();
        mockRun.mockImplementation(routeByRunName);
    });

    const callExtract = (service: any) =>
        service.extractKodyRuleIdsFromContent(
            'content',
            ORG,
            7,
            { id: 'sugg-1' },
            BYOK,
        );

    it('row 1 — exact D {ids:[...]} → returns the ids', async () => {
        mockRun.mockResolvedValueOnce({ ids: ['a', 'b'] });
        const { service } = makeService();
        expect(await callExtract(service)).toEqual(['a', 'b']);
    });

    it('row 14/15/32 — {} and {ids:[]} (empty success) → [] (typed-empty)', async () => {
        const { service } = makeService();
        mockRun.mockResolvedValueOnce({});
        expect(await callExtract(service)).toEqual([]);
        mockRun.mockResolvedValueOnce({ ids: [] });
        expect(await callExtract(service)).toEqual([]);
    });

    it('row 17 — null return → [] (fail-safe)', async () => {
        mockRun.mockResolvedValueOnce(null);
        const { service } = makeService();
        expect(await callExtract(service)).toEqual([]);
    });

    it('row 31 — {error:...} object instead of throw → [] (fail-safe)', async () => {
        mockRun.mockResolvedValueOnce({ error: 'model exploded' } as any);
        const { service } = makeService();
        expect(await callExtract(service)).toEqual([]);
    });

    it('row 30 — LLM.run throws (network) → [] (never crashes the caller)', async () => {
        mockRun.mockRejectedValueOnce(new Error('ECONNRESET'));
        const { service } = makeService();
        expect(await callExtract(service)).toEqual([]);
    });

    it('row 34 — abort signal fired mid-call → [] (fail-safe)', async () => {
        const abortErr = Object.assign(new Error('aborted'), {
            name: 'AbortError',
        });
        mockRun.mockRejectedValueOnce(abortErr);
        const { service } = makeService();
        expect(await callExtract(service)).toEqual([]);
    });

    // ---- #1786 silent-degradation guards ------------------------------------

    // row 2: ids arrive as a BARE ARRAY → extraction.ids undefined → [] with a
    // misleading "No Kody Rule IDs extracted" warn. Source: kodyRulesAnalysis.service.ts:344.
    it.failing(
        'row 2 — bare array of ids should be RECOVERED, not dropped (#1786)',
        async () => {
            mockRun.mockResolvedValueOnce(['id-a', 'id-b'] as any);
            const { service } = makeService();
            expect(await callExtract(service)).toEqual(['id-a', 'id-b']);
        },
    );

    // row 3: ids as a single string → `extraction.ids.length` (string length) is
    // truthy → the STRING is returned instead of a string[], breaking the
    // declared return type silently. Source: kodyRulesAnalysis.service.ts:344-345.
    it.failing(
        'row 3 — a single string id should be wrapped into a string[], not returned raw (#1786)',
        async () => {
            mockRun.mockResolvedValueOnce({ ids: 'abc' } as any);
            const { service } = makeService();
            const out = await callExtract(service);
            expect(Array.isArray(out)).toBe(true);
        },
    );

    // row 4: wrapper {result:{ids:[...]}} → dropped to [].
    it.failing(
        'row 4 — {result:{ids:[...]}} wrapper should be unwrapped, not dropped (#1786)',
        async () => {
            mockRun.mockResolvedValueOnce({ result: { ids: ['x'] } } as any);
            const { service } = makeService();
            expect(await callExtract(service)).toEqual(['x']);
        },
    );
});

// ---------------------------------------------------------------------------
// B. SEMANTIC-BUT-WRONG (valid JSON, wrong value encoding)
// ---------------------------------------------------------------------------
describe('B. semantic-but-wrong value encodings', () => {
    it('row 24 — severity outside the allowed set passes the parse layer untouched (severity is z.string, not an enum)', () => {
        const { service } = makeService();
        const out = callProcessLLM(service, {
            codeSuggestions: [genSuggestion({ severity: 'URGENT' })],
        });
        expect(out.codeSuggestions[0].severity).toBe('URGENT');
    });

    it('row 24 — addSeverityToSuggestions overrides severity from the matching rule (canonical, lower-cased)', () => {
        const { service } = makeService();
        const out = (service as any).addSeverityToSuggestions(
            {
                codeSuggestions: [
                    genSuggestion({
                        severity: 'URGENT',
                        brokenKodyRulesIds: ['r1'],
                    }),
                ],
            },
            [{ uuid: 'r1', severity: 'HIGH' }],
        );
        expect(out.codeSuggestions[0].severity).toBe('high');
    });

    it('row 25 — coercible numeric-string line fields are normalized (Number(...) || undefined)', () => {
        const { service } = makeService();
        const out = callProcessUpdate(
            service,
            JSON.stringify({
                codeSuggestions: [
                    {
                        suggestionContent: 'x',
                        relevantLinesStart: '10',
                        relevantLinesEnd: 'not-a-number',
                    },
                ],
            }),
        );
        expect(out.codeSuggestions[0].relevantLinesStart).toBe(10);
        expect(out.codeSuggestions[0].relevantLinesEnd).toBeUndefined();
    });

    // row 26 (duplicate keys) is asserted in the string-parse zoo above.
    // row 27 (unicode) is asserted in the string-parse zoo above.
});

// ---------------------------------------------------------------------------
// C. UNPARSEABLE / TRANSPORT (fail-safe layer) — end-to-end through analyzeCodeWithAI
// ---------------------------------------------------------------------------
describe('C. transport / fail-safe — analyzeCodeWithAI', () => {
    beforeEach(() => {
        mockRun.mockReset();
        mockRun.mockImplementation(routeByRunName);
    });

    const fileContext = FILE_CTX;
    const context = {
        organizationAndTeamData: ORG,
        pullRequest: { number: 42 },
        repository: { id: 'repo-1', name: 'repo', language: 'typescript' },
        codeReviewConfig: {
            kodyRules: [{ uuid: 'r1', title: 'R1', severity: 'high' }],
            byokConfig: BYOK,
        },
    } as any;

    it('row 30 — classifier LLM throw propagates as an EXPLICIT, logged failure (fail-fast, not a silent empty)', async () => {
        mockRun.mockImplementation(async ({ runName }: any) => {
            if (runName.endsWith('::classifierKodyRulesAnalyzeCodeWithAI')) {
                throw new Error('network down');
            }
            return routeByRunName({ runName });
        });
        const { service } = makeService();
        await expect(
            service.analyzeCodeWithAI(
                ORG,
                42,
                fileContext,
                undefined as any,
                context,
                undefined,
            ),
        ).rejects.toThrow('network down');
    });

    it('row 32 — classifier empty-success ({}) → typed-empty analysis result, no throw', async () => {
        mockRun.mockImplementation(async ({ runName }: any) => {
            if (runName.endsWith('::classifierKodyRulesAnalyzeCodeWithAI')) {
                return {};
            }
            return routeByRunName({ runName });
        });
        const { service } = makeService();
        const out = await service.analyzeCodeWithAI(
            ORG,
            42,
            fileContext,
            undefined as any,
            context,
            undefined,
        );
        expect(out).toEqual({ codeSuggestions: [] });
    });
});

// ---------------------------------------------------------------------------
// D. INPUT VARIANTS (happy LLM mock; assert the invariant)
// ---------------------------------------------------------------------------
describe('D. input variants', () => {
    beforeEach(() => {
        mockRun.mockReset();
        mockRun.mockImplementation(routeByRunName);
    });

    const fileContext = FILE_CTX;
    const context = {
        organizationAndTeamData: ORG,
        pullRequest: { number: 42 },
        repository: { id: 'repo-1', name: 'repo', language: 'typescript' },
        codeReviewConfig: {
            kodyRules: [{ uuid: 'r1', title: 'R1', severity: 'high' }],
            byokConfig: BYOK,
        },
    } as any;

    it('row 35 — empty input (0 applicable rules) → typed-empty, LLM never called', async () => {
        const { service, kodyRulesValidationService } = makeService();
        kodyRulesValidationService.getKodyRulesForFile.mockReturnValue([]);
        const out = await service.analyzeCodeWithAI(
            ORG,
            42,
            fileContext,
            undefined as any,
            context,
            undefined,
        );
        expect(out).toEqual({ codeSuggestions: [] });
        expect(mockRun).not.toHaveBeenCalled();
    });

    it('row 36 — single applicable rule → analysis runs and returns the mapped suggestion', async () => {
        const { service } = makeService();
        const out = await service.analyzeCodeWithAI(
            ORG,
            42,
            fileContext,
            undefined as any,
            context,
            undefined,
        );
        expect(out.codeSuggestions).toHaveLength(1);
    });

    it('row 38 — duplicate input rules (same uuid) do not crash the classifier mapping', () => {
        const { service } = makeService();
        const out = callProcessClassifier(
            service,
            [
                { uuid: 'r1', title: 'A' },
                { uuid: 'r1', title: 'B' },
            ],
            { rules: [{ uuid: 'r1', reason: 'x' }] },
        );
        expect(out).toHaveLength(2);
        expect(out.every((r: any) => r.reason === 'x')).toBe(true);
    });

    it('row 39 — input rule with a null/undefined uuid is safely skipped, not crashed on', () => {
        const { service } = makeService();
        const out = callProcessClassifier(
            service,
            [
                { uuid: undefined, title: 'no-id' },
                { uuid: 'r1', title: 'ok' },
            ],
            { rules: [{ uuid: 'r1', reason: 'x' }] },
        );
        expect(out).toHaveLength(1);
        expect(out[0].uuid).toBe('r1');
    });

    it('row 40 — special-chars / whitespace patch does not crash assembly; shape is preserved', async () => {
        const { service } = makeService();
        const weirdFile = {
            file: { filename: 'src/w eird$.ts', fileContent: '   \n\t 💥' },
            patchWithLinesStr: '+ const x = "\\n\\t 💥 <script>";',
        } as any;
        const out = await service.analyzeCodeWithAI(
            ORG,
            42,
            weirdFile,
            undefined as any,
            context,
            undefined,
        );
        expect(Array.isArray(out.codeSuggestions)).toBe(true);
    });

    it('row 42 — order permutation of classifier rules yields an equivalent decision set (metamorphic)', () => {
        const { service } = makeService();
        const allRules = [
            { uuid: 'r1', title: 'R1' },
            { uuid: 'r2', title: 'R2' },
        ];
        const a = callProcessClassifier(service, allRules, {
            rules: [
                { uuid: 'r1', reason: 'a' },
                { uuid: 'r2', reason: 'b' },
            ],
        });
        const b = callProcessClassifier(service, allRules, {
            rules: [
                { uuid: 'r2', reason: 'b' },
                { uuid: 'r1', reason: 'a' },
            ],
        });
        expect(b).toEqual(a);
    });
});

// ---------------------------------------------------------------------------
// E. PROVIDER / MODEL POLICY MATRIX
//    This boundary DELEGATES structured-output policy to LLM.run →
//    runStructuredReviewCall → structured-output-gate (the mocked seam). The
//    parse layer never branches on provider, so:
//      - strict json_schema providers (openai/anthropic/google/moonshotai) →
//        clean D is trusted (happy path holds for each);
//      - json_object fallback providers (kimi/glm/deepseek/z-ai) → the full
//        A/B/C off-schema zoo is in scope and handled by the SAME parse layer
//        proven above (identical result regardless of provider).
// ---------------------------------------------------------------------------
describe('E. provider / model policy matrix (parse layer is provider-agnostic)', () => {
    beforeEach(() => {
        mockRun.mockReset();
        mockRun.mockImplementation(routeByRunName);
    });

    const fileContext = FILE_CTX;
    const baseContext = (provider: string) =>
        ({
            organizationAndTeamData: ORG,
            pullRequest: { number: 42 },
            repository: {
                id: 'repo-1',
                name: 'repo',
                language: 'typescript',
            },
            codeReviewConfig: {
                kodyRules: [{ uuid: 'r1', title: 'R1', severity: 'high' }],
                byokConfig: { main: { provider, model: `${provider}-model` } },
            },
        }) as any;

    const strict = ['openai', 'anthropic', 'google', 'moonshotai'];
    const fallback = ['moonshotai/kimi', 'z-ai/glm', 'deepseek', 'z-ai'];

    it.each([...strict, ...fallback])(
        'threads the %s BYOK slot to every LLM.run and returns the declared shape (clean D honored)',
        async (provider) => {
            const ctx = baseContext(provider);
            const { service } = makeService();
            const out = await service.analyzeCodeWithAI(
                ORG,
                42,
                fileContext,
                undefined as any,
                ctx,
                undefined,
            );
            expect(out.codeSuggestions).toHaveLength(1);
            for (const call of mockRun.mock.calls) {
                expect(call[0].byokConfig).toBe(ctx.codeReviewConfig.byokConfig);
            }
        },
    );

    it('json_object-fallback providers get NO extra protection at the parse layer: off-schema degrades identically to strict providers (same #1786 exposure)', () => {
        // The classifier parse layer is pure and provider-blind; a bare-array
        // off-schema envelope is dropped the same way no matter which model
        // produced it. This is exactly why the fallback zoo must be closed at
        // the parse layer (see the it.failing guards above), not left to the gate.
        const { service } = makeService();
        const RULES = [{ uuid: 'r1', title: 'R1' }];
        const bareArray = [{ uuid: 'r1', reason: 'x' }] as any;
        expect(callProcessClassifier(service, RULES, bareArray)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// RETURN-SHAPE INVARIANT — every parse layer returns its declared type/shape.
// ---------------------------------------------------------------------------
describe('return-shape invariant across all layers', () => {
    const objectZoo = [
        {},
        { rules: [] },
        { codeSuggestions: [] },
        [],
        [{ uuid: 'r1' }],
        { result: {} },
        true,
        0,
        'string',
        null,
        undefined,
        42,
        { choices: [{ message: { content: '{}' } }] },
    ];

    it('processClassifierResponse always returns null or an array', () => {
        const { service } = makeService();
        const RULES = [{ uuid: 'r1' }];
        for (const shape of objectZoo) {
            const out = callProcessClassifier(service, RULES, shape as any);
            expect(out === null || Array.isArray(out)).toBe(true);
        }
    });

    it('processLLMResponse always returns null or { codeSuggestions: [] }', () => {
        const { service } = makeService();
        for (const shape of objectZoo) {
            const out = callProcessLLM(service, shape as any);
            expect(
                out === null ||
                    (out && Array.isArray(out.codeSuggestions)),
            ).toBeTruthy();
        }
    });

    it('processUpdatedSuggestions always returns null or { codeSuggestions: [] }', () => {
        const { service } = makeService();
        const stringZoo = [
            '',
            '   ',
            '{}',
            '[]',
            'not json',
            '{"codeSuggestions":[]}',
            '{"codeSuggestions":[{"suggestionContent":"x"}]}',
            '```json\n{}\n```',
            '{"codeSuggestions":[{"id":"u1"',
        ];
        for (const s of stringZoo) {
            const out = callProcessUpdate(service, s);
            expect(
                out === null ||
                    (out && Array.isArray(out.codeSuggestions)),
            ).toBeTruthy();
        }
    });
});

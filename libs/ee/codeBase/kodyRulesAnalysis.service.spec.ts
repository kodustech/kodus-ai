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

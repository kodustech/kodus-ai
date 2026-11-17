/**
 * Parity spec for the documentation planner migration (03-08).
 *
 * The planner used to run through the LangChain BYOKPromptRunner; it now
 * runs on runStructuredReviewCall (Vercel AI SDK path). This spec drives the real
 * runStructuredReviewCall and mocks only the `tracedGenerateText` seam — the model
 * builders are stubbed so no network/model is touched. We deliberately do NOT drive
 * over MockLanguageModelV4: it hangs on the structured (Output.object) path
 * (Phase 0 + 03-01). Mocking tracedGenerateText mirrors structured-review-call.spec.ts.
 */

// Stub the model builders so the structured call resolves against our mocked
// tracedGenerateText instead of a real provider. Sentinels tag the role so we can
// assert a BYOK org runs on its own `main` model unchanged.
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

import { DocumentationLLMPlannerService } from './documentation-llm-planner.service';
import { tracedGenerateText } from '@libs/llm/llm-call';
import { LLM } from '@libs/llm/llm';
import { DocumentationPlannerSchema } from '@libs/common/utils/prompts/codeReviewDocumentationPlanner';

const mockGenerate = tracedGenerateText as unknown as jest.Mock;

// runAiSdkLLMInSpan just runs the exec and returns its result — one span path (Q4).
const observabilityService = {
    runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
} as any;

const ok = (obj: any) => ({ experimental_output: obj, usage: {} });

const buildService = () =>
    new DocumentationLLMPlannerService(observabilityService);

const tsFile = {
    filename: 'src/app.ts',
    fileContent: 'import express from "express";\nconst app = express();',
    patch: '+const app = express();',
    patchWithLinesStr: '+const app = express();',
} as any;

const expressPackage = {
    name: 'express',
    version: '4.18.2',
    ecosystem: 'npm',
    sourceFile: 'package.json',
} as any;

describe('DocumentationLLMPlannerService — runStructuredReviewCall parity', () => {
    beforeAll(() => {
        process.env.API_GROQ_API_KEY = 'test-groq-key';
    });

    beforeEach(() => {
        mockGenerate.mockReset();
        observabilityService.runAiSdkLLMInSpan.mockClear();
    });

    it('maps the structured planner output onto the per-file plan (primary/BYOK path)', async () => {
        const structured = {
            queryTasks: [
                {
                    packageName: 'express',
                    query: 'Language: TypeScript. Package: express. Router usage. Prefer official docs.',
                },
            ],
        };
        mockGenerate.mockResolvedValueOnce(ok(structured));

        const service = buildService();

        const plans = await service.planDocumentationByFile({
            packages: [expressPackage],
            changedFiles: [tsFile],
            byokConfig: { main: { provider: 'openai' } } as any,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        });

        // The plan mirrors the mocked structured result for the file.
        expect(plans['src/app.ts']).toEqual({
            queryTasks: structured.queryTasks,
        });

        // Proof it went through the AI SDK path: exactly one structured call,
        // on the BYOK org's own `main` model (no managed fallback touched).
        expect(mockGenerate).toHaveBeenCalledTimes(1);
        expect(mockGenerate.mock.calls[0][0].model).toEqual({
            __model: 'main',
        });
    });

    it('returns an empty plan for the file when the structured call fails', async () => {
        mockGenerate.mockRejectedValue(new Error('provider down'));

        const service = buildService();

        const plans = await service.planDocumentationByFile({
            packages: [expressPackage],
            changedFiles: [tsFile],
            // No BYOK + no Groq re-issue success → the per-file promise rejects,
            // and the planner records an empty plan for that file.
            byokConfig: { main: { provider: 'openai' } } as any,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        });

        expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
    });

    it('skips non-code files entirely (no LLM call)', async () => {
        const service = buildService();

        const plans = await service.planDocumentationByFile({
            packages: [expressPackage],
            changedFiles: [{ ...tsFile, filename: 'README.md' }],
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        });

        expect(plans).toEqual({});
        expect(mockGenerate).not.toHaveBeenCalled();
    });
});

/**
 * CONTRACT tests for the LLM.run boundary inside planDocumentationByFile.
 *
 * The bug class we guard (issue #1786): a non-strict provider (kimi / glm /
 * deepseek / z-ai fall back to json_object) returns JSON in the WRONG envelope —
 * a bare array, a {result:...} wrapper, a stringified object, or the data under
 * different keys — and the deterministic layer around the model call SILENTLY
 * degrades instead of repairing / re-asking / signalling. Here that layer is the
 * service's own parse-and-map (`mapResultByFile` + `uniqueQueryTasks`): it takes
 * `LLM.run`'s return AS-IS (`response as DocumentationPlannerSchemaType`) and
 * trusts it. `readOutput` (the extract seam) does not re-validate, so an
 * off-schema object that slips past `Output.object` reaches this layer verbatim.
 *
 * We spy the REAL `LLM.run` boundary and drive the three contract layers through
 * it, so nothing downstream (routing, provider builders, the AI SDK) is touched.
 * The spy is restored after each test so the parity suite above keeps working.
 *
 * The declared return type is Record<string, DocumentationQueryPlanByFile>, i.e.
 * every file key MUST map to `{ queryTasks: DocumentationQueryTask[] }` — a
 * caller iterating `plan.queryTasks` can never hit an undefined / non-array.
 */
describe('DocumentationLLMPlannerService — LLM.run boundary contract (#1786)', () => {
    let runSpy: jest.SpyInstance;

    const tsFile = {
        filename: 'src/app.ts',
        fileContent: 'import express from "express";\nconst app = express();',
        patch: '+const app = express();',
        patchWithLinesStr: '+const app = express();',
    } as any;

    const expressPackage = {
        name: 'express',
        version: '4.18.2',
        ecosystem: 'npm',
        sourceFile: 'package.json',
    } as any;

    const observability = {
        runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
    } as any;

    const buildService = () =>
        new DocumentationLLMPlannerService(observability);

    // Run the planner for a single TS file whose only dependency is `express`,
    // with `LLM.run` resolving to the given (possibly off-schema) value.
    const planWith = async (resolved: unknown) => {
        runSpy.mockResolvedValue(resolved as any);
        return buildService().planDocumentationByFile({
            packages: [expressPackage],
            changedFiles: [tsFile],
            byokConfig: { main: { provider: 'openai' } } as any,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        });
    };

    // The declared-shape guarantee: every value is `{ queryTasks: [...] }`.
    const assertDeclaredShape = (
        plans: Record<string, { queryTasks: unknown }>,
    ) => {
        for (const key of Object.keys(plans)) {
            expect(plans[key]).toBeDefined();
            expect(Array.isArray(plans[key].queryTasks)).toBe(true);
        }
    };

    const goodTask = { packageName: 'express', query: 'express router usage' };

    beforeEach(() => {
        runSpy = jest.spyOn(LLM, 'run');
        observability.runAiSdkLLMInSpan.mockClear();
    });

    afterEach(() => {
        runSpy.mockRestore();
    });

    // ── Layer 1: HAPPY PATH ────────────────────────────────────────────────
    describe('happy path (correct schema shape)', () => {
        it('maps the exact schema shape onto the per-file plan and calls LLM.run with the declared contract', async () => {
            const plans = await planWith({ queryTasks: [goodTask] });

            // Exact side effect: the plan mirrors the structured result.
            expect(plans).toEqual({
                'src/app.ts': { queryTasks: [goodTask] },
            });
            assertDeclaredShape(plans);

            // Exact args to the LLM.run boundary.
            expect(runSpy).toHaveBeenCalledTimes(1);
            const arg = runSpy.mock.calls[0][0];
            expect(arg.schema).toBe(DocumentationPlannerSchema);
            expect(arg.byokConfig).toEqual({ main: { provider: 'openai' } });
            expect(arg.organizationId).toBe('org-1');
            expect(arg.attrs).toMatchObject({
                fallback: false,
                filePath: 'src/app.ts',
            });
            expect(arg.runName).toContain('DocumentationLLMPlannerService');
            expect(arg.runName).toContain('src/app.ts');
            expect(typeof arg.system).toBe('string');
            expect(arg.system.length).toBeGreaterThan(0);
            expect(typeof arg.user).toBe('string');
            expect(arg.user.length).toBeGreaterThan(0);
        });

        it('deduplicates repeated tasks and drops tasks for out-of-scope packages', async () => {
            const plans = await planWith({
                queryTasks: [
                    goodTask,
                    { ...goodTask, query: '  express router usage  ' }, // dup after trim
                    { ...goodTask, packageName: 'EXPRESS' }, // case-insensitive dup
                    { packageName: 'left-pad', query: 'padding' }, // not scoped to file
                ],
            });

            expect(plans['src/app.ts']).toEqual({ queryTasks: [goodTask] });
            assertDeclaredShape(plans);
        });
    });

    // ── Layer 2: OFF-SCHEMA / N-MODEL ROBUSTNESS (the #1786 class) ──────────
    describe('off-schema envelopes (non-strict json_object providers)', () => {
        // These shapes carry NO usable data, so an empty plan is the CORRECT,
        // non-degrading result — and the declared shape must still hold.
        it('returns an explicit empty plan for a null result', async () => {
            const plans = await planWith(null);
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

        it('returns an explicit empty plan for an empty object', async () => {
            const plans = await planWith({});
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

        it('drops an incomplete task (missing query) rather than shipping a half-formed one', async () => {
            const plans = await planWith({
                queryTasks: [{ packageName: 'express' }],
            });
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

        // These shapes carry the model's REAL tasks in the wrong envelope. The
        // service reads `result.queryTasks`, finds it undefined, and SILENTLY
        // drops the data → an empty plan with no signal. That is the #1786
        // silent-degradation ("quietly drop"). The tests below assert the
        // CORRECT non-degrading behavior (the tasks survive), so each stays
        // green now (body fails on the bug) and flips RED the day the boundary
        // learns to normalize / repair / re-ask on these envelopes.
        it('recovers query tasks when the model returns a bare array instead of { queryTasks: [...] } (#1786)', async () => {
            const plans = await planWith([goodTask]);
            expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
        });

        it('recovers query tasks from a { result: { queryTasks: [...] } } wrapper (#1786)', async () => {
            const plans = await planWith({
                result: { queryTasks: [goodTask] },
            });
            expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
        });

        it('recovers query tasks from a stringified JSON payload (#1786)', async () => {
            const plans = await planWith(
                JSON.stringify({ queryTasks: [goodTask] }),
            );
            expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
        });

        it('recovers query tasks when the array is under a wrong key (e.g. { tasks: [...] }) (#1786)', async () => {
            const plans = await planWith({ tasks: [goodTask] });
            expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
        });
    });

    // ── Layer 3: FAIL-SAFE ─────────────────────────────────────────────────
    describe('fail-safe (provider error / suspended key)', () => {
        it('records an empty plan for the failing file while keeping the succeeding file (per-file isolation + declared shape)', async () => {
            const otherFile = { ...tsFile, filename: 'src/other.ts' };
            runSpy
                .mockResolvedValueOnce({ queryTasks: [goodTask] }) // src/app.ts
                .mockRejectedValueOnce(new Error('provider down')); // src/other.ts

            const plans = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [tsFile, otherFile],
                byokConfig: { main: { provider: 'openai' } } as any,
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });

            expect(Object.keys(plans).sort()).toEqual([
                'src/app.ts',
                'src/other.ts',
            ]);
            expect(plans['src/app.ts']).toEqual({ queryTasks: [goodTask] });
            expect(plans['src/other.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });
    });
});

/**
 * BACKFILL: full LLM.run I/O contract matrix for this boundary.
 *
 * Declared schema D = { queryTasks: [{ packageName:string(min1), query:string(min1) }] }
 * (max 3). The boundary is `planDocumentationByFile`, which fans out one
 * `LLM.run` per code file (Promise.allSettled), then maps each return through
 * `mapResultByFile` + `uniqueQueryTasks`. The invariant every row must uphold:
 * the returned Record<string, DocumentationQueryPlanByFile> maps EVERY file key
 * to `{ queryTasks: DocumentationQueryTask[] }` — a caller iterating
 * `plan.queryTasks` can never hit undefined / non-array.
 *
 * NON-DEGRADATION: for any off-schema envelope the boundary must recover the real
 * payload OR fail-safe to an observable empty plan — never ship a silently wrong
 * one. Where prod silently drops recoverable data (reads `result.queryTasks`
 * verbatim: mapResultByFile @ documentation-llm-planner.service.ts:182), the
 * CORRECT recovery is pinned as `it.failing` (green today, red on the fix).
 *
 * Rows with no analog in D (boolean/enum/index/severity fields) are recorded N/A
 * in the structured result rather than silently skipped.
 */
describe('DocumentationLLMPlannerService — full I/O contract matrix backfill', () => {
    let runSpy: jest.SpyInstance;

    const tsFile = {
        filename: 'src/app.ts',
        fileContent: 'import express from "express";\nconst app = express();',
        patch: '+const app = express();',
        patchWithLinesStr: '+const app = express();',
    } as any;

    const expressPackage = {
        name: 'express',
        version: '4.18.2',
        ecosystem: 'npm',
        sourceFile: 'package.json',
    } as any;

    const observability = {
        runAiSdkLLMInSpan: jest.fn(async ({ exec }: any) => exec()),
    } as any;

    const buildService = () =>
        new DocumentationLLMPlannerService(observability);

    const goodTask = { packageName: 'express', query: 'express router usage' };

    const assertDeclaredShape = (
        plans: Record<string, { queryTasks: unknown }>,
    ) => {
        for (const key of Object.keys(plans)) {
            expect(plans[key]).toBeDefined();
            expect(Array.isArray(plans[key].queryTasks)).toBe(true);
        }
    };

    // Resolve LLM.run to `resolved` for a single-TS-file plan (express dep only).
    const planWith = async (
        resolved: unknown,
        byokConfig: any = { main: { provider: 'openai' } },
    ) => {
        runSpy.mockResolvedValue(resolved as any);
        return buildService().planDocumentationByFile({
            packages: [expressPackage],
            changedFiles: [tsFile],
            byokConfig,
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        });
    };

    beforeEach(() => {
        runSpy = jest.spyOn(LLM, 'run');
        observability.runAiSdkLLMInSpan.mockClear();
    });

    afterEach(() => {
        runSpy.mockRestore();
    });

    // ── A. Output-shape zoo ─────────────────────────────────────────────────
    describe('A. output-shape zoo', () => {
        // Row 3: single object where D expects an array (queryTasks not iterable)
        // → uniqueQueryTasks' for..of throws → outer catch fail-safes to empty.
        it('[3] fail-safes to an empty plan when queryTasks is a single object, not an array', async () => {
            const plans = await planWith({ queryTasks: goodTask });
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });
    });

    // ── D. Input variants ───────────────────────────────────────────────────
    describe('D. input variants', () => {
        // Row 38a: duplicate FILES in input collapse to a single key, declared shape held.
        it('[38] collapses duplicate file entries onto a single plan key', async () => {
            runSpy.mockResolvedValue({ queryTasks: [goodTask] } as any);
            const plans = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [tsFile, { ...tsFile }],
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });
            expect(Object.keys(plans)).toEqual(['src/app.ts']);
            assertDeclaredShape(plans);
        });

        // Row 39: input item with null/undefined required (LLM-relevant) fields.
        it('[39] handles a file with null content/patch fields without crashing', async () => {
            runSpy.mockResolvedValue({ queryTasks: [goodTask] } as any);
            const nullish = {
                filename: 'src/nullish.ts',
                fileContent: null,
                patch: null,
                patchWithLinesStr: null,
            } as any;
            const plans = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [nullish],
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });
            expect(plans['src/nullish.ts']).toEqual({ queryTasks: [goodTask] });
            assertDeclaredShape(plans);
            // The payload defaults null content/diff to '' before the call.
            const arg = runSpy.mock.calls[0][0];
            expect(typeof arg.user).toBe('string');
        });
    });
});

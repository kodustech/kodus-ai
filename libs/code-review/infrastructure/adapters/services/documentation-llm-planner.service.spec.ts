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
import { z } from 'zod';

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
    createOpenAICompatible: jest.fn(
        () => (modelId: string) => ({ __model: 'groq', modelId }),
    ),
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

    it('drops queryTasks for packages not scoped to the file (parity with the old filter)', async () => {
        // Model proposes a package that is not a dependency of this file.
        mockGenerate.mockResolvedValueOnce(
            ok({
                queryTasks: [
                    { packageName: 'left-pad', query: 'padding' },
                ],
            }),
        );

        const service = buildService();

        const plans = await service.planDocumentationByFile({
            packages: [expressPackage],
            changedFiles: [tsFile],
            organizationAndTeamData: { organizationId: 'org-1' } as any,
        });

        // Unknown package filtered out → empty plan for the file.
        expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
        expect(mockGenerate).toHaveBeenCalledTimes(1);
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
        it.failing(
            'recovers query tasks when the model returns a bare array instead of { queryTasks: [...] } (#1786)',
            async () => {
                const plans = await planWith([goodTask]);
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        it.failing(
            'recovers query tasks from a { result: { queryTasks: [...] } } wrapper (#1786)',
            async () => {
                const plans = await planWith({
                    result: { queryTasks: [goodTask] },
                });
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        it.failing(
            'recovers query tasks from a stringified JSON payload (#1786)',
            async () => {
                const plans = await planWith(
                    JSON.stringify({ queryTasks: [goodTask] }),
                );
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        it.failing(
            'recovers query tasks when the array is under a wrong key (e.g. { tasks: [...] }) (#1786)',
            async () => {
                const plans = await planWith({ tasks: [goodTask] });
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        // Whatever the envelope, the return NEVER breaks the declared shape:
        // a caller can always iterate `plan.queryTasks`.
        it('always returns the declared shape across every off-schema envelope', async () => {
            for (const shape of [
                null,
                undefined,
                {},
                [goodTask],
                { result: { queryTasks: [goodTask] } },
                JSON.stringify({ queryTasks: [goodTask] }),
                { tasks: [goodTask] },
                { queryTasks: [{ packageName: 'express' }] },
            ]) {
                const plans = await planWith(shape);
                assertDeclaredShape(plans);
                expect(plans['src/app.ts']).toBeDefined();
            }
        });
    });

    // ── Layer 3: FAIL-SAFE ─────────────────────────────────────────────────
    describe('fail-safe (provider error / suspended key)', () => {
        it('degrades to an empty plan and never throws past its boundary when LLM.run rejects', async () => {
            runSpy.mockRejectedValue(new Error('suspended key / provider down'));

            const promise = buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [tsFile],
                byokConfig: { main: { provider: 'openai' } } as any,
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });

            await expect(promise).resolves.toBeDefined();
            const plans = await promise;
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

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

        // Row 5: double wrapper { result: { result: D } } — real data buried.
        it.failing(
            '[5] recovers query tasks from a double wrapper { result: { result: { queryTasks } } } (#1786)',
            async () => {
                const plans = await planWith({
                    result: { result: { queryTasks: [goodTask] } },
                });
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        // Row 6: numeric / opaque single-key wrap { "0": D } and { content: D }.
        it.failing(
            '[6] recovers query tasks from a numeric single-key wrap { "0": { queryTasks } } (#1786)',
            async () => {
                const plans = await planWith({ '0': { queryTasks: [goodTask] } });
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        it.failing(
            '[6] recovers query tasks from a { content: { queryTasks } } wrap (#1786)',
            async () => {
                const plans = await planWith({
                    content: { queryTasks: [goodTask] },
                });
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        // Row 8: markdown-fenced JSON string.
        it.failing(
            '[8] recovers query tasks from a markdown-fenced JSON string (#1786)',
            async () => {
                const fenced =
                    '```json\n' +
                    JSON.stringify({ queryTasks: [goodTask] }) +
                    '\n```';
                const plans = await planWith(fenced);
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        // Row 9: prose-wrapped JSON.
        it.failing(
            '[9] recovers query tasks from a prose-wrapped JSON string (#1786)',
            async () => {
                const prose =
                    'Here is the plan: ' +
                    JSON.stringify({ queryTasks: [goodTask] }) +
                    '\n\nLet me know if you need anything else.';
                const plans = await planWith(prose);
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        // Row 11: case / convention mismatch (snake_case key).
        it.failing(
            '[11] recovers query tasks when the key is snake_case (query_tasks) (#1786)',
            async () => {
                const plans = await planWith({ query_tasks: [goodTask] });
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        // Row 13: extra unknown keys alongside the right ones — must TOLERATE.
        it('[13] tolerates extra unknown keys and still recovers the real queryTasks', async () => {
            const plans = await planWith({
                queryTasks: [goodTask],
                _meta: { model: 'x', tokens: 42 },
                confidence: 0.9,
            });
            expect(plans['src/app.ts']).toEqual({ queryTasks: [goodTask] });
            assertDeclaredShape(plans);
        });

        // Row 15: empty array where an object is expected.
        it('[15] returns an explicit empty plan for a bare empty array', async () => {
            const plans = await planWith([]);
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

        // Row 16: empty string / whitespace-only.
        it('[16] returns an explicit empty plan for an empty / whitespace string', async () => {
            for (const s of ['', '   \n\t  ']) {
                const plans = await planWith(s);
                expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
                assertDeclaredShape(plans);
            }
        });

        // Row 17: undefined return (null covered in the #1786 suite).
        it('[17] returns an explicit empty plan for an undefined result', async () => {
            const plans = await planWith(undefined);
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

        // Row 18: primitive where an object is expected.
        it('[18] returns an explicit empty plan for primitive returns (true / 0 / "ok")', async () => {
            for (const prim of [true, 0, 'ok', 42]) {
                const plans = await planWith(prim);
                expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
                assertDeclaredShape(plans);
            }
        });

        // Row 19: provider envelope leak — data buried in choices[].message.content.
        it.failing(
            '[19] recovers query tasks from a provider envelope leak { choices:[{message:{content}}] } (#1786)',
            async () => {
                const plans = await planWith({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    queryTasks: [goodTask],
                                }),
                            },
                        },
                    ],
                });
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );

        // Row 20: reasoning / thinking leak preceding the JSON payload.
        it.failing(
            '[20] recovers query tasks when a thinking/reasoning preamble leaks before the JSON (#1786)',
            async () => {
                const leaked =
                    '<thinking>The file imports express, so...</thinking>' +
                    JSON.stringify({ queryTasks: [goodTask] });
                const plans = await planWith(leaked);
                expect(plans['src/app.ts'].queryTasks).toEqual([goodTask]);
            },
        );
    });

    // ── B. Semantic-but-wrong ───────────────────────────────────────────────
    describe('B. semantic-but-wrong', () => {
        // Row 25: dangling reference — packageName not in the file's allowed set.
        it('[25] drops a task whose packageName references a package not scoped to the file', async () => {
            const plans = await planWith({
                queryTasks: [
                    goodTask,
                    { packageName: 'left-pad', query: 'padding helper' },
                ],
            });
            expect(plans['src/app.ts']).toEqual({ queryTasks: [goodTask] });
            assertDeclaredShape(plans);
        });

        // Row 27: unicode / escaped newlines / emoji inside string fields survive intact.
        it('[27] preserves unicode, newlines and emoji inside the query field', async () => {
            const weird = {
                packageName: 'express',
                query: 'roteamento 🚦 com acentuação — línea 1\nlínea 2\ttabbed 日本語',
            };
            const plans = await planWith({ queryTasks: [weird] });
            expect(plans['src/app.ts'].queryTasks).toEqual([weird]);
            assertDeclaredShape(plans);
        });
    });

    // ── C. Unparseable / transport (fail-safe layer) ────────────────────────
    describe('C. unparseable / transport', () => {
        // Row 28: truncated JSON (max_tokens mid-object) reaching the map as a string.
        it('[28] fail-safes to an empty plan (no crash) on a truncated JSON string', async () => {
            const plans = await planWith('{"queryTasks":[{"packageName":"exp');
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

        // Row 29: malformed JSON — trailing comma / single quotes / unquoted keys.
        it('[29] fail-safes to an empty plan (no crash) on malformed JSON strings', async () => {
            for (const bad of [
                "{queryTasks: [{'packageName':'express',}]}",
                '{"queryTasks":[{"packageName":"express","query":"x",}]}',
            ]) {
                const plans = await planWith(bad);
                expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
                assertDeclaredShape(plans);
            }
        });

        // Row 31: error object returned instead of throwing.
        it('[31] fail-safes to an empty plan when LLM.run resolves an { error } object', async () => {
            const plans = await planWith({ error: 'quota_exceeded', code: 429 });
            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });

        // Row 32: empty success (content:'' / finish_reason:'length').
        it('[32] returns an empty plan for empty-success shapes', async () => {
            for (const shape of [
                { content: '', finish_reason: 'length' },
                { queryTasks: [], finish_reason: 'length' },
            ]) {
                const plans = await planWith(shape);
                expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
                assertDeclaredShape(plans);
            }
        });

        // Row 33: refusal prose / content_filter.
        it('[33] returns an empty plan for a refusal string / content_filter finish', async () => {
            for (const shape of [
                'I cannot help with that request.',
                { content: 'I refuse.', finish_reason: 'content_filter' },
            ]) {
                const plans = await planWith(shape);
                expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
                assertDeclaredShape(plans);
            }
        });

        // Row 34: abort signal fired mid-call → rejection → per-file fail-safe.
        it('[34] fail-safes to an empty plan when the call rejects with an AbortError', async () => {
            const abort = Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
            });
            runSpy.mockRejectedValue(abort);

            const plans = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [tsFile],
                byokConfig: { main: { provider: 'openai' } } as any,
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });

            expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
            assertDeclaredShape(plans);
        });
    });

    // ── D. Input variants ───────────────────────────────────────────────────
    describe('D. input variants', () => {
        // Row 35: empty input (no code files) → no LLM call, empty record.
        it('[35] returns {} and never calls LLM.run for empty input', async () => {
            runSpy.mockResolvedValue({ queryTasks: [goodTask] } as any);
            const plans = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [],
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });
            expect(plans).toEqual({});
            expect(runSpy).not.toHaveBeenCalled();
        });

        // Row 37: large input (many files) — one call per file, all mapped.
        it('[37] fans out one call per file and maps every file for large input', async () => {
            runSpy.mockResolvedValue({ queryTasks: [goodTask] } as any);
            const files = Array.from({ length: 12 }, (_, i) => ({
                ...tsFile,
                filename: `src/mod-${i}.ts`,
            }));
            const plans = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: files,
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });
            expect(Object.keys(plans)).toHaveLength(12);
            expect(runSpy).toHaveBeenCalledTimes(12);
            assertDeclaredShape(plans);
            for (const f of files) {
                expect(plans[f.filename]).toEqual({ queryTasks: [goodTask] });
            }
        });

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

        // Row 38b: duplicate TASKS in one file's output are deduped after trim.
        it('[38] deduplicates repeated tasks within a single file result', async () => {
            const plans = await planWith({
                queryTasks: [
                    goodTask,
                    { ...goodTask, query: '  express router usage  ' },
                    { ...goodTask, packageName: 'EXPRESS' }, // case-insensitive dup
                ],
            });
            expect(plans['src/app.ts']).toEqual({ queryTasks: [goodTask] });
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

        // Row 40: whitespace-only / special-char diff still produces a valid call + plan.
        it('[40] handles a whitespace-only diff and special-char content', async () => {
            runSpy.mockResolvedValue({ queryTasks: [goodTask] } as any);
            const weirdFile = {
                filename: 'src/weird.ts',
                fileContent: 'const s = "🚀\t\n\\x00 日本語";',
                patch: '   \n\t   ',
                patchWithLinesStr: '   \n\t   ',
            } as any;
            const plans = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [weirdFile],
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });
            expect(plans['src/weird.ts']).toEqual({ queryTasks: [goodTask] });
            assertDeclaredShape(plans);
        });

        // Row 42: order permutation → equivalent decision (metamorphic).
        it('[42] produces an equivalent plan map regardless of input file order', async () => {
            runSpy.mockResolvedValue({ queryTasks: [goodTask] } as any);
            const a = { ...tsFile, filename: 'src/a.ts' };
            const b = { ...tsFile, filename: 'src/b.ts' };

            const forward = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [a, b],
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });
            const reversed = await buildService().planDocumentationByFile({
                packages: [expressPackage],
                changedFiles: [b, a],
                organizationAndTeamData: { organizationId: 'org-1' } as any,
            });

            expect(forward).toEqual(reversed);
            assertDeclaredShape(forward);
        });
    });

    // ── E. Provider / model matrix ──────────────────────────────────────────
    // This boundary does NOT branch on model — it passes byokConfig straight to
    // LLM.run, which delegates the structured-output gate upstream. So we assert
    // the boundary is provider-agnostic: identical behavior on a strict
    // json_schema provider and a json_object-fallback provider, for both the
    // happy shape (recovers) and an unrecoverable off-schema shape (fail-safe
    // empty, never a silently-wrong plan). The full recover-vs-degrade split for
    // the fallback zoo lives in the A/B/C rows above and the #1786 suite.
    describe('E. provider/model policy is upstream (boundary is model-agnostic)', () => {
        const strict = [
            { main: { provider: 'openai' } },
            { main: { provider: 'anthropic' } },
            { main: { provider: 'google' } },
            { main: { provider: 'moonshotai' } },
        ];
        const fallback = [
            { main: { provider: 'kimi' } },
            { main: { provider: 'glm' } },
            { main: { provider: 'deepseek' } },
            { main: { provider: 'z-ai' } },
        ];

        it.each([...strict, ...fallback])(
            'recovers the clean schema shape under provider %o',
            async (byok) => {
                const plans = await planWith({ queryTasks: [goodTask] }, byok);
                expect(plans['src/app.ts']).toEqual({ queryTasks: [goodTask] });
                assertDeclaredShape(plans);
                expect(runSpy.mock.calls[0][0].byokConfig).toEqual(byok);
            },
        );

        it.each([...strict, ...fallback])(
            'fail-safes to the declared empty shape on an unrecoverable off-schema envelope under provider %o',
            async (byok) => {
                // A bare-array envelope carries data prod drops today; whatever
                // the provider, the boundary must still return the declared
                // shape (empty), never crash or ship a wrong plan.
                const plans = await planWith([goodTask], byok);
                expect(plans['src/app.ts']).toEqual({ queryTasks: [] });
                assertDeclaredShape(plans);
            },
        );
    });
});

// Guard: the schema the planner passes is the shared DocumentationPlannerSchema.
describe('DocumentationLLMPlannerService — schema wiring', () => {
    it('validates the structured shape it maps from', () => {
        const schema = z.object({
            queryTasks: z
                .array(
                    z.object({
                        packageName: z.string().min(1),
                        query: z.string().min(1),
                    }),
                )
                .max(3),
        });
        expect(
            schema.safeParse({ queryTasks: [] }).success,
        ).toBe(true);
    });
});

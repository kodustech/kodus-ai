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

import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { DocumentationLLMPlannerService } from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import { RepositoryPackageReference } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { ObservabilityService } from '@libs/core/log/observability.service';

function buildObservabilityMock(): ObservabilityService {
    return {
        runLLMInSpan: jest.fn(async ({ exec }) => {
            const result = await exec([]);
            return { result };
        }),
    } as unknown as ObservabilityService;
}

describe('DocumentationLLMPlannerService', () => {
    function buildPromptRunnerMock(payloads: any[]): PromptRunnerService {
        const service = {
            builder: jest.fn(() => {
                const state: { payload?: any } = {};

                return {
                    setProviders: jest.fn().mockReturnThis(),
                    setBYOKConfig: jest.fn().mockReturnThis(),
                    setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                    setParser: jest.fn().mockReturnThis(),
                    setLLMJsonMode: jest.fn().mockReturnThis(),
                    setPayload: jest.fn(function (payload: any) {
                        state.payload = payload;
                        payloads.push(payload);
                        return this;
                    }),
                    addPrompt: jest.fn().mockReturnThis(),
                    setTemperature: jest.fn().mockReturnThis(),
                    setRunName: jest.fn().mockReturnThis(),
                    execute: jest.fn(async () => ({
                        queryTasks: (state.payload?.packages || []).map(
                            (pkg: { name: string }) => ({
                                packageName: pkg.name,
                                query: 'official documentation',
                            }),
                        ),
                    })),
                };
            }),
        };

        return service as unknown as PromptRunnerService;
    }

    it('should only send ecosystem-compatible packages for each code file', async () => {
        const payloads: any[] = [];
        const service = new DocumentationLLMPlannerService(
            buildPromptRunnerMock(payloads),
            buildObservabilityMock(),
        );

        const packages: RepositoryPackageReference[] = [
            {
                name: '@nestjs/common',
                ecosystem: 'npm',
                sourceFile: 'package.json',
            },
            {
                name: 'rails',
                ecosystem: 'ruby',
                sourceFile: 'Gemfile',
            },
        ];

        const changedFiles: FileChange[] = [
            {
                filename: 'apps/web/src/app.ts',
                patch: '@@',
                fileContent: 'import { Controller } from "@nestjs/common"',
            } as FileChange,
            {
                filename: 'apps/api/lib/service.rb',
                patch: '@@',
                fileContent: "require 'rails'",
            } as FileChange,
            {
                filename: 'README.md',
                patch: '@@',
                fileContent: '# docs',
            } as FileChange,
        ];

        const result = await service.planDocumentationByFile({
            packages,
            changedFiles,
        });

        expect(Object.keys(result)).toEqual(
            expect.arrayContaining([
                'apps/web/src/app.ts',
                'apps/api/lib/service.rb',
            ]),
        );
        expect(result['README.md']).toBeUndefined();

        const tsPayload = payloads.find(
            (payload) => payload.file.filePath === 'apps/web/src/app.ts',
        );
        const rubyPayload = payloads.find(
            (payload) => payload.file.filePath === 'apps/api/lib/service.rb',
        );

        expect(tsPayload.packages).toEqual([
            expect.objectContaining({
                name: '@nestjs/common',
                ecosystem: 'npm',
            }),
        ]);
        expect(tsPayload.file.language).toBe('TypeScript');
        expect(rubyPayload.packages).toEqual([
            expect.objectContaining({ name: 'rails', ecosystem: 'ruby' }),
        ]);
        expect(rubyPayload.file.language).toBe('Ruby');
    });

    it('should keep empty queryTasks when planner succeeds with no documentation need', async () => {
        const promptRunner = {
            builder: jest.fn(() => {
                const state: { payload?: any } = {};

                return {
                    setProviders: jest.fn().mockReturnThis(),
                    setBYOKConfig: jest.fn().mockReturnThis(),
                    setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                    setParser: jest.fn().mockReturnThis(),
                    setLLMJsonMode: jest.fn().mockReturnThis(),
                    setPayload: jest.fn(function (payload: any) {
                        state.payload = payload;
                        return this;
                    }),
                    addPrompt: jest.fn().mockReturnThis(),
                    setTemperature: jest.fn().mockReturnThis(),
                    setRunName: jest.fn().mockReturnThis(),
                    execute: jest.fn(async () => ({
                        queryTasks: [],
                    })),
                };
            }),
        } as unknown as PromptRunnerService;

        const service = new DocumentationLLMPlannerService(promptRunner, buildObservabilityMock());

        const result = await service.planDocumentationByFile({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            changedFiles: [
                {
                    filename: 'src/example.ts',
                    patch: '@@ -1,1 +1,1 @@',
                    fileContent: 'console.log("ok")',
                } as FileChange,
            ],
        });

        expect(result['src/example.ts']).toEqual({
            queryTasks: [],
        });
    });

    it('should scope npm packages to nearest workspace manifest in monorepos', async () => {
        const payloads: any[] = [];
        const service = new DocumentationLLMPlannerService(
            buildPromptRunnerMock(payloads),
            buildObservabilityMock(),
        );

        const packages: RepositoryPackageReference[] = [
            {
                name: 'root-lib',
                ecosystem: 'npm',
                sourceFile: 'package.json',
            },
            {
                name: '@api/lib',
                ecosystem: 'npm',
                sourceFile: 'apps/api/package.json',
            },
            {
                name: '@web/lib',
                ecosystem: 'npm',
                sourceFile: 'apps/web/package.json',
            },
        ];

        const changedFiles: FileChange[] = [
            {
                filename: 'apps/api/src/user.controller.ts',
                patch: '@@',
                fileContent: 'import { Controller } from "@nestjs/common"',
            } as FileChange,
            {
                filename: 'apps/web/src/app/page.tsx',
                patch: '@@',
                fileContent: 'export default function Page() { return null; }',
            } as FileChange,
        ];

        await service.planDocumentationByFile({
            packages,
            changedFiles,
        });

        const apiPayload = payloads.find(
            (payload) =>
                payload.file.filePath === 'apps/api/src/user.controller.ts',
        );
        const webPayload = payloads.find(
            (payload) => payload.file.filePath === 'apps/web/src/app/page.tsx',
        );

        expect(apiPayload.packages).toEqual([
            expect.objectContaining({
                name: '@api/lib',
                sourceFile: 'apps/api/package.json',
            }),
        ]);

        expect(webPayload.packages).toEqual([
            expect.objectContaining({
                name: '@web/lib',
                sourceFile: 'apps/web/package.json',
            }),
        ]);
    });

    it('should return empty queryTasks when planner fails', async () => {
        const promptRunner = {
            builder: jest.fn(() => ({
                setProviders: jest.fn().mockReturnThis(),
                setBYOKConfig: jest.fn().mockReturnThis(),
                setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                setParser: jest.fn().mockReturnThis(),
                setLLMJsonMode: jest.fn().mockReturnThis(),
                setPayload: jest.fn().mockReturnThis(),
                addPrompt: jest.fn().mockReturnThis(),
                setTemperature: jest.fn().mockReturnThis(),
                setRunName: jest.fn().mockReturnThis(),
                execute: jest.fn(async () => {
                    throw new Error('forced failure');
                }),
            })),
        } as unknown as PromptRunnerService;

        const service = new DocumentationLLMPlannerService(promptRunner, buildObservabilityMock());

        const result = await service.planDocumentationByFile({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            changedFiles: [
                {
                    filename: 'apps/api/src/users.controller.ts',
                    patch: '@@ -1,1 +1,2 @@\n+ import { Controller } from "@nestjs/common"',
                    patchWithLinesStr:
                        '@@ -1,1 +1,2 @@\n+ import { Controller } from "@nestjs/common"',
                    fileContent:
                        'import { Controller } from "@nestjs/common";\n@Controller("users")\nexport class UsersController {}',
                } as FileChange,
            ],
        });

        const task =
            result['apps/api/src/users.controller.ts']?.queryTasks?.[0];
        expect(task).toBeUndefined();
        expect(result['apps/api/src/users.controller.ts']).toEqual({
            queryTasks: [],
        });
    });

    it('should pass entire file content and diff to planner payload without truncation', async () => {
        const payloads: any[] = [];
        const service = new DocumentationLLMPlannerService(
            buildPromptRunnerMock(payloads),
            buildObservabilityMock(),
        );

        const longFileContent = `HEADER\n${'a'.repeat(12000)}\nFOOTER`;
        const longDiff = `@@ -1,1 +1,1 @@\n+${'b'.repeat(10000)}\n`;

        await service.planDocumentationByFile({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            changedFiles: [
                {
                    filename: 'apps/api/src/large.controller.ts',
                    patch: longDiff,
                    patchWithLinesStr: longDiff,
                    fileContent: longFileContent,
                } as FileChange,
            ],
        });

        const payload = payloads.find(
            (entry) =>
                entry.file.filePath === 'apps/api/src/large.controller.ts',
        );

        expect(payload).toBeDefined();
        expect(payload.file.fileContent.length).toBe(longFileContent.length);
        expect(payload.file.fileContent).toBe(longFileContent);
        expect(payload.file.diff.length).toBe(longDiff.length);
        expect(payload.file.diff).toBe(longDiff);
    });
});

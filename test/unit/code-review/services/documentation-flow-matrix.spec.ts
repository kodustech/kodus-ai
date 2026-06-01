import {
    BYOKProviderService,
    LLMProviderService,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { DocumentationLLMPlannerService } from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { RepositoryPackageReference } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Logger } from '@nestjs/common';

type MatrixScenario = {
    name: string;
    filePath: string;
    fileContent: string;
    patchWithLinesStr: string;
    packageName: string;
    packageEcosystem: RepositoryPackageReference['ecosystem'];
    docNeedle: string;
};

const longRunningTestsEnabled = process.env.LONG_RUNNING_TESTS === 'true';

const GOOGLE_KEY =
    process.env.API_GOOGLE_AI_API_KEY || process.env.GOOGLE_API_KEY;
const EXA_KEY = process.env.API_EXA_KEY;
const CRYPTO_KEY = process.env.API_CRYPTO_KEY;

const hasRequiredKeys = Boolean(GOOGLE_KEY && EXA_KEY && CRYPTO_KEY);

const shouldRunTests = longRunningTestsEnabled && hasRequiredKeys;

const describeIfKeys = shouldRunTests ? describe : describe.skip;

describeIfKeys('Documentation Flow Matrix (Jest)', () => {
    jest.setTimeout(180000);

    function buildRealPromptRunnerService(): PromptRunnerService {
        const logger = new Logger('DocumentationFlowMatrixTest');
        const byokProviderService = new BYOKProviderService();
        const llmProviderService = new LLMProviderService(
            logger,
            byokProviderService,
        );

        return new PromptRunnerService(logger, llmProviderService);
    }

    class RealEnvConfigService {
        get<T>(key: string): T | undefined {
            return process.env[key] as T | undefined;
        }
    }

    class InMemoryDocumentationCache {
        private readonly items = new Map<string, any>();

        async get(params: {
            provider: string;
            packageNameNormalized: string;
            queryNormalized: string;
        }): Promise<any> {
            const key = `${params.provider}:${params.packageNameNormalized}:${params.queryNormalized}`;
            return this.items.get(key) || null;
        }

        async set(params: {
            provider: string;
            packageNameNormalized: string;
            queryNormalized: string;
            documentationItem: any;
        }): Promise<void> {
            const key = `${params.provider}:${params.packageNameNormalized}:${params.queryNormalized}`;
            this.items.set(key, params.documentationItem);
        }
    }

    const scenarios: MatrixScenario[] = [
        {
            name: 'TypeScript + NestJS',
            filePath: 'apps/api/src/users/users.controller.ts',
            fileContent:
                "import { Controller, Get, Param } from '@nestjs/common';\n@Controller('users')\nexport class UsersController {\n  @Get(':id')\n  findOne(@Param('id') id: string) { return { id }; }\n}\n",
            patchWithLinesStr:
                "1 + import { ParseUUIDPipe } from '@nestjs/common';\n2 + findOne(@Param('id', ParseUUIDPipe) id: string)",
            packageName: '@nestjs/common',
            packageEcosystem: 'npm',
            docNeedle: 'nestjs',
        },
        {
            name: 'TypeScript + React',
            filePath: 'apps/web/src/components/profile.tsx',
            fileContent:
                "import { useMemo, useState } from 'react';\nexport function Profile() { const [name] = useState('Ada'); const upper = useMemo(() => name.toUpperCase(), [name]); return <div>{upper}</div>; }\n",
            patchWithLinesStr:
                "1 + import { useMemo } from 'react';\n2 + const upper = useMemo(() => name.toUpperCase(), [name]);",
            packageName: 'react',
            packageEcosystem: 'npm',
            docNeedle: 'react',
        },
        {
            name: 'Python + FastAPI',
            filePath: 'apps/api/routes/users.py',
            fileContent:
                "from fastapi import APIRouter, HTTPException\nrouter = APIRouter()\n@router.get('/users/{user_id}')\nasync def get_user(user_id: str):\n    if not user_id:\n        raise HTTPException(status_code=400, detail='missing user id')\n",
            patchWithLinesStr:
                "1 + from fastapi import HTTPException\n2 + raise HTTPException(status_code=400, detail='missing user id')",
            packageName: 'fastapi',
            packageEcosystem: 'pip',
            docNeedle: 'fastapi',
        },
        {
            name: 'Java + Spring',
            filePath: 'apps/api/src/main/java/com/example/UserController.java',
            fileContent:
                'import org.springframework.web.bind.annotation.RequestParam;\npublic String list(@RequestParam(defaultValue = "10") int limit) { return "limit=" + limit; }\n',
            patchWithLinesStr:
                '1 + import org.springframework.web.bind.annotation.RequestParam;\n2 + public String list(@RequestParam(defaultValue = "10") int limit)',
            packageName: 'org.springframework.boot:spring-boot-starter-web',
            packageEcosystem: 'maven',
            docNeedle: 'spring',
        },
        {
            name: 'Ruby + Rails',
            filePath: 'apps/api/app/controllers/users_controller.rb',
            fileContent:
                'class UsersController < ApplicationController\n  before_action :validate_id\n  def show\n    render json: { id: params[:id] }\n  end\nend\n',
            patchWithLinesStr:
                '1 + before_action :validate_id\n2 + head :bad_request if params[:id].blank?',
            packageName: 'rails',
            packageEcosystem: 'ruby',
            docNeedle: 'rails',
        },
    ];

    it.each(scenarios)(
        'should create queries, retrieve docs, summarize docs, and inject docs for $name',
        async (scenario) => {
            const plannerService = new DocumentationLLMPlannerService(
                buildRealPromptRunnerService(),
            );

            const changedFiles: FileChange[] = [
                {
                    filename: scenario.filePath,
                    patch: scenario.patchWithLinesStr,
                    patchWithLinesStr: scenario.patchWithLinesStr,
                    fileContent: scenario.fileContent,
                } as FileChange,
            ];

            const packages: RepositoryPackageReference[] = [
                {
                    name: scenario.packageName,
                    ecosystem: scenario.packageEcosystem,
                    sourceFile:
                        scenario.packageEcosystem === 'npm'
                            ? 'package.json'
                            : scenario.packageEcosystem === 'pip'
                              ? 'requirements.txt'
                              : scenario.packageEcosystem === 'ruby'
                                ? 'Gemfile'
                                : 'pom.xml',
                },
            ];

            const planByFile = await plannerService.planDocumentationByFile({
                packages,
                changedFiles,
            });

            const filePlan = planByFile[scenario.filePath];
            expect(filePlan).toBeDefined();
            expect(filePlan.queryTasks.length).toBeGreaterThan(0);
            expect(
                filePlan.queryTasks.some(
                    (task) =>
                        task.packageName.toLowerCase() ===
                        scenario.packageName.toLowerCase(),
                ),
            ).toBe(true);

            const searchService = new DocumentationSearchExaService(
                new RealEnvConfigService() as any,
                new InMemoryDocumentationCache() as any,
                buildRealPromptRunnerService(),
            );

            const docsByFile = await searchService.searchByFilePlan(planByFile);
            const docs = docsByFile[scenario.filePath] || [];

            expect(docs.length).toBeGreaterThan(0);
            const combinedDocText =
                `${docs[0].title || ''} ${docs[0].snippet || ''} ${docs[0].url || ''}`.toLowerCase();
            expect(combinedDocText).toContain(scenario.docNeedle);

            const {
                prompt_codereview_system_gemini_v2,
            } = require('@libs/common/utils/langchainCommon/prompts/configuration/codeReview');

            const systemPrompt = prompt_codereview_system_gemini_v2({
                languageResultPrompt: 'en-US',
                fileContent: scenario.fileContent,
                relevantContent: scenario.fileContent,
                patchWithLinesStr: scenario.patchWithLinesStr,
                documentationContext: docs,
            });

            expect(systemPrompt).toContain('## Documentation Context');
            expect(systemPrompt.toLowerCase()).toContain(scenario.docNeedle);
        },
    );
});

if (!longRunningTestsEnabled) {
    console.warn(
        'Skipping Documentation Flow Matrix tests. LONG_RUNNING_TESTS env variable is not set to "true".',
    );
} else if (!hasRequiredKeys) {
    console.warn(
        'Skipping Documentation Flow Matrix tests. Missing required env keys: API_GOOGLE_AI_API_KEY (or GOOGLE_API_KEY), API_EXA_KEY, API_CRYPTO_KEY.',
    );
}

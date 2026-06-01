export const DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN = Symbol.for(
    'DocumentationLLMPlannerService',
);

import { createLogger } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { SUPPORTED_LANGUAGES } from '@libs/code-review/domain/contracts/SupportedLanguages';
import {
    DocumentationQueryPlanByFile,
    DocumentationQueryTask,
    RepositoryPackageReference,
} from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import {
    DocumentationPlannerPayload,
    DocumentationPlannerSchema,
    DocumentationPlannerSchemaType,
    prompt_code_review_documentation_planner_system,
    prompt_code_review_documentation_planner_user,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewDocumentationPlanner';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { Injectable } from '@nestjs/common';
import path from 'path';

@Injectable()
export class DocumentationLLMPlannerService {
    private readonly logger = createLogger(DocumentationLLMPlannerService.name);

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
    ) {}

    async planDocumentationByFile(params: {
        packages: RepositoryPackageReference[];
        changedFiles: FileChange[];
        byokConfig?: BYOKConfig;
        organizationAndTeamData?: OrganizationAndTeamData;
    }): Promise<Record<string, DocumentationQueryPlanByFile>> {
        const { packages, changedFiles, byokConfig, organizationAndTeamData } =
            params;

        const codeFiles = changedFiles.filter((file) =>
            this.isCodeFile(file.filename),
        );

        if (!codeFiles.length) {
            return {};
        }

        const provider = LLMModelProvider.GEMINI_3_1_FLASH_LITE_PREVIEW;
        const fallbackProvider = LLMModelProvider.GEMINI_3_FLASH_PREVIEW;
        const runName = 'documentationPlanner';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            byokConfig,
        );

        const packageSlice = packages;
        const plans: Record<string, DocumentationQueryPlanByFile> = {};

        try {
            const settled = await Promise.allSettled(
                codeFiles.map(async (file) => {
                    const filePackages = this.filterPackagesForFile(
                        packageSlice,
                        file.filename,
                    );

                    const payload: DocumentationPlannerPayload = {
                        packages: filePackages,
                        file: {
                            filePath: file.filename,
                            language:
                                this.getLanguageNameForFile(file.filename) ||
                                'Unknown',
                            fileContent: file.fileContent || '',
                            diff: file.patchWithLinesStr || file.patch || '',
                        },
                    };

                    const fileRunName = `${runName}:${file.filename}`;
                    const spanName = `${DocumentationLLMPlannerService.name}::${fileRunName}`;

                    const { result: response } =
                        await this.observabilityService.runLLMInSpan({
                            spanName,
                            runName: fileRunName,
                            byokConfig,
                            attrs: {
                                type: promptRunner.executeMode,
                                organizationId:
                                    organizationAndTeamData?.organizationId,
                                filePath: file.filename,
                            },
                            exec: (callbacks) =>
                                promptRunner
                                    .builder()
                                    .setParser(
                                        ParserType.ZOD,
                                        DocumentationPlannerSchema,
                                    )
                                    .setLLMJsonMode(true)
                                    .setPayload(payload)
                                    .addPrompt({
                                        role: PromptRole.SYSTEM,
                                        prompt: prompt_code_review_documentation_planner_system,
                                    })
                                    .addPrompt({
                                        role: PromptRole.USER,
                                        prompt: prompt_code_review_documentation_planner_user,
                                    })
                                    .addMetadata({
                                        context:
                                            DocumentationLLMPlannerService.name,
                                        runName: fileRunName,
                                        metadata: {
                                            filePath: file.filename,
                                            language:
                                                this.getLanguageNameForFile(
                                                    file.filename,
                                                ) || 'Unknown',
                                            packageCandidates:
                                                filePackages.length,
                                            hasByokConfig: Boolean(byokConfig),
                                            organizationAndTeamData,
                                        },
                                    })
                                    .setTemperature(0)
                                    .setRunName(fileRunName)
                                    .addCallbacks(callbacks)
                                    .execute(),
                        });

                    return {
                        file,
                        result: response as DocumentationPlannerSchemaType,
                    };
                }),
            );

            for (const [index, settledResult] of settled.entries()) {
                if (settledResult.status === 'fulfilled') {
                    const mapped = this.mapResultByFile(
                        settledResult.value.result,
                        this.getAllowedPackageNamesByFile(
                            packageSlice,
                            settledResult.value.file.filename,
                        ),
                    );

                    if (mapped) {
                        plans[settledResult.value.file.filename] = mapped;
                        continue;
                    }

                    plans[settledResult.value.file.filename] =
                        this.buildEmptyPlanForFile();
                    continue;
                }

                this.logger.warn({
                    message:
                        'Documentation planner LLM failed for one file; documentation queries will be empty for that file',
                    context: DocumentationLLMPlannerService.name,
                    metadata: {
                        fileName: codeFiles[index]?.filename,
                        runName: `${runName}:${codeFiles[index]?.filename || 'unknown'}`,
                        totalCodeFiles: codeFiles.length,
                        totalDiscoveredPackages: packageSlice.length,
                        hasByokConfig: Boolean(byokConfig),
                        organizationAndTeamData,
                    },
                    error: settledResult.reason,
                });

                const fallbackFile = codeFiles[index];
                if (fallbackFile) {
                    plans[fallbackFile.filename] = this.buildEmptyPlanForFile();
                }
            }

            return plans;
        } catch (error) {
            this.logger.warn({
                message:
                    'Documentation planner LLM failed; documentation queries will be empty',
                context: DocumentationLLMPlannerService.name,
                metadata: {
                    totalCodeFiles: codeFiles.length,
                    totalDiscoveredPackages: packageSlice.length,
                    hasByokConfig: Boolean(byokConfig),
                    organizationAndTeamData,
                },
                error,
            });

            return Object.fromEntries(
                codeFiles.map((file) => [
                    file.filename,
                    this.buildEmptyPlanForFile(),
                ]),
            );
        }
    }

    private mapResultByFile(
        result: DocumentationPlannerSchemaType,
        allowedPackageNames: Set<string>,
    ): DocumentationQueryPlanByFile | null {
        if (!result) {
            return null;
        }

        const rawQueryTasks = this.uniqueQueryTasks(result.queryTasks);

        if (!rawQueryTasks.length) {
            return {
                queryTasks: [],
            };
        }

        const queryTasks = rawQueryTasks.filter((task) =>
            allowedPackageNames.has(task.packageName.toLowerCase()),
        );

        if (!queryTasks.length) {
            return null;
        }

        return {
            queryTasks,
        };
    }

    private buildEmptyPlanForFile(): DocumentationQueryPlanByFile {
        return {
            queryTasks: [],
        };
    }

    private uniqueQueryTasks(
        tasks: DocumentationQueryTask[],
    ): DocumentationQueryTask[] {
        const seen = new Set<string>();
        const result: DocumentationQueryTask[] = [];

        for (const task of tasks || []) {
            const normalizedPackageName = (task?.packageName || '').trim();
            const normalizedQuery = (task?.query || '').trim();

            if (!normalizedPackageName || !normalizedQuery) {
                continue;
            }

            const key = `${normalizedPackageName.toLowerCase()}::${normalizedQuery.toLowerCase()}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            result.push(
                this.createQueryTask(normalizedPackageName, normalizedQuery),
            );
        }

        return result;
    }

    private createQueryTask(
        packageName: string,
        query: string,
    ): DocumentationQueryTask {
        return {
            packageName,
            query,
        };
    }

    private filterPackagesForFile(
        packages: RepositoryPackageReference[],
        filePath: string,
    ): RepositoryPackageReference[] {
        const ecosystems = this.getAllowedEcosystemsForFile(filePath);

        if (!ecosystems.length) {
            return [];
        }

        return ecosystems.flatMap((ecosystem) =>
            this.scopePackagesToNearestManifestDirectory(
                filePath,
                packages.filter((pkg) => pkg.ecosystem === ecosystem),
            ),
        );
    }

    private scopePackagesToNearestManifestDirectory(
        filePath: string,
        packages: RepositoryPackageReference[],
    ): RepositoryPackageReference[] {
        if (!packages.length) {
            return [];
        }

        const fileDirectory = this.normalizeDirectory(
            path.posix.dirname(filePath),
        );

        const manifestDirectories = [
            ...new Set(
                packages.map((pkg) =>
                    this.normalizeDirectory(path.posix.dirname(pkg.sourceFile)),
                ),
            ),
        ].filter((directory) =>
            this.isAncestorDirectory(directory, fileDirectory),
        );

        if (!manifestDirectories.length) {
            return packages;
        }

        const nearestDirectory = manifestDirectories.sort(
            (a, b) => b.length - a.length,
        )[0];

        return packages.filter(
            (pkg) =>
                this.normalizeDirectory(path.posix.dirname(pkg.sourceFile)) ===
                nearestDirectory,
        );
    }

    private isAncestorDirectory(
        candidateDirectory: string,
        fileDirectory: string,
    ): boolean {
        if (!candidateDirectory) {
            return true;
        }

        return (
            fileDirectory === candidateDirectory ||
            fileDirectory.startsWith(`${candidateDirectory}/`)
        );
    }

    private normalizeDirectory(directory: string): string {
        if (!directory || directory === '.' || directory === '/') {
            return '';
        }

        return directory.replace(/^\/+|\/+$/g, '');
    }

    private getAllowedPackageNamesByFile(
        packages: RepositoryPackageReference[],
        filePath: string,
    ): Set<string> {
        return new Set(
            this.filterPackagesForFile(packages, filePath).map((pkg) =>
                pkg.name.toLowerCase(),
            ),
        );
    }

    private getAllowedEcosystemsForFile(
        filePath: string,
    ): RepositoryPackageReference['ecosystem'][] {
        const language = this.getLanguageNameForFile(filePath)?.toLowerCase();

        switch (language) {
            case 'typescript':
            case 'javascript':
                return ['npm'];
            case 'python':
                return ['pip'];
            case 'java':
                return ['maven', 'gradle'];
            case 'go':
                return ['go'];
            case 'ruby':
                return ['ruby'];
            case 'rust':
                return ['cargo'];
            default:
                return [];
        }
    }

    private getLanguageNameForFile(filePath: string): string | null {
        const extension = path.posix.extname(filePath).toLowerCase();

        if (!extension) {
            return null;
        }

        const language = Object.values(SUPPORTED_LANGUAGES).find((lang) =>
            lang.extensions.includes(extension),
        )?.name;

        if (!language) {
            return null;
        }

        const normalizedLabels: Record<string, string> = {
            typescript: 'TypeScript',
            javascript: 'JavaScript',
            python: 'Python',
            java: 'Java',
            go: 'Go',
            ruby: 'Ruby',
            rust: 'Rust',
        };

        return normalizedLabels[language.toLowerCase()] || language;
    }

    private isCodeFile(filePath: string): boolean {
        const extension = path.posix.extname(filePath).toLowerCase();

        if (!extension) {
            return false;
        }

        return Object.values(SUPPORTED_LANGUAGES).some((lang) =>
            lang.extensions.includes(extension),
        );
    }
}

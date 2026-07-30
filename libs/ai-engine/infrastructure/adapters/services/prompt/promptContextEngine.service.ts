import {
    ContextDependency,
    ContextRequirement,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { createLogger } from '@libs/core/log/logger';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';

import { IPromptContextEngineService } from '@libs/ai-engine/domain/prompt/contracts/promptContextEngine.contract';
import {
    PromptSourceType,
    IDetectedReference,
    IFileReference,
    IPromptReferenceSyncError,
    PromptReferenceErrorType,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { ReferenceDetectorService } from '@libs/ai-engine/infrastructure/adapters/services/reference-detector.service';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { calculatePromptHash } from '@libs/common/utils/prompt-parser.utils';

interface DetectReferencesParams {
    requirementId: string;
    promptText: string;
    path: string[];
    sourceType: PromptSourceType;
    repositoryId: string;
    repositoryName: string;
    organizationAndTeamData: OrganizationAndTeamData;
    context?: 'rule' | 'instruction' | 'prompt';
    detectionMode?: 'rule' | 'prompt';
    byokConfig?: BYOKConfig;
    subscriptionStatus?: string;
}

interface DetectionResult {
    references: IFileReference[];
    syncErrors: IPromptReferenceSyncError[];
    detectedMarkers: string[];
    requirements: ContextRequirement[];
    promptHash: string;
}

const DEFAULT_DOMAIN = 'code';
const DEFAULT_INTENT = 'review';

@Injectable()
export class PromptContextEngineService implements IPromptContextEngineService {
    private readonly logger = createLogger(PromptContextEngineService.name);
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        private readonly codeManagementService: CodeManagementService,
        private readonly referenceDetectorService: ReferenceDetectorService,
    ) {}

    async detectAndResolveReferences(params: DetectReferencesParams): Promise<{
        references: IFileReference[];
        syncErrors?: IPromptReferenceSyncError[];
        promptHash: string;
        requirements: ContextRequirement[];
        markers: string[];
    }> {
        const detection = await this.runDetection(params);

        return {
            references: detection.references,
            syncErrors: detection.syncErrors,
            promptHash: detection.promptHash,
            requirements: detection.requirements,
            markers: detection.detectedMarkers,
        };
    }

    calculatePromptHash(promptText: string): string {
        return calculatePromptHash(promptText);
    }

    private async runDetection(
        params: DetectReferencesParams,
    ): Promise<DetectionResult> {
        const promptHash = this.calculatePromptHash(params.promptText);

        const skipPrefilter = params.detectionMode === 'rule';

        if (
            !skipPrefilter &&
            !this.referenceDetectorService.hasLikelyExternalReferences(
                params.promptText,
            )
        ) {
            this.logger.debug({
                message:
                    'No external reference patterns detected (regex pre-filter)',
                context: PromptContextEngineService.name,
                metadata: {
                    promptHash,
                    requirementId: params.requirementId,
                    sourceType: params.sourceType,
                },
            });

            const requirement = this.buildRequirement({
                params,
                references: [],
                syncErrors: [],
                markers: [],
                promptHash,
            });

            return {
                references: [],
                syncErrors: [],
                detectedMarkers: [],
                promptHash,
                requirements: requirement ? [requirement] : [],
            };
        }

        try {
            const detectedReferences =
                await this.referenceDetectorService.detectReferences({
                    requirementId: params.requirementId,
                    promptText: params.promptText,
                    organizationAndTeamData: params.organizationAndTeamData,
                    context: params.context,
                    detectionMode: params.detectionMode,
                    byokConfig: params.byokConfig,
                    subscriptionStatus: params.subscriptionStatus,
                });

            if (!detectedReferences.length) {
                const requirement = this.buildRequirement({
                    params,
                    references: [],
                    syncErrors: [],
                    markers: [],
                    promptHash,
                });

                return {
                    references: [],
                    syncErrors: [],
                    detectedMarkers: [],
                    promptHash,
                    requirements: requirement ? [requirement] : [],
                };
            }

            const { references, notFoundDetails } =
                await this.searchFilesInRepository(detectedReferences, params);

            const markers = this.referenceDetectorService.extractMarkers(
                params.promptText,
                references,
            );

            const requirement = this.buildRequirement({
                params,
                references,
                syncErrors: notFoundDetails,
                markers,
                promptHash,
            });

            return {
                references,
                syncErrors: notFoundDetails,
                detectedMarkers: markers,
                promptHash,
                requirements: requirement ? [requirement] : [],
            };
        } catch (error) {
            this.logger.error({
                message: 'Error detecting and resolving external references',
                context: PromptContextEngineService.name,
                error,
                metadata: {
                    requirementId: params.requirementId,
                    repositoryId: params.repositoryId,
                    organizationId:
                        params.organizationAndTeamData.organizationId,
                    sourceType: params.sourceType,
                },
            });

            const syncErrors: IPromptReferenceSyncError[] = [
                {
                    type: PromptReferenceErrorType.DETECTION_FAILED,
                    message: `Error during reference detection: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    details: {
                        timestamp: new Date(),
                    },
                },
            ];

            const requirement = this.buildRequirement({
                params,
                references: [],
                syncErrors,
                markers: [],
                promptHash,
            });

            return {
                references: [],
                syncErrors,
                detectedMarkers: [],
                promptHash,
                requirements: requirement ? [requirement] : [],
            };
        }
    }

    private async searchFilesInRepository(
        detectedReferences: IDetectedReference[],
        params: DetectReferencesParams,
    ): Promise<{
        references: IFileReference[];
        notFoundDetails: IPromptReferenceSyncError[];
    }> {
        const resolvedReferences: IFileReference[] = [];
        const notFoundDetails: IPromptReferenceSyncError[] = [];

        for (const ref of detectedReferences) {
            try {
                const integrationConfig =
                    await this.integrationConfigService.findOne({
                        configKey: IntegrationConfigKey.REPOSITORIES,
                        team: { uuid: params.organizationAndTeamData?.teamId },
                        configValue: [{ name: ref.repositoryName?.toString() }],
                        integration: {
                            status: true,
                        },
                    });

                const repositoryName =
                    ref.repositoryName ?? params.repositoryName;

                let targetRepo = {
                    id: params.repositoryId,
                    name: repositoryName,
                };

                if (
                    integrationConfig &&
                    integrationConfig?.configValue?.length > 0
                ) {
                    const repositories =
                        integrationConfig?.configValue as Repositories[];

                    targetRepo = repositories?.find(
                        (repo) => repo.name === repositoryName,
                    ) ?? {
                        id: params.repositoryId,
                        name: repositoryName,
                    };
                }

                const found = await this.findFileWithHybridStrategy(
                    ref,
                    targetRepo.id,
                    targetRepo.name,
                    params.organizationAndTeamData,
                );

                if (found.length > 0) {
                    resolvedReferences.push(...found);
                    this.logger.debug({
                        message: 'Resolved external reference',
                        context: PromptContextEngineService.name,
                        metadata: {
                            fileName: ref.fileName,
                            filesFound: found.length,
                            paths: found.map((r) => r.filePath),
                            repositoryName: ref.repositoryName,
                            crossRepo: !!ref.repositoryName,
                            organizationAndTeamData:
                                params.organizationAndTeamData,
                        },
                    });
                } else {
                    const fileIdentifier = ref.repositoryName
                        ? `${ref.repositoryName}/${ref.fileName}`
                        : ref.fileName;

                    notFoundDetails.push({
                        type: PromptReferenceErrorType.FILE_NOT_FOUND,
                        message: `File not found: ${fileIdentifier}`,
                        details: {
                            fileName: ref.fileName,
                            repositoryName:
                                ref.repositoryName || params.repositoryName,
                            attemptedPaths: this.buildSearchPatterns(ref),
                            timestamp: new Date(),
                        },
                    });
                }
            } catch (error) {
                notFoundDetails.push({
                    type: PromptReferenceErrorType.FETCH_FAILED,
                    message: `Error searching file: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                    details: {
                        fileName: ref.fileName,
                        repositoryName:
                            ref.repositoryName || params.repositoryName,
                        timestamp: new Date(),
                    },
                });

                this.logger.error({
                    message: 'Error searching for external reference file',
                    context: PromptContextEngineService.name,
                    error,
                    metadata: {
                        reference: ref,
                        repositoryId: params.repositoryId,
                        repositoryName: ref.repositoryName,
                        crossRepo: !!ref.repositoryName,
                        organizationAndTeamData: params.organizationAndTeamData,
                    },
                });
            }
        }

        return { references: resolvedReferences, notFoundDetails };
    }

    private async findFileWithHybridStrategy(
        ref: IDetectedReference,
        repositoryId: string,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IFileReference[]> {
        const filePatterns = this.buildSearchPatterns(ref);

        return await this.searchWithPatterns(
            filePatterns,
            repositoryId,
            repositoryName,
            organizationAndTeamData,
            ref,
        );
    }

    private buildSearchPatterns(ref: IDetectedReference): string[] {
        const patterns: string[] = [];

        if (ref.filePattern) {
            patterns.push(ref.filePattern);
        }

        const fileName = ref.fileName;
        patterns.push(`**/${fileName}`);

        const lowerFileName = fileName.toLowerCase();
        const upperFileName = fileName.toUpperCase();

        if (lowerFileName !== fileName) {
            patterns.push(`**/${lowerFileName}`);
        }
        if (upperFileName !== fileName) {
            patterns.push(`**/${upperFileName}`);
        }

        const capitalizedFileName =
            fileName.charAt(0).toUpperCase() + fileName.slice(1).toLowerCase();
        if (
            capitalizedFileName !== fileName &&
            capitalizedFileName !== lowerFileName &&
            capitalizedFileName !== upperFileName
        ) {
            patterns.push(`**/${capitalizedFileName}`);
        }

        // Extensionless candidates ("the README", "see CHANGELOG") are how
        // prose mentions files — try the markdown variant too, otherwise a
        // rule whose text merely says "README" gets a spurious 'file not
        // found: README' sync error while README.md sits in the repo root.
        if (!fileName.includes('.')) {
            patterns.push(`**/${fileName}.md`);
            patterns.push(`**/${upperFileName}.md`);
            patterns.push(`**/${lowerFileName}.md`);
            patterns.push(`**/${capitalizedFileName}.md`);
        }

        return [...new Set(patterns)];
    }

    private async searchWithPatterns(
        filePatterns: string[],
        repositoryId: string,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
        ref: IDetectedReference,
    ): Promise<IFileReference[]> {
        try {
            const targetRepoName = ref.repositoryName || repositoryName;
            const targetRepoId =
                repositoryId && repositoryId !== ref.repositoryName
                    ? repositoryId
                    : ref.repositoryName;
            const targetRepo = {
                id: targetRepoId,
                name: targetRepoName,
            };

            const files =
                await this.codeManagementService.getRepositoryAllFiles({
                    organizationAndTeamData,
                    repository: targetRepo,
                    filters: {
                        filePatterns,
                        maxFiles: 10,
                    },
                });

            if (files && files.length > 0) {
                return files.map((file) => ({
                    filePath: file.path,
                    description: ref.description,
                    originalText: ref.originalText,
                    lineRange: ref.lineRange,
                    repositoryName: targetRepo.name,
                    repositoryId: targetRepo.id,
                    lastContentHash: '',
                    lastValidatedAt: new Date(),
                    estimatedTokens: 0,
                }));
            }
        } catch (error) {
            this.logger.warn({
                message: 'Pattern search failed for external reference',
                context: PromptContextEngineService.name,
                error,
                metadata: {
                    filePatterns,
                    repositoryName: ref.repositoryName,
                    crossRepo: !!ref.repositoryName,
                    organizationAndTeamData,
                },
            });
        }

        return [];
    }

    private buildRequirement(input: {
        params: DetectReferencesParams;
        references: IFileReference[];
        syncErrors: IPromptReferenceSyncError[];
        markers: string[];
        promptHash: string;
    }): ContextRequirement | null {
        const { params, references, syncErrors, markers, promptHash } = input;

        const dependencies: ContextDependency[] = references.map(
            (reference, index) => ({
                type: 'knowledge',
                id: `${reference.repositoryName ?? params.repositoryName}|${
                    reference.filePath
                }|${index}`,
                metadata: {
                    repositoryId: reference.repositoryId ?? params.repositoryId,
                    repositoryName:
                        reference.repositoryName ?? params.repositoryName,
                    filePath: reference.filePath,
                    lineRange: reference.lineRange ?? null,
                    description: reference.description,
                    originalText: reference.originalText,
                    detectedAt: new Date().toISOString(),
                },
            }),
        );

        // Extract MCP dependencies from markers
        const mcpDependencies =
            this.referenceDetectorService.extractMCPDependencies(
                params.promptText,
                params.repositoryId,
            );
        dependencies.push(...mcpDependencies);

        return {
            id: params.requirementId,
            consumer: {
                id: params.requirementId,
                kind: 'prompt_section',
                name: params.sourceType,
                metadata: {
                    path: params.path,
                    sourceType: params.sourceType,
                },
            },
            request: {
                domain: DEFAULT_DOMAIN,
                taskIntent: DEFAULT_INTENT,
                signal: {
                    metadata: {
                        path: params.path,
                        sourceType: params.sourceType,
                    },
                },
            },
            dependencies,
            metadata: {
                path: params.path,
                sourceType: params.sourceType,
                inlineMarkers: markers,
                syncErrors,
                promptHash,
            },
            status: syncErrors.length ? 'draft' : 'active',
        };
    }
}

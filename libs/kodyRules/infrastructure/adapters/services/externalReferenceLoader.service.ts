import { CodeReviewContextPackService } from '@libs/ai-engine/infrastructure/adapters/services/context/code-review-context-pack.service';
import { AnalysisContext } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';

export interface LoadedReference {
    filePath: string;
    content: string;
    description?: string;
}

export interface LoadedReferencesResult {
    referencesMap: Map<string, LoadedReference[]>;
    mcpResultsMap: Map<string, Record<string, unknown>>;
}

@Injectable()
export class ExternalReferenceLoaderService {
    private readonly logger = createLogger(ExternalReferenceLoaderService.name);

    constructor(
        private readonly contextPackService: CodeReviewContextPackService,
    ) {}

    async loadReferences(
        rule: IKodyRule,
        context: AnalysisContext,
    ): Promise<{
        references: LoadedReference[];
        augmentations: Map<string, Record<string, unknown>>;
    }> {
        if (!rule.contextReferenceId) {
            this.logger.debug({
                message:
                    'Rule has no contextReferenceId, skipping reference loading',
                context: ExternalReferenceLoaderService.name,
                metadata: {
                    ruleUuid: rule.uuid,
                },
            });
            return { references: [], augmentations: new Map() };
        }

        try {
            return await this.loadFromContextPack(rule, context);
        } catch (error) {
            this.logger.warn({
                message: 'Failed to load references via Context Pack',
                context: ExternalReferenceLoaderService.name,
                error,
                metadata: {
                    ruleUuid: rule.uuid,
                    contextReferenceId: rule.contextReferenceId,
                },
            });
            return { references: [], augmentations: new Map() };
        }
    }

    private async loadFromContextPack(
        rule: IKodyRule,
        context: AnalysisContext,
    ): Promise<{
        references: LoadedReference[];
        augmentations: Map<string, Record<string, unknown>>;
    }> {
        if (!rule.contextReferenceId) {
            return { references: [], augmentations: new Map() };
        }

        try {
            const result = await this.contextPackService.buildContextPack({
                organizationAndTeamData: context.organizationAndTeamData,
                contextReferenceId: rule.contextReferenceId,
                repository: context.repository,
                pullRequest: context.pullRequest,
            });

            const layers = result.pack?.layers ?? [];
            const references: LoadedReference[] = [];
            for (const layer of layers) {
                const metadata = layer.metadata as Record<string, unknown>;
                if (metadata?.sourceType !== 'knowledge') {
                    continue;
                }
                if (Array.isArray(layer.content)) {
                    for (const entry of layer.content) {
                        if (
                            entry &&
                            typeof entry === 'object' &&
                            typeof (entry as Record<string, unknown>)
                                .filePath === 'string' &&
                            typeof (entry as Record<string, unknown>)
                                .content === 'string'
                        ) {
                            references.push({
                                filePath: (entry as Record<string, unknown>)
                                    .filePath as string,
                                content: (entry as Record<string, unknown>)
                                    .content as string,
                                description:
                                    typeof (entry as Record<string, unknown>)
                                        .description === 'string'
                                        ? ((entry as Record<string, unknown>)
                                              .description as string)
                                        : undefined,
                            });
                        }
                    }
                }
            }

            if (references.length) {
                this.logger.log({
                    message:
                        'Loaded references via Context Pack for Kody Rule context',
                    context: ExternalReferenceLoaderService.name,
                    metadata: {
                        ruleUuid: rule.uuid,
                        contextReferenceId: rule.contextReferenceId,
                        referencesCount: references.length,
                    },
                });
            }

            const augmentations = new Map<string, Record<string, unknown>>();
            if (result.augmentations) {
                for (const [pathKey, entry] of Object.entries(
                    result.augmentations,
                )) {
                    const outputs = entry.outputs ?? [];
                    outputs.forEach((output, index) => {
                        if (output.success && output.output) {
                            augmentations.set(`${pathKey}::${index}`, {
                                provider: output.provider,
                                toolName: output.toolName,
                                output: output.output,
                            } as Record<string, unknown>);
                        }
                    });
                }
            }
            return { references, augmentations };
        } catch (error) {
            this.logger.warn({
                message: 'Failed to load references via Context Pack',
                context: ExternalReferenceLoaderService.name,
                error,
                metadata: {
                    ruleUuid: rule.uuid,
                    contextReferenceId: rule.contextReferenceId,
                },
            });
            return { references: [], augmentations: new Map() };
        }
    }

    async loadReferencesForRules(
        rules: Partial<IKodyRule>[],
        context: AnalysisContext,
    ): Promise<LoadedReferencesResult> {
        const referencesMap = new Map<string, LoadedReference[]>();
        const mcpResultsMap = new Map<string, Record<string, unknown>>();

        for (const rule of rules) {
            if (rule.uuid) {
                const { references, augmentations } = await this.loadReferences(
                    rule as IKodyRule,
                    context,
                );
                if (references.length > 0) {
                    referencesMap.set(rule.uuid, references);
                }
                if (augmentations.size > 0) {
                    mcpResultsMap.set(
                        rule.uuid,
                        Object.fromEntries(augmentations),
                    );
                }
            }
        }

        return { referencesMap, mcpResultsMap };
    }
}

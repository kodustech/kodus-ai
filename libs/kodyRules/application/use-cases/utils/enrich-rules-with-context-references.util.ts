import { SimpleLogger } from '@libs/core/log/logger';

import type { IContextReferenceService } from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import type { ContextReferenceEntity } from '@libs/ai-engine/domain/contextReference/entities/context-reference.entity';

type RuleWithContextId = {
    uuid?: string;
    contextReferenceId?: string;
};

type EnrichedFields = {
    referenceProcessingStatus: string | null;
    lastReferenceProcessedAt?: Date;
    externalReferences: Array<{
        filePath?: string;
        description?: string;
        originalText?: string;
        repositoryName?: string;
        lastValidatedAt?: Date;
    }>;
    syncErrors: any[];
};

export async function enrichRulesWithContextReferences<
    T extends RuleWithContextId,
>(
    rules: T[],
    contextReferenceService: IContextReferenceService,
    logger: SimpleLogger,
): Promise<Array<T & EnrichedFields>> {
    const list = rules || [];

    // Batch-load every referenced context in ONE query (`uuid IN (...)`)
    // instead of a findById per rule. This util runs once for the scope
    // listing and once per inherited bucket (global / repo / directory) on
    // every Kody Rules page load, so the per-rule round-trips added up to a
    // page-wide N+1. De-dupe ids first — global rules are commonly shared.
    const ids = Array.from(
        new Set(
            list
                .map((rule) => rule.contextReferenceId)
                .filter((id): id is string => Boolean(id)),
        ),
    );

    const byId = new Map<string, ContextReferenceEntity>();
    let batchFailed = false;

    if (ids.length > 0) {
        try {
            const refs = await contextReferenceService.findByIds(ids);
            for (const ref of refs) {
                if (ref?.uuid) {
                    byId.set(ref.uuid, ref);
                }
            }
        } catch (error) {
            // Preserve the old per-rule semantics: a fetch error marks the
            // referenced rules as 'failed' (vs 'pending' for a genuine
            // not-found), so the UI can still tell the two apart.
            batchFailed = true;
            logger.warn({
                message:
                    'Failed to batch-fetch context references while enriching kody rules',
                context: 'enrichRulesWithContextReferences',
                error,
                metadata: { contextReferenceIds: ids },
            });
        }
    }

    return list.map((rule) => {
        if (!rule.contextReferenceId) {
            return {
                ...rule,
                referenceProcessingStatus: null,
                externalReferences: [],
                syncErrors: [],
            };
        }

        const contextRef = byId.get(rule.contextReferenceId);

        if (!contextRef) {
            return {
                ...rule,
                referenceProcessingStatus: batchFailed ? 'failed' : 'pending',
                externalReferences: [],
                syncErrors: [],
            };
        }

        return {
            ...rule,
            referenceProcessingStatus: contextRef.processingStatus,
            lastReferenceProcessedAt: contextRef.lastProcessedAt,
            externalReferences: extractExternalReferences(contextRef),
            syncErrors: extractSyncErrors(contextRef),
        };
    });
}

function extractExternalReferences(
    contextRef: ContextReferenceEntity,
): EnrichedFields['externalReferences'] {
    const references: EnrichedFields['externalReferences'] = [];
    const requirements = contextRef.requirements || [];

    for (const requirement of requirements) {
        const dependencies = requirement.dependencies || [];

        for (const dep of dependencies) {
            if (dep.type === 'knowledge' && dep.metadata) {
                references.push({
                    filePath: dep.metadata.filePath as string | undefined,
                    description: dep.metadata.description as string | undefined,
                    originalText: dep.metadata.originalText as
                        | string
                        | undefined,
                    repositoryName: dep.metadata.repositoryName as
                        | string
                        | undefined,
                    lastValidatedAt:
                        dep.metadata.detectedAt != null
                            ? new Date(dep.metadata.detectedAt as string)
                            : undefined,
                });
            }
        }
    }

    return references;
}

function extractSyncErrors(contextRef: ContextReferenceEntity): any[] {
    const errors: any[] = [];
    const requirements = contextRef.requirements || [];

    for (const requirement of requirements) {
        const syncErrors = (requirement.metadata as any)?.syncErrors || [];
        errors.push(...syncErrors);
    }

    return errors;
}

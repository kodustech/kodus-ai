import type { ReviewWarning } from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import {
    KNOWLEDGE_MAIN_REVIEW_TARGET,
    knowledgeSourcePath,
    linksMainReview,
    type CustomAgentConfig,
    type KnowledgeItem,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import {
    type BaseBranchReader,
    createBaseBranchReader,
    type KnowledgeCodeManagementPort,
    type KnowledgeRepositoryListing,
    type KnowledgeRepositorySource,
    MultiRepositoryKnowledgeReader,
    resolveKnowledgeRepositories,
} from './base-branch-reader';
import {
    KnowledgeResolver,
    type ResolvedKnowledge,
    toReviewWarnings,
} from './knowledge-resolver';

const logger = createLogger('ReviewKnowledge');

export type ReviewKnowledge = {
    byTarget?: Map<string, ResolvedKnowledge>;
    reader?: BaseBranchReader;
    warnings: ReviewWarning[];
    /** Other repositories the linked skills and docs were read from. */
    sources?: KnowledgeRepositorySource[];
    /** The reviewed repository as the integration lists it, when the
     *  listing was fetched (only when another repository is linked). */
    reviewedRepository?: KnowledgeRepositoryListing;
};

/**
 * Skills and docs linked to the main review and to each custom agent, read
 * from the PR's target branch (#2172): in the sandbox checkout when there is
 * one, through the provider API otherwise. The review and Try it both read
 * them here. Nothing here fails the run: problems become warnings and the
 * run goes on with what could be read.
 */
export async function resolveReviewKnowledge(params: {
    items: KnowledgeItem[] | undefined;
    customAgents: CustomAgentConfig[];
    changedFiles: Array<{ filename?: string }>;
    baseBranch: string | undefined;
    sandbox: SandboxInstance | undefined;
    codeManagement: KnowledgeCodeManagementPort;
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id?: string | number; name?: string } | undefined;
    /** Who logs a failure (the caller's name). */
    logContext: string;
    /** The pull request, for the logs. */
    prNumber?: number;
}): Promise<ReviewKnowledge> {
    const { items, outsideMainReview } = mainReviewLinksDropped(
        params.items ?? [],
    );
    if (!items.length) return { warnings: outsideMainReview };
    const { baseBranch, repository, customAgents } = params;
    if (!baseBranch || !repository?.id) return { warnings: outsideMainReview };
    const ids = {
        organizationId: params.organizationAndTeamData?.organizationId,
        teamId: params.organizationAndTeamData?.teamId,
        repositoryId: repository.id,
        repositoryName: repository.name,
        prNumber: params.prNumber,
        baseBranch,
    };

    try {
        const local = createBaseBranchReader({
            sandbox: params.sandbox?.run ? params.sandbox : null,
            baseBranch,
            codeManagement: params.codeManagement,
            organizationAndTeamData: params.organizationAndTeamData,
            repository: {
                id: String(repository.id),
                name: repository.name,
            },
        });
        // Skills and docs of other repositories: read through the provider
        // API at their configured ref or default branch, never a ref the
        // pull request controls, and only from repositories the team's
        // integration reaches.
        const repositories = await resolveKnowledgeRepositories({
            items,
            codeManagement: params.codeManagement,
            organizationAndTeamData: params.organizationAndTeamData,
        });
        const reader: BaseBranchReader = repositories.sources.length
            ? new MultiRepositoryKnowledgeReader(local, repositories.sources)
            : local;
        const missing = new Set(
            repositories.missing.map((name) => name.toLowerCase()),
        );
        const readable = items.filter(
            (item) =>
                !item.repository || !missing.has(item.repository.toLowerCase()),
        );
        const byTarget = await new KnowledgeResolver(reader).resolveAll({
            items: readable,
            agentIds: customAgents.map((agent) => agent.id),
            changedFiles: params.changedFiles
                .map((file) => file.filename)
                .filter((name): name is string => !!name),
        });
        const names = new Map(customAgents.map((a) => [a.id, a.name]));
        const warnings = [...byTarget.entries()].flatMap(([target, resolved]) =>
            toReviewWarnings(
                resolved.warnings,
                target === KNOWLEDGE_MAIN_REVIEW_TARGET
                    ? undefined
                    : names.get(target),
            ),
        );
        for (const item of items) {
            if (!item.repository || !missing.has(item.repository.toLowerCase()))
                continue;
            for (const target of item.linkedTo ?? []) {
                const agentName =
                    typeof target === 'string'
                        ? undefined
                        : names.get(target.agentId);
                // A failed listing never looked the item up: it is
                // unavailable, not missing.
                if (repositories.listingFailed) {
                    warnings.push({
                        kind: 'KNOWLEDGE_UNAVAILABLE',
                        reason: 'knowledge',
                        contextWindowTokens: 0,
                        modelName: '',
                        detail: `${knowledgeSourcePath(item)}: the repositories of this team's integration could not be listed, so ${item.repository} was not read`,
                        ...(agentName ? { agentName } : {}),
                    });
                    continue;
                }
                warnings.push(
                    ...toReviewWarnings(
                        [
                            {
                                code:
                                    item.kind === 'skill'
                                        ? 'SKILL_NOT_FOUND'
                                        : 'DOC_NOT_FOUND',
                                path: knowledgeSourcePath(item),
                                detail: `${item.repository} is not connected to Kodus; select it in Git settings`,
                            },
                        ],
                        agentName,
                    ),
                );
            }
        }
        // What could not be read or was cut, by target: codes and paths only,
        // never the skill or doc text.
        const problems = [...byTarget.entries()].flatMap(([target, resolved]) =>
            resolved.warnings.map((w) => ({
                target,
                code: w.code,
                path: w.path,
            })),
        );
        if (problems.length || repositories.missing.length) {
            logger.warn({
                message: `[AGENT] ${problems.length} linked skill/doc problem(s); the review used what could be read`,
                context: params.logContext,
                metadata: {
                    ...ids,
                    problems,
                    missingRepositories: repositories.missing,
                },
            });
        }
        const reviewedRepository = repositories.listing.find(
            (repo) => String(repo.id) === String(repository.id),
        );
        return {
            byTarget,
            reader,
            warnings: [...outsideMainReview, ...warnings],
            ...(repositories.sources.length && {
                sources: repositories.sources.map((entry) => entry.source),
            }),
            ...(reviewedRepository && { reviewedRepository }),
        };
    } catch (err) {
        logger.warn({
            message: `[AGENT] Skills and docs could not be read; reviewing without them`,
            context: params.logContext,
            error: err,
            metadata: ids,
        });
        return {
            warnings: [
                ...outsideMainReview,
                {
                    kind: 'KNOWLEDGE_UNAVAILABLE',
                    reason: 'knowledge',
                    contextWindowTokens: 0,
                    modelName: '',
                    detail: 'the linked skills and docs could not be read; the review ran without them',
                },
            ],
        };
    }
}

/**
 * Guides of another repository are for custom agents only: the main review
 * has no quote gate to check a rule it cites. Settings refuse such a link on
 * save; a config that carries one anyway (written by hand or as code) keeps
 * its custom-agent links, loses the main-review one, and says so.
 */
export function mainReviewLinksDropped(all: KnowledgeItem[]): {
    items: KnowledgeItem[];
    outsideMainReview: ReviewWarning[];
} {
    const items: KnowledgeItem[] = [];
    const outsideMainReview: ReviewWarning[] = [];
    for (const item of all) {
        if (!item.repository || !linksMainReview(item)) {
            items.push(item);
            continue;
        }
        outsideMainReview.push({
            kind: 'KNOWLEDGE_UNAVAILABLE',
            reason: 'knowledge',
            contextWindowTokens: 0,
            modelName: '',
            detail: `${knowledgeSourcePath(item)}: guides of another repository are for custom agents only, so the main review did not read it`,
        });
        const linkedTo = (item.linkedTo ?? []).filter(
            (target) => target !== KNOWLEDGE_MAIN_REVIEW_TARGET,
        );
        if (linkedTo.length) items.push({ ...item, linkedTo });
    }
    return { items, outsideMainReview };
}

import type { ReviewWarning } from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import {
    KNOWLEDGE_MAIN_REVIEW_TARGET,
    knowledgeSourcePath,
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
    const items = params.items ?? [];
    if (!items.length) return { warnings: [] };
    const { baseBranch, repository, customAgents } = params;
    if (!baseBranch || !repository?.id) return { warnings: [] };
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
                warnings.push(
                    ...toReviewWarnings(
                        [
                            {
                                code:
                                    item.kind === 'skill'
                                        ? 'SKILL_NOT_FOUND'
                                        : 'DOC_NOT_FOUND',
                                path: knowledgeSourcePath(item),
                                detail: repositories.listingFailed
                                    ? `the repositories of this team's integration could not be listed, so ${item.repository} was not read`
                                    : `${item.repository} is not a repository this team's integration can read`,
                            },
                        ],
                        typeof target === 'string'
                            ? undefined
                            : names.get(target.agentId),
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
            warnings,
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
                {
                    kind: 'KNOWLEDGE_UNAVAILABLE',
                    reason: 'knowledge',
                    contextWindowTokens: 0,
                    modelName: '',
                    detail: 'the linked skills and docs could not be read from the target branch; the review ran without them',
                },
            ],
        };
    }
}

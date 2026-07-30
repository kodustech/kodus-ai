import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { CacheService } from '@libs/core/cache/cache.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { generateDateFilter } from '@libs/common/utils/transforms/date';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

export type PastReviewer = { id: string; name: string };

/**
 * Candidate reviewers a client can pick from when choosing whose past review
 * comments Kody should exclude from learning (issue #1497).
 *
 * Source = current git members ∪ authors of PRs opened in the window. The PR
 * authors are what makes departed-but-recently-active devs selectable (a dev
 * let go last week still authored PRs in the last 3 months), and it comes from
 * listing PRs — a paginated call bounded by the window — rather than the far
 * more expensive per-PR review-comment walk. Runs at onboarding (cold, no
 * cached PR data yet — the git integration is already connected) and in
 * settings; results are cached.
 */
@Injectable()
export class ListPastReviewersUseCase {
    private readonly logger = createLogger(ListPastReviewersUseCase.name);
    private static readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes
    // Bound the git fan-out when no single repo is targeted (onboarding).
    private static readonly MAX_REPOS = 20;

    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly cacheService: CacheService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        teamId: string;
        repositoryId?: string;
        months?: number;
    }): Promise<PastReviewer[]> {
        const { teamId, repositoryId } = params;
        const months = this.normalizeMonths(params.months);
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId,
        };

        const cacheKey = `past_reviewers_${organizationAndTeamData.organizationId}_${teamId}_${repositoryId ?? 'all'}_${months}`;

        try {
            const cached =
                await this.cacheService.getFromCache<PastReviewer[]>(cacheKey);
            // An empty array is a valid, cacheable result (a team with no
            // eligible reviewers) — serve it rather than recomputing.
            if (cached != null) {
                return cached;
            }
        } catch {
            // cache miss/error — recompute
        }

        const byId = new Map<string, PastReviewer>();
        // Tracks whether any provider call failed, so we don't cache an empty
        // list that's the result of a transient error (which would then be
        // served for the whole TTL) — only genuine results are cached.
        let hadError = false;

        // Current git members (cheap, cached upstream). Misses departed devs —
        // the PR-author pass below backfills those.
        try {
            const members = await this.codeManagementService.getListMembers({
                organizationAndTeamData,
            });
            for (const member of members ?? []) {
                this.addReviewer(byId, member?.id, member?.name);
            }
        } catch (error) {
            hadError = true;
            this.logger.warn({
                message: 'Failed to list current git members for reviewer list',
                context: ListPastReviewersUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationAndTeamData, repositoryId },
            });
        }

        // Authors of PRs opened within the window — includes recently-departed
        // devs. Fan out across the target repos, tolerating per-repo failures.
        try {
            const repositories = await this.resolveRepositories(
                organizationAndTeamData,
                repositoryId,
            );
            const dateFilter = generateDateFilter({ months });

            const results = await Promise.allSettled(
                repositories.map((repository) =>
                    this.codeManagementService.getPullRequestsByRepository({
                        organizationAndTeamData,
                        repository,
                        filters: {
                            startDate: dateFilter.startDate,
                            endDate: dateFilter.endDate,
                        },
                    }),
                ),
            );

            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                // A rejection, or the adapter's null-on-failure sentinel, is a
                // provider error — flag it so an empty result isn't cached, and
                // log which repo failed so the drop isn't silent.
                if (
                    result.status !== 'fulfilled' ||
                    !Array.isArray(result.value)
                ) {
                    hadError = true;
                    this.logger.warn({
                        message:
                            'Failed to fetch PRs for a repository while building the reviewer list',
                        context: ListPastReviewersUseCase.name,
                        error:
                            result.status === 'rejected'
                                ? result.reason instanceof Error
                                    ? result.reason
                                    : new Error(String(result.reason))
                                : undefined,
                        metadata: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId,
                            repositoryId: repositories[i]?.id,
                        },
                    });
                    continue;
                }
                for (const pr of result.value) {
                    this.addReviewer(
                        byId,
                        pr?.user?.id,
                        pr?.user?.name || pr?.user?.login,
                    );
                }
            }
        } catch (error) {
            hadError = true;
            this.logger.warn({
                message: 'Failed to collect PR authors for reviewer list',
                context: ListPastReviewersUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationAndTeamData, repositoryId },
            });
        }

        const reviewers = Array.from(byId.values()).sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );

        // Cache a non-empty result always (a useful partial is worth keeping,
        // and a single flaky repo shouldn't defeat caching). Cache an EMPTY
        // result only when nothing errored — otherwise it's likely a
        // failure-induced empty that we shouldn't serve for the whole TTL.
        if (reviewers.length > 0 || !hadError) {
            this.cacheService
                .addToCache(
                    cacheKey,
                    reviewers,
                    ListPastReviewersUseCase.CACHE_TTL,
                )
                .catch(() => {});
        }

        return reviewers;
    }

    /**
     * Bound the lookback window (a business rule, not transport): reject
     * NaN/non-finite input and clamp to 1–12 months, defaulting to 3. Keeps an
     * abusive `months` value from building an invalid or unbounded date filter.
     */
    private normalizeMonths(raw?: number): number {
        const DEFAULT_MONTHS = 3;
        if (raw === undefined || raw === null || !Number.isFinite(raw)) {
            return DEFAULT_MONTHS;
        }
        return Math.min(Math.max(Math.trunc(raw), 1), 12);
    }

    private addReviewer(
        map: Map<string, PastReviewer>,
        rawId: string | number | undefined | null,
        name?: string,
    ): void {
        if (rawId === undefined || rawId === null || rawId === '') {
            return;
        }
        const id = String(rawId);
        if (!map.has(id)) {
            map.set(id, { id, name: name?.trim() || id });
        }
    }

    private async resolveRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
    ): Promise<{ id: string; name: string }[]> {
        const all = await this.codeManagementService.getRepositories({
            organizationAndTeamData,
        });

        const normalized = (all ?? [])
            .map((repo: { id: string | number; name?: string }) => ({
                id: String(repo.id),
                name: repo.name ?? '',
            }))
            .filter((repo) => !!repo.name);

        if (repositoryId) {
            const target = normalized.find(
                (repo) => repo.id === String(repositoryId),
            );
            return target ? [target] : [];
        }

        if (normalized.length > ListPastReviewersUseCase.MAX_REPOS) {
            this.logger.warn({
                message: `Repository count (${normalized.length}) exceeds ${ListPastReviewersUseCase.MAX_REPOS}; sampling for the reviewer list`,
                context: ListPastReviewersUseCase.name,
                metadata: { organizationAndTeamData },
            });
            return normalized.slice(0, ListPastReviewersUseCase.MAX_REPOS);
        }

        return normalized;
    }
}

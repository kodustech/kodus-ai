import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { GenerateKodyRulesUseCase } from './generate-kody-rules.use-case';

/**
 * How far back the FIRST past-reviews generation looks — 3 months, matching the
 * historical onboarding window. The weekly cron only pulls the last week, so
 * without this seed a repo enabled after onboarding would never learn from its
 * history (issue #1506).
 */
const INITIAL_GENERATION_MONTHS = 3;

/**
 * Safety-net TTL for the per-repo seeding lock. Only relevant if the holder
 * crashes mid-generation — normal runs release in `finally`.
 */
export const INITIAL_GENERATION_LOCK_TTL_MS = 1000 * 60 * 30;

/**
 * Seed a repository's Kody Rules from its last 3 months of PR review comments,
 * the first time its generator is enabled. Idempotent: skips when the repo
 * already has past-reviews rules, so re-enabling (or a duplicate transition
 * signal) never re-runs the expensive analysis. Designed to be fired detached
 * from the config-save request.
 */
@Injectable()
export class GenerateInitialKodyRulesUseCase {
    private readonly logger = createLogger(
        GenerateInitialKodyRulesUseCase.name,
    );

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly generateKodyRulesUseCase: GenerateKodyRulesUseCase,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    /**
     * Lock that serializes the one-time seeding of a single repo. Shared by the
     * config-save trigger and the weekly cron so the two can't both start the
     * same 3-month backfill and produce duplicate rules (issue #1506).
     */
    static initialGenerationLockKey(
        organizationId: string,
        repositoryId: string,
    ): string {
        return `KODY_RULES:INITIAL_GEN:${organizationId}:${repositoryId}`;
    }

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<void> {
        const { organizationAndTeamData, repositoryId } = params;
        const { organizationId, teamId } = organizationAndTeamData;

        if (!organizationId || !teamId || !repositoryId) {
            return;
        }

        let lock: DistributedLock | null = null;
        try {
            // Serialize against a concurrent seed of the same repo (another
            // config-save, or the weekly cron). A null lock means one is
            // already running, so there is nothing to do here.
            lock = await this.distributedLockService.acquire(
                GenerateInitialKodyRulesUseCase.initialGenerationLockKey(
                    organizationId,
                    repositoryId,
                ),
                { ttl: INITIAL_GENERATION_LOCK_TTL_MS },
            );

            if (!lock) {
                this.logger.log({
                    message:
                        'Initial Kody Rules generation skipped — already running for this repository',
                    context: GenerateInitialKodyRulesUseCase.name,
                    metadata: { organizationId, teamId, repositoryId },
                });
                return;
            }

            if (await this.hasPastReviewRules(organizationId, repositoryId)) {
                this.logger.log({
                    message:
                        'Initial Kody Rules generation skipped — repository already has past-review rules',
                    context: GenerateInitialKodyRulesUseCase.name,
                    metadata: { organizationId, teamId, repositoryId },
                });
                return;
            }

            this.logger.log({
                message:
                    'Starting initial 3-month Kody Rules generation for newly-enabled repository',
                context: GenerateInitialKodyRulesUseCase.name,
                metadata: { organizationId, teamId, repositoryId },
            });

            await this.generateKodyRulesUseCase.execute(
                {
                    teamId,
                    months: INITIAL_GENERATION_MONTHS,
                    repositoriesIds: [repositoryId],
                },
                organizationId,
            );
        } catch (error) {
            this.logger.error({
                message: 'Initial Kody Rules generation failed',
                context: GenerateInitialKodyRulesUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationId, teamId, repositoryId },
            });
        } finally {
            await lock?.release().catch(() => undefined);
        }
    }

    /** Whether the repo already carries generator-produced (past-reviews) rules,
     *  i.e. the initial generation has already run for it. */
    async hasPastReviewRules(
        organizationId: string,
        repositoryId: string,
    ): Promise<boolean> {
        const seeded = await this.hasPastReviewRulesForRepos(organizationId, [
            repositoryId,
        ]);

        return seeded.has(repositoryId);
    }

    /**
     * Batched variant of {@link hasPastReviewRules}: returns the subset of the
     * given repos that already carry past-review rules. The weekly cron uses
     * this to partition its repos with a single query instead of one per repo.
     * Queries the singleton service directly (not the request-scoped find
     * use-case) so it stays callable from the cron, which has no request
     * context.
     */
    async hasPastReviewRulesForRepos(
        organizationId: string,
        repositoryIds: string[],
    ): Promise<Set<string>> {
        const seeded = new Set<string>();

        if (!organizationId || repositoryIds.length === 0) {
            return seeded;
        }

        const requested = new Set(repositoryIds);
        // Filter at the query so the DB returns only the past-review rules for
        // the requested repos, not every rule the org has (the embedded rules
        // array can be large on active orgs). Each entry is one exact-match
        // condition; the service ORs them together.
        const documents = await this.kodyRulesService.find({
            organizationId,
            rules: repositoryIds.map((repositoryId) => ({
                repositoryId,
                origin: KodyRulesOrigin.PAST_REVIEWS,
            })),
        });

        for (const document of documents ?? []) {
            for (const rule of document?.rules ?? []) {
                if (
                    rule?.origin === KodyRulesOrigin.PAST_REVIEWS &&
                    rule?.repositoryId &&
                    requested.has(rule.repositoryId)
                ) {
                    seeded.add(rule.repositoryId);
                }
            }
        }

        return seeded;
    }
}

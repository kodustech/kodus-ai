import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createLogger } from '@libs/core/log/logger';
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { BackfillRuleDetectorsUseCase } from '../../../application/use-cases/backfill-rule-detectors.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '../../../domain/contracts/kodyRules.service.contract';

/**
 * Continuous T0 sweep (#1449). Rules created outside the interactive
 * create/update path — IDE/repo-file sync, MCP, bulk import — never hit the
 * compile-on-save hook, so they run the semantic judge forever (correct, but
 * they miss the free regex path). This cron reconciles that: once a day it
 * compiles a gated detector for every rule that still lacks one, across every
 * org, reusing the same gate+persist as the save hook.
 *
 * Idempotent (onlyMissing) so steady-state runs are cheap — only rules created
 * since the last pass do any LLM work. Distributed-lock guarded so only ONE
 * worker runs it (prod runs N replicas). Gated behind an env flag so an
 * operator can disable it (e.g. to avoid compile cost on a fresh cloud tenant
 * fleet before the first controlled backfill).
 */
@Injectable()
export class KodyRuleDetectorSweepService {
    private readonly logger = createLogger(KodyRuleDetectorSweepService.name);
    private readonly enabled: boolean;
    /**
     * Hard cap on rules compiled per nightly run. The first runs over a large
     * legacy corpus (prod ~10k) must NOT try to compile everything at once —
     * that would blow the lock TTL and spike LLM cost. With onlyMissing the
     * backlog drains a batch per night (10k ≈ 5 nights at the default cap) and
     * steady-state is far below it — so the cron alone activates the legacy on
     * both cloud and self-hosted, no manual step required.
     */
    private readonly maxRulesPerRun: number;

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly backfill: BackfillRuleDetectorsUseCase,
        private readonly distributedLockService: DistributedLockService,
    ) {
        // Default ON; set KODY_RULES_DETECTOR_SWEEP_ENABLED=false to disable.
        this.enabled =
            process.env.KODY_RULES_DETECTOR_SWEEP_ENABLED !== 'false';
        this.maxRulesPerRun = Number(
            process.env.KODY_RULES_DETECTOR_SWEEP_MAX_PER_RUN ?? 2000,
        );
    }

    @Cron('0 4 * * *') // daily at 04:00 (low-traffic window)
    async sweep(): Promise<void> {
        if (!this.enabled) return;

        const lock = await this.acquireLock();
        if (!lock) return; // another replica holds it — skip

        const start = Date.now();
        const totals = { orgs: 0, processed: 0, compiled: 0, errored: 0 };
        let budget = this.maxRulesPerRun;
        try {
            // Projected org-id list — the per-org rules load happens inside
            // backfill.execute (one org at a time), so the sweep never holds
            // every org's rules array in memory at once.
            const orgIds =
                await this.kodyRulesService.findOrganizationIdsWithRules();
            for (const organizationId of orgIds) {
                if (budget <= 0) {
                    this.logger.log({
                        message: `Detector sweep hit per-run cap (${this.maxRulesPerRun}); remaining orgs deferred to the next run`,
                        context: KodyRuleDetectorSweepService.name,
                    });
                    break;
                }
                if (!organizationId) continue;
                totals.orgs++;
                try {
                    const r = await this.backfill.execute(
                        { organizationId } as any,
                        { onlyMissing: true, limit: budget },
                    );
                    totals.processed += r.processed;
                    totals.compiled += r.compiled;
                    totals.errored += r.errored;
                    budget -= r.processed;
                } catch (error) {
                    this.logger.warn({
                        message: `Detector sweep failed for org ${organizationId}`,
                        context: KodyRuleDetectorSweepService.name,
                        error,
                        metadata: { organizationId },
                    });
                }
            }
            this.logger.log({
                message: `Detector sweep complete: ${totals.orgs} orgs, ${totals.compiled} compiled / ${totals.processed} processed (${totals.errored} errored) in ${Date.now() - start}ms`,
                context: KodyRuleDetectorSweepService.name,
                metadata: totals,
            });
        } finally {
            await this.releaseLock(lock);
        }
    }

    private async acquireLock(): Promise<DistributedLock | null> {
        try {
            return await this.distributedLockService.acquire(
                'CRON:KODY_RULES:DETECTOR_SWEEP',
                { ttl: 30 * 60 * 1000 }, // 30 min — longer than a run
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to acquire detector sweep lock',
                context: KodyRuleDetectorSweepService.name,
                error: error instanceof Error ? error : undefined,
            });
            return null;
        }
    }

    private async releaseLock(lock: DistributedLock | null): Promise<void> {
        if (!lock) return;
        try {
            await lock.release();
        } catch (error) {
            this.logger.error({
                message: 'Failed to release detector sweep lock',
                context: KodyRuleDetectorSweepService.name,
                error: error instanceof Error ? error : undefined,
            });
        }
    }
}

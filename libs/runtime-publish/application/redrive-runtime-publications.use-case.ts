import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';

import {
    nextRedriveStep,
    REDRIVE_BATCH,
    staleBeforeOf,
    type RedriveStep,
} from '../domain/publication-redrive';
import type {
    PublicationRedriveStore,
    RuntimePublication,
} from '../domain/runtime-publication';
import {
    RUNTIME_PUBLICATION_STORE_TOKEN,
    RUNTIME_PUBLISH_METRICS_TOKEN,
    type RedriveMetrics,
} from '../domain/runtime-publish.ports';
import {
    PublishRuntimeRequestUseCase,
    type PublishOutcome,
} from './publish-runtime-request.use-case';

/** What one sweep did, for the cron's log line and the tests. */
export interface RedriveSweep {
    stuck: number;
    redriven: number;
    recovered: number;
    gaveUp: number;
}

/**
 * Publishes again the final publications the broker lost
 * (publication-redrive.ts). Each row goes through the same use case as a
 * broker delivery, so a redrive cannot do anything a delivery could not:
 * strict schema, stored target, idempotency key, comment slot and order,
 * check rank. Safe on every worker replica: a row is reserved before it is
 * driven, and a reservation another replica took first is skipped.
 */
@Injectable()
export class RedriveRuntimePublicationsUseCase {
    private readonly logger = createLogger(RedriveRuntimePublicationsUseCase.name);

    constructor(
        @Inject(RUNTIME_PUBLICATION_STORE_TOKEN)
        private readonly publications: PublicationRedriveStore,
        private readonly publish: PublishRuntimeRequestUseCase,
        @Optional()
        @Inject(RUNTIME_PUBLISH_METRICS_TOKEN)
        private readonly metrics?: RedriveMetrics,
    ) {}

    async sweep(now: Date = new Date()): Promise<RedriveSweep> {
        const stale = await this.publications.findStale(
            staleBeforeOf(now),
            now.toISOString(),
            REDRIVE_BATCH,
        );
        this.metrics?.recordStuck(stale.length);
        const sweep: RedriveSweep = { stuck: stale.length, redriven: 0, recovered: 0, gaveUp: 0 };
        for (const row of stale) {
            const result = await this.drive(row, now.toISOString()).catch((error) => {
                this.logger.error({
                    message: 'Runtime publication redrive failed on the store',
                    context: RedriveRuntimePublicationsUseCase.name,
                    error,
                    metadata: { key: row.key },
                });
                return 'skipped' as const;
            });
            if (result === 'gave_up') sweep.gaveUp += 1;
            if (result === 'recovered' || result === 'retry_later') sweep.redriven += 1;
            if (result === 'recovered') sweep.recovered += 1;
        }
        return sweep;
    }

    private async drive(
        row: RuntimePublication,
        now: string,
    ): Promise<'recovered' | 'retry_later' | 'gave_up' | 'skipped'> {
        const step = nextRedriveStep(row);
        if (step === 'give_up') {
            return this.giveUp(row, 'attempts', now);
        }
        const reserved = await this.publications.reserveRedrive(row.key, row.updatedAt, now);
        // Another replica took it, or it moved since the scan.
        if (!reserved || !reserved.request) return 'skipped';

        let outcome: PublishOutcome;
        try {
            outcome = await this.publish.execute(reserved.request, {
                fallback: step === 'fallback',
            });
        } catch (error) {
            // The use case released the row as failed: the next sweep finds it again.
            this.record(row, step, 'retry_later');
            this.logger.warn({
                message: 'Runtime publication redrive did not land; it is retried on a later sweep',
                context: RedriveRuntimePublicationsUseCase.name,
                metadata: {
                    key: row.key,
                    kind: row.kind,
                    step,
                    attempt: reserved.redrive?.attempts,
                    error: error instanceof Error ? error.name : 'unknown',
                },
            });
            return 'retry_later';
        }
        if (outcome.outcome === 'refused') {
            // The target, the repo or the platform no longer allow it: retrying cannot change that.
            return this.giveUp(row, `refused:${outcome.reason}`, now);
        }
        this.record(row, step, 'recovered');
        this.logger.log({
            message: `Runtime publication recovered by redrive: ${outcome.outcome}`,
            context: RedriveRuntimePublicationsUseCase.name,
            metadata: { key: row.key, kind: row.kind, step, attempt: reserved.redrive?.attempts },
        });
        return 'recovered';
    }

    private async giveUp(
        row: RuntimePublication,
        reason: string,
        now: string,
    ): Promise<'gave_up'> {
        await this.publications.giveUp(row.key, reason, now);
        this.record(row, 'give_up', 'gave_up');
        // An error with `alert`: the PR does not show this result, and nothing retries it any more.
        this.logger.error({
            message: 'Runtime publication given up: the PR does not show this result',
            context: RedriveRuntimePublicationsUseCase.name,
            metadata: {
                alert: 'runtime_publish_given_up',
                key: row.key,
                kind: row.kind,
                reason,
                attempts: row.redrive?.attempts ?? 0,
                organizationId: row.organizationId,
                repositoryId: row.repositoryId,
                prNumber: row.prNumber,
            },
        });
        return 'gave_up';
    }

    private record(
        row: RuntimePublication,
        step: RedriveStep,
        outcome: 'recovered' | 'retry_later' | 'gave_up',
    ) {
        this.metrics?.recordRedrive({ kind: row.kind, step, outcome });
    }
}

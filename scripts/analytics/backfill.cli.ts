import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger, Module } from '@nestjs/common';

import { LLMModule } from '@kodus/kodus-common/llm';

import {
    AnalyticsWarehouseModule,
    BackfillOrchestratorService,
    PullRequestIngestionService,
} from '@libs/ee/analytics-warehouse';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';

/**
 * Backfill CLI — populates the analytics warehouse from Mongo `pullRequests`.
 *
 * Two modes:
 *   chunked     (default): walk the timeline in N-day windows by `createdAt`,
 *                          checkpointing to `analytics.backfill_progress`
 *                          after each window. Resume-safe.
 *   single-shot (--single-shot or auto for tiny datasets): legacy full-scan
 *                          using watermark semantics. Fine for self-hosted
 *                          / fresh tenants.
 *
 * Usage:
 *   pnpm run analytics:backfill                    # chunked, resumes from checkpoint
 *   pnpm run analytics:backfill --fresh            # chunked, ignores checkpoint
 *   pnpm run analytics:backfill --from 2024-01-01 --until 2024-02-01
 *   pnpm run analytics:backfill --org <organizationId>
 *   pnpm run analytics:backfill --step-days 1 --pause-ms 5000 --batch 200
 *   pnpm run analytics:backfill --single-shot      # legacy mode
 *   pnpm run analytics:backfill --single-shot --max 10000 --batch 500
 */
@Module({
    imports: [
        SharedConfigModule,
        SharedLogModule,
        SharedMongoModule.forRoot(),
        // LLM is only used by the classifier provider registered inside
        // AnalyticsWarehouseModule; the backfill orchestrator itself
        // doesn't call any model. Required here so Nest can resolve the
        // classifier's `PromptRunnerService` dep at bootstrap.
        LLMModule.forRoot({ logger: LoggerWrapperService }),
        AnalyticsWarehouseModule.forRoot(),
    ],
})
class BackfillModule {}

interface CliArgs {
    singleShot: boolean;
    fresh: boolean;
    max?: number;
    batch?: number;
    stepDays?: number;
    pauseMs?: number;
    from?: string;
    until?: string;
    org?: string;
}

function parseArgs(): CliArgs {
    const out: CliArgs = { singleShot: false, fresh: false };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = argv[i + 1];
        switch (arg) {
            case '--single-shot':
                out.singleShot = true;
                break;
            case '--fresh':
                out.fresh = true;
                break;
            case '--max':
                out.max = Number(next);
                i += 1;
                break;
            case '--batch':
                out.batch = Number(next);
                i += 1;
                break;
            case '--step-days':
                out.stepDays = Number(next);
                i += 1;
                break;
            case '--pause-ms':
                out.pauseMs = Number(next);
                i += 1;
                break;
            case '--from':
                out.from = next;
                i += 1;
                break;
            case '--until':
                out.until = next;
                i += 1;
                break;
            case '--org':
                out.org = next;
                i += 1;
                break;
            default:
                if (arg?.startsWith('--')) {
                    throw new Error(`unknown flag: ${arg}`);
                }
        }
    }
    return out;
}

async function main() {
    const logger = new Logger('analytics-backfill');
    const args = parseArgs();

    const app = await NestFactory.createApplicationContext(BackfillModule, {
        logger: ['log', 'warn', 'error'],
    });

    // Wire SIGINT/SIGTERM into an AbortController so the orchestrator
    // finishes the current window, writes a `paused` checkpoint, and
    // returns. Re-running picks up from that checkpoint.
    //
    // The single-shot path doesn't honor the signal yet — that would
    // require plumbing it through PullRequestIngestionService. Chunked
    // mode (default) is the right tool for any realistic backfill.
    const ac = new AbortController();
    let signaled = false;
    const onSignal = (sig: string) => {
        if (signaled) return;
        signaled = true;
        logger.warn(
            `received ${sig} — finishing current window then exiting`,
        );
        ac.abort();
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    try {
        if (args.singleShot) {
            const svc = app.get(PullRequestIngestionService);
            const start = Date.now();
            const res = await svc.run({
                backfill: true,
                maxRows: args.max,
                batchSize: args.batch,
                organizationId: args.org,
            });
            logger.log(
                `single-shot backfill done in ${Date.now() - start}ms — ${JSON.stringify(res)}`,
            );
        } else {
            const orchestrator = app.get(BackfillOrchestratorService);
            const res = await orchestrator.run({
                from: args.from,
                until: args.until,
                stepDays: args.stepDays,
                pauseMs: args.pauseMs,
                batchSize: args.batch,
                fresh: args.fresh,
                organizationId: args.org,
                signal: ac.signal,
            });
            logger.log(`chunked backfill result: ${JSON.stringify(res)}`);
        }
    } finally {
        await app.close();
    }
}

main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('backfill crashed:', err);
    process.exit(1);
});

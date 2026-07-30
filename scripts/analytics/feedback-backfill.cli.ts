import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger, Module } from '@nestjs/common';

import { LLMModule } from '@kodus/kodus-common/llm';

import {
    AnalyticsWarehouseModule,
    FeedbackIngestionService,
} from '@libs/ee/analytics-warehouse';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';

/**
 * One-shot feedback ingestion — pulls `codeReviewFeedback` reactions from
 * Mongo into `analytics.suggestion_feedback` without waiting for the
 * worker cron tick. The incremental watermark makes re-runs cheap;
 * `--backfill` ignores it and rescans everything.
 *
 * Usage:
 *   pnpm run analytics:feedback-backfill
 *   pnpm run analytics:feedback-backfill --backfill
 *   pnpm run analytics:feedback-backfill --org <organizationId>
 */
@Module({
    imports: [
        SharedConfigModule,
        SharedLogModule,
        SharedMongoModule.forRoot(),
        // Required transitively by AnalyticsWarehouseModule's classifier
        // provider — same note as backfill.cli.ts.
        LLMModule.forRoot({ logger: LoggerWrapperService }),
        AnalyticsWarehouseModule.forRoot(),
    ],
})
class FeedbackBackfillModule {}

function parseArgs(): { backfill: boolean; org?: string } {
    const out: { backfill: boolean; org?: string } = { backfill: false };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        switch (arg) {
            case '--backfill':
                out.backfill = true;
                break;
            case '--org':
                out.org = argv[i + 1];
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
    const logger = new Logger('analytics-feedback-backfill');
    const args = parseArgs();

    const app = await NestFactory.createApplicationContext(
        FeedbackBackfillModule,
        { logger: ['log', 'warn', 'error'] },
    );

    try {
        const svc = app.get(FeedbackIngestionService);
        const res = await svc.run({
            backfill: args.backfill,
            organizationId: args.org,
        });
        logger.log(`feedback ingestion done — ${JSON.stringify(res)}`);
    } finally {
        await app.close();
    }
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
});

/**
 * Self-hosted telemetry CLI — preview the heartbeat payload, or force-send
 * one to telemetry.kodus.io without waiting for the daily cron.
 *
 * Usage:
 *   pnpm run telemetry:preview              # build + print payload, do NOT send
 *   pnpm run telemetry:send                 # build + POST to telemetry.kodus.io
 *
 * Both commands read .env from the repo root. They boot a minimal Nest
 * context (Postgres + Mongo + TelemetryModule) — no RabbitMQ, no HTTP
 * server, no cron registration.
 *
 * `send` exercises the same code path the cron will run in production,
 * including the `last_sent_day` dedupe (so a second `pnpm run telemetry:send`
 * the same UTC day will short-circuit without sending). Use the
 * `KODUS_TELEMETRY_FORCE` env var (or pass `--force`) to bypass the
 * dedupe for testing.
 */
import 'dotenv/config';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { GlobalParametersKey } from '@libs/core/domain/enums/global-parameters-key.enum';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SelfHostedBeaconService } from '@libs/telemetry/application/services/self-hosted-beacon.service';
import { SelfHostedBeaconModule } from '@libs/telemetry/modules/self-hosted-beacon.module';
import { TelemetryModule } from '@libs/telemetry/modules/telemetry.module';
import { GLOBAL_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';
import type { IGlobalParametersService } from '@libs/organization/domain/global-parameters/contracts/global-parameters.service.contract';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        SharedConfigModule,
        SharedLogModule,
        SharedPostgresModule.forRoot({ poolSize: 4 }),
        SharedMongoModule.forRoot(),
        TelemetryModule,
        SelfHostedBeaconModule,
    ],
})
class TelemetryCliModule {}

async function main(): Promise<void> {
    const args = new Set(process.argv.slice(2));
    const send = args.has('--send');
    const force =
        args.has('--force') ||
        /^(1|true|yes|on)$/i.test(process.env.KODUS_TELEMETRY_FORCE ?? '');

    const ctx = await NestFactory.createApplicationContext(
        TelemetryCliModule,
        { logger: ['error', 'warn'] },
    );

    try {
        const beacon = ctx.get(SelfHostedBeaconService);

        if (force && send) {
            // Reset last_sent_day so service.run() proceeds even if it
            // already fired today. Keeps instance_id + first_seen_at intact.
            const params = ctx.get<IGlobalParametersService>(
                GLOBAL_PARAMETERS_SERVICE_TOKEN,
            );
            const existing = await params.findByKey(
                GlobalParametersKey.TELEMETRY_STATE,
            );
            if (existing?.configValue) {
                await params.createOrUpdateConfig(
                    GlobalParametersKey.TELEMETRY_STATE,
                    { ...existing.configValue, last_sent_day: null },
                );
                console.error('[telemetry-cli] cleared last_sent_day for forced send');
            }
        }

        if (send) {
            const start = Date.now();
            await beacon.run();
            console.error(
                `[telemetry-cli] beacon.run() completed in ${Date.now() - start}ms`,
            );
        } else {
            const payload = await beacon.preview();
            console.log(JSON.stringify(payload, null, 2));
        }
    } finally {
        await ctx.close();
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

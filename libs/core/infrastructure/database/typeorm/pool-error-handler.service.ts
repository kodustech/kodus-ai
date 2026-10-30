import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createLogger } from '@libs/core/log/logger';

/**
 * Attaches a `pool.on('error', ...)` handler to the TypeORM Postgres pool
 * that this app uses.
 *
 * Why this is MANDATORY: pg.Pool re-emits `error` events from idle clients
 * (RDS killing an idle session via `idle_session_timeout`, a network
 * reset, or an operator `pg_terminate_backend`). Without a listener that
 * event escapes as an uncaught exception and **crashes the process**.
 *
 * Concretely observed in prod on 2026-07-31 stress tests: killing a
 * bridge-pool connection brought the whole API down with
 * `[BOOTSTRAP-EARLY] uncaughtException: terminating connection due to
 * administrator command`. The bridge got its own handler right after; the
 * main TypeORM pool never did — this service closes that gap.
 *
 * pg.Pool's contract on `error`: the offending client is already removed
 * from the pool before the event fires. The next `pool.connect()` opens a
 * new one. So the correct handler is a warning log, not a re-throw.
 */
@Injectable()
export class PoolErrorHandlerService implements OnApplicationBootstrap {
    private readonly logger = createLogger(PoolErrorHandlerService.name);

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
    ) {}

    onApplicationBootstrap(): void {
        try {
            const driver = this.dataSource.driver as unknown as {
                master?: {
                    on?: (event: string, cb: (err: unknown) => void) => void;
                };
            };
            const pool = driver.master;

            if (!pool || typeof pool.on !== 'function') {
                this.logger.warn({
                    message:
                        'DataSource driver.master pool not accessible; pool error handler NOT attached',
                    context: PoolErrorHandlerService.name,
                });
                return;
            }

            pool.on('error', (error: unknown) => {
                this.logger.warn({
                    message:
                        'Postgres pool client errored — pg.Pool will drop it and open a new one on next query',
                    context: PoolErrorHandlerService.name,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                });
            });

            this.logger.log({
                message: 'Postgres pool error handler attached',
                context: PoolErrorHandlerService.name,
                metadata: {
                    applicationName: (
                        this.dataSource.options as { extra?: { application_name?: string } }
                    ).extra?.application_name,
                },
            });
        } catch (error) {
            // Never let bootstrapping this observability hook take down the
            // app itself; log and continue.
            this.logger.error({
                message: 'Failed to attach Postgres pool error handler',
                context: PoolErrorHandlerService.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
            });
        }
    }
}

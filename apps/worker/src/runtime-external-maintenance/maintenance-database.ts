import {
    Inject,
    Injectable,
    Optional,
    type OnModuleDestroy,
} from '@nestjs/common';
import { DataSource, type DataSourceOptions, type Logger } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';

export const EXTERNAL_MAINTENANCE_SOURCE_FACTORY = Symbol(
    'ExternalMaintenanceSourceFactory',
);
type SourceFactory = (options: DataSourceOptions) => DataSource;
const silentLogger: Logger = {
    log: () => undefined,
    logQuery: () => undefined,
    logQueryError: () => undefined,
    logQuerySlow: () => undefined,
    logSchemaBuild: () => undefined,
    logMigration: () => undefined,
};

/** Reuse connection identity, never the review pool's 90-second acquisition wait. */
export function boundedMaintenanceOptions(
    base: DataSourceOptions,
): PostgresConnectionOptions {
    if (base.type !== 'postgres')
        throw new Error('External maintenance requires product PostgreSQL');
    return {
        ...base,
        ...(base.replication
            ? { ...base.replication.master, url: base.replication.master.url }
            : {}),
        replication: undefined,
        entities: [],
        subscribers: [],
        migrations: [],
        synchronize: false,
        migrationsRun: false,
        dropSchema: false,
        logging: false,
        logger: silentLogger,
        poolErrorHandler: () => undefined,
        connectTimeoutMS: 1000,
        extra: {
            ...base.extra,
            max: 2,
            min: 0,
            connectionTimeoutMillis: 1000,
            idleTimeoutMillis: 30000,
            statement_timeout: 750,
            query_timeout: 1000,
            lock_timeout: 200,
        },
    };
}

/** Product-only, lazy bounded pool: disabled maintenance opens no connection. */
@Injectable()
export class ProductExternalMaintenanceDatabase implements OnModuleDestroy {
    private initialization?: Promise<DataSource>;
    private closed = false;
    constructor(
        private readonly product: DataSource,
        @Optional()
        @Inject(EXTERNAL_MAINTENANCE_SOURCE_FACTORY)
        private readonly create: SourceFactory = (options) =>
            new DataSource(options),
    ) {}
    async source(): Promise<DataSource> {
        if (this.closed)
            throw new Error('External maintenance database is closed');
        if (this.initialization === undefined) {
            const child = this.create(
                boundedMaintenanceOptions(this.product.options),
            );
            this.initialization = child
                .initialize()
                .then(async (source) => {
                    if (this.closed) {
                        await source.destroy();
                        throw new Error(
                            'External maintenance database is closed',
                        );
                    }
                    return source;
                })
                .catch((cause: unknown) => {
                    this.initialization = undefined;
                    // The cause rides along for the tick's log line, which keeps only its name and code.
                    throw new Error(
                        this.closed
                            ? 'External maintenance database is closed'
                            : 'External maintenance database unavailable',
                        { cause },
                    );
                });
        }
        return this.initialization;
    }
    async onModuleDestroy(): Promise<void> {
        this.closed = true;
        const pending = this.initialization;
        this.initialization = undefined;
        if (pending !== undefined)
            await pending
                .then(async (source) => {
                    if (source.isInitialized) await source.destroy();
                })
                // Module shutdown: an initialization that failed already rejected its callers, and a failed destroy has nothing left to close.
                .catch(() => undefined);
    }
}

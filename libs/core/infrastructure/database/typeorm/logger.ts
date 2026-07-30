import { Logger as ITypeORMLogger } from 'typeorm';
import { createLogger } from '@libs/core/log/logger';

export class TypeOrmCustomLogger implements ITypeORMLogger {
    private readonly logger = createLogger('TypeORM');

    constructor(private readonly logQueries: boolean = true) {}

    logQuery(query: string, parameters?: any[]) {
        if (!this.logQueries) {
            return;
        }

        // Debug level for standard queries to avoid log spam in production
        // Only enabled if API_LOG_LEVEL=debug
        this.logger.debug({
            message: 'Executing Query',
            context: 'TypeORM',
            metadata: { query, parameters },
        });
    }

    logQueryError(error: string | Error, query: string, parameters?: any[]) {
        this.logger.error({
            message: 'Query Execution Failed',
            context: 'TypeORM',
            error: error instanceof Error ? error : new Error(error),
            metadata: { query, parameters },
        });
    }

    logQuerySlow(time: number, query: string, parameters?: any[]) {
        this.logger.warn({
            message: `Slow Query Detected (> ${time}ms)`,
            context: 'TypeORM',
            metadata: {
                executionTimeMs: time,
                query,
                parameters,
            },
        });
    }

    logSchemaBuild(message: string) {
        this.logger.log({
            message: `Schema Build: ${message}`,
            context: 'TypeORM',
        });
    }

    logMigration(message: string) {
        this.logger.log({
            message: `Migration: ${message}`,
            context: 'TypeORM',
        });
    }

    log(level: 'log' | 'info' | 'warn', message: any) {
        switch (level) {
            case 'log':
            case 'info':
                this.logger.log({
                    message: String(message),
                    context: 'TypeORM',
                });
                break;
            case 'warn':
                this.logger.warn({
                    message: String(message),
                    context: 'TypeORM',
                });
                break;
        }
    }
}

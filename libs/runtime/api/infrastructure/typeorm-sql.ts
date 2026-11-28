import type { DataSource, QueryRunner } from 'typeorm';

/** One statement's rows (RETURNING included) and how many rows it touched. */
export interface SqlResult {
    rows: any[];
    rowCount: number;
}

export interface Sql {
    query(text: string, values?: unknown[]): Promise<SqlResult>;
}

export interface TransactionalSql extends Sql {
    /** Runs `fn` in one transaction (READ COMMITTED); any throw rolls it back. */
    transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

const run = async (runner: QueryRunner, text: string, values: unknown[] = []): Promise<SqlResult> => {
    const r = await runner.query(text, values, true);
    return { rows: r.records ?? [], rowCount: r.affected ?? 0 };
};

/**
 * The product Postgres through the product's TypeORM DataSource, as plain SQL
 * with row counts: the Runtime's product stores need atomic upserts
 * (INSERT … ON CONFLICT … RETURNING) the repository API does not express.
 */
export class TypeOrmSql implements TransactionalSql {
    constructor(private readonly source: DataSource) {}

    async query(text: string, values: unknown[] = []): Promise<SqlResult> {
        const runner = this.source.createQueryRunner();
        try {
            return await run(runner, text, values);
        } finally {
            await runner.release();
        }
    }

    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
        return this.source.transaction((manager) => fn({ query: (text, values) => run(manager.queryRunner!, text, values) }));
    }
}

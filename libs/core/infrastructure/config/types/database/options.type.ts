export type OptionsOrm = {
    type: 'postgres';
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    entities: string[];
    autoLoadEntities: boolean;
    migrationsRun: boolean;
    migrations: string[];
    migrationsTableName: string;
    synchronize: boolean;
    logging: boolean;
    logger: 'advanced-console' | 'simple-console' | 'file' | 'debug';
    ssl?: boolean;
    extra?: {
        ssl?: {
            rejectUnauthorized: boolean;
        };
        connectionLimit?: number; // Maximum number of connections in the pool
        max?: number; // Maximum number of connections in the pool
        min?: number; // Minimum number of connections in the pool
        idleTimeoutMillis?: number; // Time in milliseconds for an idle connection to be released
    };
    cache?: boolean;
};

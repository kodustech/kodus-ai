import {
    ProductExternalMaintenanceDatabase,
    boundedMaintenanceOptions,
} from './maintenance-database';

it('keeps the existing product connection identity but bounds its own two-connection pool and disables execution hooks', () => {
    const options = boundedMaintenanceOptions({
        type: 'postgres',
        url: 'postgres://fixture.invalid/db',
        entities: ['ignored'],
        synchronize: true,
        migrationsRun: true,
        extra: { max: 99, query_timeout: 30000 },
    });
    expect(options.url).toBe('postgres://fixture.invalid/db');
    expect(options).toMatchObject({
        entities: [],
        subscribers: [],
        migrations: [],
        synchronize: false,
        migrationsRun: false,
        logging: false,
    });
    expect(options.extra).toMatchObject({
        max: 2,
        connectionTimeoutMillis: 1000,
        statement_timeout: 750,
        query_timeout: 1000,
        lock_timeout: 200,
    });
});

it('stays lazy, shares initialization, and closes only its owned source', async () => {
    const child = {
        isInitialized: false,
        initialize: jest.fn(),
        destroy: jest.fn(),
    };
    child.initialize.mockImplementation(async () => {
        child.isInitialized = true;
        return child;
    });
    const create = jest.fn(() => child);
    const product = { options: { type: 'postgres' }, destroy: jest.fn() };
    const database = new ProductExternalMaintenanceDatabase(
        product as never,
        create as never,
    );
    expect(create).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([database.source(), database.source()]);
    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(1);
    expect(child.initialize).toHaveBeenCalledTimes(1);
    await database.onModuleDestroy();
    expect(child.destroy).toHaveBeenCalledTimes(1);
    expect(product.destroy).not.toHaveBeenCalled();
    await expect(database.source()).rejects.toThrow('closed');
});

it('does not retain a child connection when shutdown races initialization', async () => {
    let ready!: () => void;
    const child = {
        isInitialized: false,
        initialize: jest.fn(),
        destroy: jest.fn(),
    };
    child.initialize.mockImplementation(
        () =>
            new Promise((resolve) => {
                ready = () => {
                    child.isInitialized = true;
                    resolve(child);
                };
            }),
    );
    const database = new ProductExternalMaintenanceDatabase(
        { options: { type: 'postgres' } } as never,
        (() => child) as never,
    );
    const initializing = database.source();
    const closed = expect(initializing).rejects.toThrow('closed');
    const shutdown = database.onModuleDestroy();
    ready();
    await closed;
    await shutdown;
    expect(child.destroy).toHaveBeenCalledTimes(1);
});

it('uses only the primary when product connection options contain replication', () => {
    const options = boundedMaintenanceOptions({
        type: 'postgres',
        replication: {
            master: { host: 'primary.fixture', username: 'fixture' },
            slaves: [{ host: 'replica.fixture' }],
        },
    });
    expect(options.replication).toBeUndefined();
    expect(options.host).toBe('primary.fixture');
    expect(options.extra.max).toBe(2);
});

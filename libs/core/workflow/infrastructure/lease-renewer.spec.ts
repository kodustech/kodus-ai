import { EventEmitter } from 'node:events';

const logged = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ ...logged, debug: jest.fn() }),
}));

import {
    ThreadLeaseRenewer,
    TimerLeaseRenewer,
    redactCredentials,
    renewalConnectionConfig,
} from './lease-renewer';

describe('renewal thread connection', () => {
    it('uses the same TLS settings as the app pool (managed Postgres that requires TLS)', () => {
        expect(
            renewalConnectionConfig(
                {
                    host: 'db.rds.example',
                    port: 5432,
                    username: 'kodus',
                    password: 's3cret',
                    database: 'kodus_db',
                    ssl: true,
                    extra: { ssl: { rejectUnauthorized: false } },
                },
                {},
            ),
        ).toMatchObject({
            host: 'db.rds.example',
            port: 5432,
            user: 'kodus',
            password: 's3cret',
            database: 'kodus_db',
            ssl: { rejectUnauthorized: false },
        });
    });

    it('turns a bare `ssl: true` into an encrypted connection without a CA check, like the pool', () => {
        expect(
            renewalConnectionConfig({ host: 'db', ssl: true }, {}).ssl,
        ).toEqual({ rejectUnauthorized: false });
    });

    it('sends no TLS option when the app pool has none, and leaves it to the URL when the URL sets sslmode', () => {
        expect(renewalConnectionConfig({ host: 'db' }, {})).not.toHaveProperty(
            'ssl',
        );
        const viaUrl = renewalConnectionConfig(
            {
                url: 'postgres://u:p@db:5432/x?sslmode=no-verify',
                ssl: true,
            },
            {},
        );
        expect(viaUrl).toMatchObject({
            connectionString: 'postgres://u:p@db:5432/x?sslmode=no-verify',
        });
        expect(viaUrl).not.toHaveProperty('ssl');
        expect(viaUrl).not.toHaveProperty('host');
    });

    it('names itself, keeps the socket alive, bounds the connect, and sends the session timeouts', () => {
        expect(
            renewalConnectionConfig(
                { host: 'db' },
                {
                    DB_STATEMENT_TIMEOUT_MS: '5000',
                    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
                },
            ),
        ).toEqual({
            host: 'db',
            port: undefined,
            user: undefined,
            password: undefined,
            database: undefined,
            application_name: 'kodus-lock-renewer',
            keepAlive: true,
            connectionTimeoutMillis: 10_000,
            statement_timeout: 5000,
        });
    });
});

describe('renewal thread', () => {
    afterEach(async () => {
        await ThreadLeaseRenewer.stopAll();
    });

    it('is one per process and connection, shared by every service instance', () => {
        const options = { host: 'db', port: 5432, database: 'kodus_db' };
        const first = ThreadLeaseRenewer.for(options);

        expect(ThreadLeaseRenewer.for({ ...options })).toBe(first);
        expect(ThreadLeaseRenewer.for({ ...options, host: 'other' })).not.toBe(
            first,
        );
    });
});

/** Stands in for the renewal thread: records what it is told, dies on cue. */
class FakeThread extends EventEmitter {
    posted: any[] = [];
    postMessage(message: unknown) {
        this.posted.push(message);
    }
    unref() {}
    async terminate() {
        return 0;
    }
    die() {
        this.emit('exit', 1);
    }
    tracks() {
        return this.posted.filter((m) => m.type === 'track');
    }
}

describe('renewal thread restarts', () => {
    let threads: FakeThread[];
    let failSpawn: boolean;
    let renewer: ThreadLeaseRenewer;
    const spawn = () => {
        if (failSpawn) throw new Error('ERR_WORKER_INIT_FAILED');
        const thread = new FakeThread();
        threads.push(thread);
        return thread as any;
    };

    beforeEach(() => {
        jest.useFakeTimers();
        threads = [];
        failSpawn = false;
        Object.values(logged).forEach((fn) => fn.mockClear());
        renewer = ThreadLeaseRenewer.overThreads(spawn);
    });

    afterEach(async () => {
        await renewer.stop();
        jest.useRealTimers();
    });

    it('a thread that dies is started again and renews every held lease at once', async () => {
        renewer.track('job', 'h1', 60_000, jest.fn());
        expect(threads[0].tracks()).toEqual([
            expect.objectContaining({ key: 'job', delay: 20_000 }),
        ]);

        threads[0].die();
        await jest.advanceTimersByTimeAsync(400);

        expect(threads).toHaveLength(2);
        // Part of the lease went by with no thread: no waiting a full beat.
        expect(threads[1].tracks()).toEqual([
            expect.objectContaining({ key: 'job', holder: 'h1', delay: 0 }),
        ]);
    });

    it('a thread that dies on every start is restarted with growing delays, not in a loop', async () => {
        const startedAt: number[] = [];
        renewer = ThreadLeaseRenewer.overThreads(() => {
            const thread = spawn();
            startedAt.push(Date.now());
            queueMicrotask(() => thread.die());
            return thread;
        });

        await jest.advanceTimersByTimeAsync(60_000);

        // 250ms doubling up to 30s, jittered: about eight starts a minute.
        expect(startedAt.length).toBeGreaterThan(4);
        expect(startedAt.length).toBeLessThan(15);
        const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]);
        expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0] * 8);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000 * 1.2);
    });

    it('while a lease is held, a thread that keeps dying is brought back within half a renewal beat', async () => {
        const startedAt: number[] = [];
        renewer = ThreadLeaseRenewer.overThreads(() => {
            const thread = spawn();
            startedAt.push(Date.now());
            queueMicrotask(() => thread.die());
            return thread;
        });
        renewer.track('job', 'h1', 60_000, jest.fn());

        await jest.advanceTimersByTimeAsync(60_000);

        // A 60s lease is renewed every 20s; waiting up to 30s for a thread
        // let a crashing renewer sit out a whole lease.
        const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]);
        expect(gaps.length).toBeGreaterThan(5);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(10_000 * 1.2);
    });

    it('a lease granted before a stall is renewed at once and runs out from its grant, not from when it was tracked', async () => {
        const onLost = jest.fn();
        renewer.track('job', 'h1', 60_000, onLost, Date.now() - 25_000);
        renewer.track('fresh', 'h2', 60_000, jest.fn(), Date.now() - 5_000);

        expect(threads[0].tracks()).toEqual([
            expect.objectContaining({ key: 'job', delay: 0 }),
            expect.objectContaining({ key: 'fresh', delay: 15_000 }),
        ]);

        // No renewal ever lands: the lease granted 25s ago ends 35s from now.
        failSpawn = true;
        threads[0].die();
        await jest.advanceTimersByTimeAsync(34_000);
        expect(onLost).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(2_000);
        expect(onLost).toHaveBeenCalledTimes(1);
    });

    it('while no thread can start, a held lease is reported lost when its time runs out, not before', async () => {
        const onLost = jest.fn();
        renewer.track('job', 'h1', 60_000, onLost);
        const id = threads[0].tracks()[0].id;
        // The thread renewed it 20s in: it holds until 80s.
        await jest.advanceTimersByTimeAsync(20_000);
        threads[0].emit('message', { type: 'renewed', id, at: Date.now() });
        await jest.advanceTimersByTimeAsync(10_000);

        failSpawn = true;
        threads[0].die();

        await jest.advanceTimersByTimeAsync(48_000); // 78s
        expect(onLost).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(3_000); // 81s
        expect(onLost).toHaveBeenCalledTimes(1);
        expect(logged.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('Could not restart'),
            }),
        );
    });

    it('a lease taken while no thread runs is handed to the next thread', async () => {
        failSpawn = true;
        threads[0].die();
        await jest.advanceTimersByTimeAsync(400); // a failed restart

        const onLost = jest.fn();
        renewer.track('job', 'h1', 60_000, onLost);
        failSpawn = false;
        await jest.advanceTimersByTimeAsync(2_000);

        expect(threads).toHaveLength(2);
        expect(threads[1].tracks()).toEqual([
            expect.objectContaining({ key: 'job', holder: 'h1', delay: 0 }),
        ]);
        expect(onLost).not.toHaveBeenCalled();
    });

    it('logs renewal failures without the connection string or password pg puts in its errors', () => {
        threads[0].emit('message', {
            type: 'error',
            message:
                'invalid connection string postgres://kodus:s3cret@db:5432/kodus_db (password=s3cret)',
        });

        const line = JSON.stringify(logged.warn.mock.calls);
        expect(line).not.toContain('s3cret');
        expect(line).toContain('postgres://***');
    });
});

describe('main-loop renewal (fallback when no thread can start)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('renews a lease granted before a stall at once, then every third of its lease', async () => {
        const renew = jest.fn(async () => true);
        const renewer = new TimerLeaseRenewer({ renew } as any);
        const stop = renewer.track('job', 'h1', 60_000, jest.fn(), Date.now() - 25_000);

        await jest.advanceTimersByTimeAsync(1);
        expect(renew).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(20_000);
        expect(renew).toHaveBeenCalledTimes(2);
        stop();
    });
});

describe('credential redaction for logs', () => {
    it.each([
        ['postgres://kodus:s3cret@db:5432/kodus_db', 'postgres://***'],
        ['postgresql://u:s3cret@h/db?sslmode=require', 'postgresql://***'],
        [
            'host=db password=s3cret user=kodus',
            'host=db password=*** user=kodus',
        ],
        ["password: 's3cret and more'", 'password: ***'],
    ])('%s', (input, expected) => {
        const out = redactCredentials(input);
        expect(out).not.toContain('s3cret');
        expect(out).toContain(expected);
    });
});

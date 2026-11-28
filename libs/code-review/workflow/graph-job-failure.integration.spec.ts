/**
 * The classifier has to retry the provider failures a graph job actually
 * throws. Postgres 16 runs on its own port and is removed afterwards.
 */
import { spawnSync } from 'child_process';
import net from 'net';

import { Client, Pool } from 'pg';
import { QueryFailedError } from 'typeorm';

import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import { classifyGraphJobError } from './graph-job-failure';

jest.setTimeout(120_000);

const CONTAINER = `pg-graph-job-failure-${process.pid}`;
const PORT = 27440 + (process.pid % 1500);

function docker(args: string[]): { status: number | null; out: string } {
    const result = spawnSync('docker', args, { encoding: 'utf8' });
    return {
        status: result.status,
        out: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function asQueryFailed(driver: unknown, query: string): QueryFailedError {
    return new QueryFailedError(query, [], driver);
}

describe('classifyGraphJobError with real provider errors', () => {
    const config = {
        host: '127.0.0.1',
        port: PORT,
        user: 'postgres',
        password: 'test',
        database: 'postgres',
    };

    beforeAll(async () => {
        docker(['rm', '-f', CONTAINER]);
        const started = docker([
            'run',
            '-d',
            '--rm',
            '--name',
            CONTAINER,
            '-e',
            'POSTGRES_PASSWORD=test',
            '-p',
            `127.0.0.1:${PORT}:5432`,
            'postgres:16',
        ]);
        if (started.status !== 0) {
            throw new Error(`postgres:16 did not start: ${started.out}`);
        }
        for (let i = 0; i < 120; i++) {
            const ready = (
                docker(['logs', CONTAINER]).out.match(
                    /ready to accept connections/g,
                ) ?? []
            ).length;
            if (ready >= 2) return;
            await sleep(500);
        }
        throw new Error('postgres:16 did not accept connections');
    });

    afterAll(() => {
        docker(['rm', '-f', CONTAINER]);
    });

    async function capture(run: () => Promise<unknown>): Promise<unknown> {
        try {
            await run();
        } catch (error) {
            return error;
        }
        throw new Error('the query was expected to fail');
    }

    it('retries a statement_timeout from pg_sleep', async () => {
        const client = new Client(config);
        await client.connect();
        try {
            await client.query('SET statement_timeout = 200');
            const driver = await capture(() =>
                client.query('SELECT pg_sleep(2)'),
            );
            const error = asQueryFailed(driver, 'SELECT pg_sleep(2)');
            expect(error).toMatchObject({ code: '57014' });
            expect(classifyGraphJobError(error)).toBe(
                ErrorClassification.RETRYABLE,
            );
            expect(classifyGraphJobError(driver)).toBe(
                ErrorClassification.RETRYABLE,
            );
        } finally {
            await client.end();
        }
    });

    it('retries a statement_timeout while waiting on a row lock', async () => {
        const holder = new Client(config);
        const writer = new Client(config);
        await holder.connect();
        await writer.connect();
        try {
            await holder.query('DROP TABLE IF EXISTS lock_probe');
            await holder.query('CREATE TABLE lock_probe (id int primary key)');
            await holder.query('INSERT INTO lock_probe VALUES (1)');
            await holder.query('BEGIN');
            await holder.query(
                'SELECT id FROM lock_probe WHERE id = 1 FOR NO KEY UPDATE',
            );
            await writer.query('BEGIN');
            await writer.query("SET statement_timeout = '300ms'");
            const driver = await capture(() =>
                writer.query(
                    'SELECT id FROM lock_probe WHERE id = 1 FOR NO KEY UPDATE',
                ),
            );
            const error = asQueryFailed(driver, 'SELECT id FROM lock_probe');
            expect(error).toMatchObject({
                code: '57014',
                message: expect.stringContaining('statement timeout'),
            });
            expect(classifyGraphJobError(error)).toBe(
                ErrorClassification.RETRYABLE,
            );
        } finally {
            await writer.query('ROLLBACK').catch(() => undefined);
            await holder.query('ROLLBACK').catch(() => undefined);
            await writer.end();
            await holder.end();
        }
    });

    it('retries SQLSTATE 57014 when the message has no timeout text', async () => {
        const sleeper = new Client(config);
        const killer = new Client(config);
        await sleeper.connect();
        await killer.connect();
        try {
            const pid = (
                await sleeper.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid',
                )
            ).rows[0].pid;
            const sleeping = sleeper.query('SELECT pg_sleep(30)');
            await sleep(100);
            await killer.query('SELECT pg_cancel_backend($1)', [pid]);
            const driver = await capture(() => sleeping);
            const error = asQueryFailed(driver, 'SELECT pg_sleep(30)');
            expect(error).toMatchObject({ code: '57014' });
            expect(error.message.toLowerCase()).not.toMatch(
                /timeout|502|503|temporarily unavailable/,
            );
            expect(classifyGraphJobError(error)).toBe(
                ErrorClassification.RETRYABLE,
            );
        } finally {
            await sleeper.end().catch(() => undefined);
            await killer.end();
        }
    });

    it('retries a lock_timeout', async () => {
        const holder = new Client(config);
        const writer = new Client(config);
        await holder.connect();
        await writer.connect();
        try {
            await holder.query('DROP TABLE IF EXISTS lock_probe');
            await holder.query('CREATE TABLE lock_probe (id int primary key)');
            await holder.query('INSERT INTO lock_probe VALUES (1)');
            await holder.query('BEGIN');
            await holder.query(
                'SELECT id FROM lock_probe WHERE id = 1 FOR NO KEY UPDATE',
            );
            await writer.query("SET lock_timeout = '300ms'");
            await writer.query('BEGIN');
            const driver = await capture(() =>
                writer.query(
                    'SELECT id FROM lock_probe WHERE id = 1 FOR NO KEY UPDATE',
                ),
            );
            const error = asQueryFailed(driver, 'SELECT id FROM lock_probe');
            expect(error).toMatchObject({ code: '55P03' });
            expect(classifyGraphJobError(error)).toBe(
                ErrorClassification.RETRYABLE,
            );
        } finally {
            await writer.query('ROLLBACK').catch(() => undefined);
            await holder.query('ROLLBACK').catch(() => undefined);
            await writer.end();
            await holder.end();
        }
    });

    it('leaves a unique violation permanent', async () => {
        const client = new Client(config);
        await client.connect();
        try {
            await client.query('DROP TABLE IF EXISTS uniq_probe');
            await client.query('CREATE TABLE uniq_probe (id int primary key)');
            await client.query('INSERT INTO uniq_probe VALUES (1)');
            const driver = await capture(() =>
                client.query('INSERT INTO uniq_probe VALUES (1)'),
            );
            const error = asQueryFailed(
                driver,
                'INSERT INTO uniq_probe VALUES (1)',
            );
            expect(error).toMatchObject({ code: '23505' });
            expect(classifyGraphJobError(error)).toBe(
                ErrorClassification.PERMANENT,
            );
        } finally {
            await client.end();
        }
    });

    it('retries a pg-pool acquire timeout', async () => {
        const pool = new Pool({
            ...config,
            max: 1,
            connectionTimeoutMillis: 200,
        });
        const held = await pool.connect();
        try {
            const error = await capture(() => pool.connect());
            expect(error).toMatchObject({
                message: 'timeout exceeded when trying to connect',
            });
            expect(error).not.toHaveProperty('code');
            expect(classifyGraphJobError(error)).toBe(
                ErrorClassification.RETRYABLE,
            );
        } finally {
            held.release();
            await pool.end();
        }
    });

    it('retries a connect timeout against a silent TCP server', async () => {
        const sockets = new Set<net.Socket>();
        const server = net.createServer((socket) => {
            sockets.add(socket);
            socket.on('error', () => undefined);
            socket.on('close', () => sockets.delete(socket));
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('silent server has no port');
        }
        const pool = new Pool({
            host: '127.0.0.1',
            port: address.port,
            connectionTimeoutMillis: 500,
            user: 'kodus',
            database: 'kodus',
            password: 'kodus',
        });
        try {
            const error = await capture(() => pool.connect());
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe(
                'Connection terminated due to connection timeout',
            );
            expect((error as { cause?: { code?: string } }).cause?.code).toBe(
                undefined,
            );
            expect(classifyGraphJobError(error)).toBe(
                ErrorClassification.RETRYABLE,
            );
        } finally {
            for (const socket of sockets) socket.destroy();
            await Promise.race([pool.end(), sleep(1000)]);
            server.close();
        }
    }, 10_000);
});

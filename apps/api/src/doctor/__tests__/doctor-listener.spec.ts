import { execFile } from 'child_process';
import * as http from 'http';
import { AddressInfo } from 'net';
import * as path from 'path';
import { promisify } from 'util';

import {
    createDoctorHandler,
    DOCTOR_TOKEN_HEADER,
    doctorToken,
    isLoopback,
    startDoctorListener,
} from '../doctor-listener';
import { DoctorReport } from '../doctor.types';

const KEY = 'b'.repeat(64);

const report: DoctorReport = {
    verdict: 'DEGRADED',
    version: '2.3.0',
    generatedAt: '2026-09-22T00:00:00.000Z',
    durationMs: 5,
    results: [
        {
            check: 'ast.graph',
            status: 'warn',
            title: 'The code graph is not ready for api.',
            impact: 'Less context.',
            fix: 'Run the backfill.',
            scope: 'acme/core',
        },
        { check: 'llm.completion', status: 'ok', title: 'Model answered.' },
    ],
};

function fakeReq(opts: {
    remoteAddress?: string;
    method?: string;
    url?: string;
    token?: string;
}): http.IncomingMessage {
    return {
        socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
        method: opts.method ?? 'GET',
        url: opts.url ?? '/doctor',
        headers: opts.token ? { [DOCTOR_TOKEN_HEADER]: opts.token } : {},
    } as unknown as http.IncomingMessage;
}

function fakeRes() {
    const res: any = { status: 0, body: '' };
    res.writeHead = (status: number) => {
        res.status = status;
    };
    res.done = new Promise<void>((resolve) => {
        res.end = (body: string) => {
            res.body = body;
            resolve();
        };
    });
    return res;
}

async function call(
    handler: http.RequestListener,
    opts: Parameters<typeof fakeReq>[0],
) {
    const res = fakeRes();
    handler(fakeReq(opts), res);
    await res.done;
    return { status: res.status, body: JSON.parse(res.body) };
}

describe('doctor listener', () => {
    it('recognizes only loopback addresses', () => {
        expect(isLoopback('127.0.0.1')).toBe(true);
        expect(isLoopback('::1')).toBe(true);
        expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
        expect(isLoopback('10.0.0.5')).toBe(false);
        expect(isLoopback('::ffff:172.18.0.3')).toBe(false);
        expect(isLoopback(undefined)).toBe(false);
    });

    it('rejects non-loopback callers even with the right token', async () => {
        const run = jest.fn().mockResolvedValue(report);
        const handler = createDoctorHandler({ cryptoKey: KEY, run });
        const res = await call(handler, {
            remoteAddress: '172.18.0.3',
            token: doctorToken(KEY),
        });
        expect(res.status).toBe(403);
        expect(run).not.toHaveBeenCalled();
    });

    it('rejects a missing or wrong token', async () => {
        const run = jest.fn().mockResolvedValue(report);
        const handler = createDoctorHandler({ cryptoKey: KEY, run });
        expect((await call(handler, {})).status).toBe(401);
        expect(
            (await call(handler, { token: doctorToken('c'.repeat(64)) }))
                .status,
        ).toBe(401);
        expect((await call(handler, { token: 'short' })).status).toBe(401);
        expect(run).not.toHaveBeenCalled();
    });

    it('serves only GET /doctor', async () => {
        const run = jest.fn().mockResolvedValue(report);
        const handler = createDoctorHandler({ cryptoKey: KEY, run });
        const token = doctorToken(KEY);
        expect((await call(handler, { token, method: 'POST' })).status).toBe(
            404,
        );
        expect((await call(handler, { token, url: '/other' })).status).toBe(
            404,
        );
    });

    it('returns the report for loopback + valid token', async () => {
        const handler = createDoctorHandler({
            cryptoKey: KEY,
            run: jest.fn().mockResolvedValue(report),
        });
        const res = await call(handler, { token: doctorToken(KEY) });
        expect(res.status).toBe(200);
        expect(res.body.verdict).toBe('DEGRADED');
    });

    it('runs once for concurrent callers and reuses a recent report', async () => {
        let resolve!: (r: DoctorReport) => void;
        const run = jest.fn(
            () => new Promise<DoctorReport>((r) => (resolve = r)),
        );
        let clock = 1_000;
        const handler = createDoctorHandler({
            cryptoKey: KEY,
            run,
            now: () => clock,
        });
        const token = doctorToken(KEY);

        const a = call(handler, { token });
        const b = call(handler, { token });
        resolve(report);
        await Promise.all([a, b]);
        expect(run).toHaveBeenCalledTimes(1);

        clock += 10_000;
        await call(handler, { token });
        expect(run).toHaveBeenCalledTimes(1);

        clock += 60_000;
        run.mockImplementation(() => Promise.resolve(report));
        await call(handler, { token });
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('does not start in cloud mode, when disabled, or without a key', () => {
        const run = jest.fn();
        const log = jest.fn();
        expect(
            startDoctorListener({
                cloudMode: true,
                env: { API_CRYPTO_KEY: KEY },
                run,
                log,
            }),
        ).toBeNull();
        expect(
            startDoctorListener({
                cloudMode: false,
                env: { API_CRYPTO_KEY: KEY, API_DOCTOR_ENABLED: 'false' },
                run,
                log,
            }),
        ).toBeNull();
        expect(
            startDoctorListener({ cloudMode: false, env: {}, run, log }),
        ).toBeNull();
    });

    describe('client script against a real loopback listener', () => {
        let server: http.Server;
        let port: number;

        beforeAll(async () => {
            server = http.createServer(
                createDoctorHandler({
                    cryptoKey: KEY,
                    run: () => Promise.resolve(report),
                }),
            );
            await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
            port = (server.address() as AddressInfo).port;
        });

        afterAll(() => new Promise<void>((r) => server.close(() => r())));

        const client = path.resolve(
            __dirname,
            '../../../../../scripts/doctor/doctor-client.mjs',
        );
        const run = (args: string[], key = KEY) =>
            promisify(execFile)(process.execPath, [client, ...args], {
                env: {
                    PATH: process.env.PATH,
                    API_CRYPTO_KEY: key,
                    API_DOCTOR_PORT: String(port),
                },
            });

        it('prints the verdict first and problems before the summary', async () => {
            const { stdout } = await run([]);
            const lines = stdout.split('\n');
            expect(lines[0]).toBe('Reviews: RUNNING, DEGRADED');
            expect(stdout.indexOf('The code graph is not ready')).toBeLessThan(
                stdout.indexOf('1 check(s) passed'),
            );
            expect(stdout).not.toContain('Model answered.');
        });

        it('--verbose lists passing checks', async () => {
            const { stdout } = await run(['--verbose']);
            expect(stdout).toContain('Model answered.');
        });

        it('emits one tab-separated line per result', async () => {
            const { stdout } = await run(['--format', 'tsv']);
            const lines = stdout.trim().split('\n');
            expect(lines[0]).toBe('#verdict\tDEGRADED');
            expect(lines[2].split('\t')).toEqual([
                'warn',
                'ast.graph',
                'acme/core',
                'The code graph is not ready for api.',
                'Less context.',
                'Run the backfill.',
            ]);
        });

        it('exits 3 when the token is wrong, with the cause and without the body', async () => {
            const failed = await run([], 'd'.repeat(64)).catch((e) => e);
            expect(failed.code).toBe(3);
            expect(failed.stderr).toContain('HTTP 401: the token was rejected');
            expect(failed.stderr).not.toContain('invalid token');
        });
    });
});

import { RuntimeLogger } from './logger';

describe('RuntimeLogger', () => {
    it('writes one JSON object per line with the service, the level, the context and the fields', () => {
        const lines: string[] = [];
        const log = new RuntimeLogger(
            'runtime-hub',
            (l) => void lines.push(l),
        ).child('CellHub');
        log.write('warn', 'claim.not_ready', { claimId: 'c1', waitedMs: 5 });
        // Nest's Logger goes through the same format (object messages keep their fields).
        log.log({ msg: 'cell.connected', cellId: 'cell-a' }, 'CellGateway');
        log.error('boom', 'stack', 'RunEngine');
        const [a, b, c] = lines.map((l) => JSON.parse(l));
        expect(a).toMatchObject({
            level: 'warn',
            service: 'runtime-hub',
            context: 'CellHub',
            msg: 'claim.not_ready',
            claimId: 'c1',
            waitedMs: 5,
        });
        expect(b).toMatchObject({
            level: 'info',
            context: 'CellGateway',
            msg: 'cell.connected',
            cellId: 'cell-a',
        });
        expect(c).toMatchObject({
            level: 'error',
            context: 'RunEngine',
            msg: 'boom',
        });
        expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    });

    it('keeps canonical identity and omits raw error carriers (#2487)', () => {
        const lines: string[] = [];
        const log = new RuntimeLogger(
            'runtime-worker',
            (line) => void lines.push(line),
        );
        const marker = 'synthetic-credential-marker';
        log.write('warn', 'fixture.failed', {
            runId: 'run-a',
            error: marker,
            service: 'forged',
            level: 'info',
            msg: 'forged',
            at: 'forged',
            traceId: 'forged',
            spanId: 'forged',
            token: marker,
            nested: { Authorization: marker, error: new Error(marker) },
        });
        const record = JSON.parse(lines[0]);
        expect(record).toMatchObject({
            service: 'runtime-worker',
            level: 'warn',
            msg: 'fixture.failed',
            runId: 'run-a',
        });
        expect(record.at).not.toBe('forged');
        expect(record.traceId).not.toBe('forged');
        expect(record.spanId).not.toBe('forged');
        expect(lines[0]).not.toContain(marker);
    });

    it('keeps a fixed failure category instead of message, stack or request data', () => {
        const lines: string[] = [];
        const log = new RuntimeLogger(
            'runtime-worker',
            (line) => void lines.push(line),
        );
        log.error({
            msg: 'fixture.failed',
            error: Object.assign(new Error('private message'), {
                code: 'ECONNRESET',
                request: { token: 'private token' },
            }),
            runId: 'run-a',
        });
        expect(JSON.parse(lines[0])).toMatchObject({
            error: { kind: 'network', code: 'ECONNRESET' },
            runId: 'run-a',
        });
        expect(lines[0]).not.toContain('private');
        log.error(new Error('private error object'));
        expect(lines[1]).not.toContain('private');
    });

    it('does not invoke getters/toJSON or throw on cyclic metadata, bigint or a broken sink', () => {
        const lines: string[] = [];
        const log = new RuntimeLogger(
            'runtime-worker',
            (line) => void lines.push(line),
        );
        const dangerous = jest.fn(() => {
            throw new Error('must not execute');
        });
        const value: any = { count: 3, large: 2n, toJSON: dangerous };
        value.cycle = value;
        Object.defineProperty(value, 'secretGetter', {
            enumerable: true,
            get: dangerous,
        });
        expect(() =>
            log.write('error', 'fixture.metadata', { nested: value }),
        ).not.toThrow();
        expect(dangerous).not.toHaveBeenCalled();
        expect(JSON.parse(lines[0])).toMatchObject({
            msg: 'fixture.metadata',
            nested: { count: 3 },
        });
        expect(() =>
            new RuntimeLogger('runtime-worker', () => {
                throw new Error('sink unavailable');
            }).info('fixture'),
        ).not.toThrow();
    });

    it('bounds a diagnostic line even when callers supply oversized metadata', () => {
        const lines: string[] = [];
        const log = new RuntimeLogger(
            'runtime-worker',
            (line) => void lines.push(line),
        );
        log.info('fixture.bounded', {
            nested: Object.fromEntries(
                Array.from({ length: 1000 }, (_, i) => [
                    String(i),
                    'x'.repeat(10000),
                ]),
            ),
        });
        expect(Buffer.byteLength(lines[0])).toBeLessThanOrEqual(16384);
        expect(() => JSON.parse(lines[0])).not.toThrow();
        log.info('fixture.escaped', {
            nested: Object.fromEntries(
                Array.from({ length: 32 }, (_, i) => [
                    String(i),
                    '\u0000'.repeat(10000),
                ]),
            ),
        });
        expect(Buffer.byteLength(lines[1])).toBeLessThanOrEqual(16384);
        expect(JSON.parse(lines[1]).msg).toBe('fixture.escaped');
    });

    it('does not throw when a diagnostic object is a revoked proxy', () => {
        const lines: string[] = [];
        const log = new RuntimeLogger(
            'runtime-worker',
            (line) => void lines.push(line),
        );
        const { proxy, revoke } = Proxy.revocable({}, {});
        revoke();
        expect(() => log.error(proxy)).not.toThrow();
        expect(lines).toHaveLength(1);
    });
});

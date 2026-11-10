import {
    decidesVerdict,
    ProbeSchema,
    ProbeSpecSchema,
} from './probe.schema';

const target = { service: 'web', port: 3000 };

describe('ProbeSpecSchema', () => {
    it('accepts an http probe against an exposed port', () => {
        const spec = {
            kind: 'http',
            target,
            method: 'POST',
            path: '/orders',
            body: '{"items":[]}',
            timeoutMs: 120_000,
        };
        expect(ProbeSpecSchema.parse(spec)).toEqual(spec);
    });

    it('rejects a browser step that evaluates script', () => {
        const spec = {
            kind: 'browser',
            steps: [{ goto: '/signup' }, { evaluate: 'document.cookie' }],
            viewport: { width: 1280, height: 800 },
            timeoutMs: 60_000,
        };
        expect(ProbeSpecSchema.safeParse(spec).success).toBe(false);
    });

    it('rejects a browser step with an extra key next to an allowed one', () => {
        const spec = {
            kind: 'browser',
            steps: [{ click: '#buy', evaluate: 'x' }],
            viewport: { width: 1280, height: 800 },
            timeoutMs: 60_000,
        };
        expect(ProbeSpecSchema.safeParse(spec).success).toBe(false);
    });

    it('rejects an unknown field, including a case variant of a known one', () => {
        const spec = {
            kind: 'http',
            target,
            method: 'GET',
            path: '/health',
            Path: '/admin',
            timeoutMs: 1_000,
        };
        expect(ProbeSpecSchema.safeParse(spec).success).toBe(false);
    });

    it('rejects a sql probe that writes', () => {
        const spec = {
            kind: 'sql',
            target: { service: 'db', port: 5432 },
            query: "update orders set status = 'paid'",
            timeoutMs: 5_000,
        };
        expect(ProbeSpecSchema.safeParse(spec).success).toBe(false);
    });

    it('rejects a sql probe with a second statement', () => {
        const spec = {
            kind: 'sql',
            target: { service: 'db', port: 5432 },
            query: 'select 1; delete from orders',
            timeoutMs: 5_000,
        };
        expect(ProbeSpecSchema.safeParse(spec).success).toBe(false);
    });

    it('accepts a read-only sql probe', () => {
        const spec = {
            kind: 'sql',
            target: { service: 'db', port: 5432 },
            query: 'select status, count(*) from orders group by 1;',
            timeoutMs: 5_000,
        };
        expect(ProbeSpecSchema.safeParse(spec).success).toBe(true);
    });

    it('rejects an http path that is a full URL', () => {
        const spec = {
            kind: 'http',
            target,
            method: 'GET',
            path: 'http://169.254.169.254/latest/meta-data',
            timeoutMs: 1_000,
        };
        expect(ProbeSpecSchema.safeParse(spec).success).toBe(false);
    });
});

describe('decidesVerdict', () => {
    it('lets only observer probes decide', () => {
        expect(
            decidesVerdict({
                kind: 'http',
                target,
                method: 'GET',
                path: '/',
                timeoutMs: 1_000,
            }),
        ).toBe(true);
        expect(
            decidesVerdict({ kind: 'shell', command: 'pnpm test', timeoutMs: 1_000 }),
        ).toBe(false);
    });
});

describe('ProbeSchema', () => {
    it('does not accept origins without a design yet', () => {
        const probe = {
            id: 'p1',
            spec: { kind: 'http', target, method: 'GET', path: '/', timeoutMs: 1_000 },
            origin: 'kody_rule',
            purpose: 'home loads',
            expected: '200',
            compare: ['status'],
        };
        expect(ProbeSchema.safeParse(probe).success).toBe(false);
    });
});

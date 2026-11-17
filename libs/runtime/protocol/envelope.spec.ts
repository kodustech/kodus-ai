import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeFrame, HELLO_VERSION_REFUSALS, helloVersionRefusal, MAX_FRAME_BYTES, MIN_CELL_PROTOCOL_VERSION, PROTOCOL_VERSION, protocolJsonSchemas } from './envelope';

const STEP = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const MSG = '0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d';

const frame = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        v: 1,
        id: MSG,
        cellId: 'cell-us-east-1a',
        claimId: 'claim-1',
        type: 'exec',
        body: { stepId: STEP, command: 'node -v', timeoutMs: 1_000 },
        ...over,
    });

describe('decodeFrame', () => {
    it('decodes a valid exec message', () => {
        const result = decodeFrame(frame());
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.message.type).toBe('exec');
    });

    it('refuses a duplicate key', () => {
        const raw = frame().replace('"type":"exec"', '"type":"exec","type":"claim.release"');
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'duplicate_key' });
    });

    it('refuses a case variant of a known key', () => {
        const raw = frame().replace('"cellId"', '"CellId"');
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'invalid_envelope' });
    });

    it('refuses an unknown body field', () => {
        const raw = frame({
            body: { stepId: STEP, command: 'node -v', timeoutMs: 1_000, sudo: true },
        });
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'invalid_body' });
    });

    it('refuses a frame above 1 MiB', () => {
        const raw = frame({ body: { stepId: STEP, command: 'x'.repeat(MAX_FRAME_BYTES), timeoutMs: 1 } });
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'frame_too_large' });
    });

    it('refuses nesting deeper than 32', () => {
        const deep = '['.repeat(40) + ']'.repeat(40);
        const raw = frame().replace('"claimId":"claim-1"', `"claimId":"claim-1","x":${deep}`);
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'too_deep' });
    });

    it('refuses a step id the hub did not generate as a uuid', () => {
        const raw = frame({ body: { stepId: 'probe-1', command: 'node -v', timeoutMs: 1_000 } });
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'invalid_body' });
    });

    it('refuses an unsupported protocol version', () => {
        expect(decodeFrame(frame({ v: 9 }))).toMatchObject({
            ok: false,
            code: 'unsupported_version',
        });
    });

    it('decodes a hello of a version it does not speak, so the hub can say why it refuses that cell', () => {
        const hello = { versions: [8, 9], driver: 'docker-gvisor', isolation: 'sandboxed-container', regions: [], owner: 'customer' };
        expect(decodeFrame(frame({ v: 9, type: 'hello', claimId: undefined, body: hello }))).toMatchObject({ ok: true, message: { type: 'hello', v: 9 } });
    });

    it('refuses a probe.run carrying a browser evaluate step', () => {
        const raw = frame({
            type: 'probe.run',
            body: {
                stepId: STEP,
                probe: {
                    id: 'p1',
                    origin: 'agent',
                    purpose: 'signup form',
                    expected: 'invalid field is email',
                    compare: ['dom'],
                    spec: {
                        kind: 'browser',
                        steps: [{ goto: '/signup' }, { evaluate: 'fetch("//x")' }],
                        viewport: { width: 1280, height: 800 },
                        timeoutMs: 60_000,
                    },
                },
            },
        });
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'invalid_body' });
    });

    it('refuses trailing data after the object', () => {
        expect(decodeFrame(frame() + '{}')).toMatchObject({ ok: false, code: 'invalid_json' });
    });
});

describe('hello features', () => {
    const hello = (features: string[]) => {
        const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'hello-features-workspace.json'), 'utf8'));
        const frameObj = raw.frame ?? raw.message ?? raw;
        frameObj.body.features = features;
        return JSON.stringify(frameObj);
    };
    const names = (n: number) => Array.from({ length: n }, (_, i) => `feature${i}`);

    it('accepts a hello naming more than 32 features, up to 64 (CELL_FEATURES reached 32)', () => {
        expect(decodeFrame(hello(names(64)))).toMatchObject({ ok: true });
    });

    it('refuses a hello naming more than 64 features', () => {
        expect(decodeFrame(hello(names(65)))).toMatchObject({ ok: false, code: 'invalid_body' });
    });
});

describe('protocolJsonSchemas', () => {
    it('exports a JSON Schema for the envelope and every message', () => {
        const schemas = protocolJsonSchemas();
        expect(Object.keys(schemas)).toEqual(
            expect.arrayContaining(['envelope', 'probe.run', 'step.result', 'machine.reset', 'cell.revoked']),
        );
        expect((schemas['exec'] as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    });
});

// Review fixes: each case below decoded before (TS-only rules; the Go cell
// mirrors them in its own decoder, see the shared fixtures for the patterns).
describe('decodeFrame refuses what a strict decoder must refuse', () => {
    const CLAIM_FAILED = { kind: 'unknown', signature: 's', reason: 'r' };

    it('refuses a __proto__ key, which would hide a field from the strict schema', () => {
        const raw = frame({ type: 'claim.failed', body: CLAIM_FAILED }).replace('"kind"', '"__proto__":{"held":true},"kind"');
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'invalid_json' });
    });

    it('reads a number longer than 64 characters whole, then lets the schema judge it', () => {
        const raw = frame({ body: { stepId: STEP, command: 'node -v', timeoutMs: Number('1'.repeat(70)) } }).replace(/"timeoutMs":[^,}]+/, `"timeoutMs":${'1'.repeat(70)}`);
        expect(decodeFrame(raw)).toMatchObject({ ok: false, code: 'invalid_body' });
    });

    it('refuses a claim-scoped message without claimId and a reply without re', () => {
        const noClaim = JSON.parse(frame({ type: 'step.result', body: { stepId: STEP, executor: 'vm', imageId: 'i', vmHealth: 'ok' } }));
        delete noClaim.claimId;
        expect(decodeFrame(JSON.stringify(noClaim))).toMatchObject({ ok: false, code: 'invalid_envelope' });
        expect(decodeFrame(frame({ type: 'ack', body: {} }))).toMatchObject({ ok: false, code: 'invalid_envelope' });
        expect(decodeFrame(frame({ type: 'ack', body: {}, re: MSG }))).toMatchObject({ ok: true });
    });

    it('refuses a step result whose executor does not match what it carries', () => {
        const exec = { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1 };
        const both = { stepId: STEP, executor: 'vm', imageId: 'i', vmHealth: 'ok', exec, probe: { stepId: STEP, executor: 'observer', imageId: 'i', requests: [], durationMs: 1, transport: 'ok' } };
        expect(decodeFrame(frame({ type: 'step.result', body: both }))).toMatchObject({ ok: false, code: 'invalid_body' });
        expect(decodeFrame(frame({ type: 'step.result', body: { stepId: STEP, executor: 'observer', imageId: 'i', vmHealth: 'ok', exec } }))).toMatchObject({
            ok: false,
            code: 'invalid_body',
        });
        const { exec: _e, ...vmProbe } = both;
        expect(decodeFrame(frame({ type: 'step.result', body: vmProbe }))).toMatchObject({ ok: false, code: 'invalid_body' });
    });

    it('refuses a diagnostic hold on a claim that is not a setup', () => {
        const fixture = require('./fixtures/claim-acquire-diagnostic-hold.json');
        const body = { ...fixture.message.body, consumer: 'runtime' };
        expect(decodeFrame(JSON.stringify({ ...fixture.message, body }))).toMatchObject({ ok: false, code: 'invalid_body' });
    });
});

// The skew policy (Kubernetes' kubelet rule): a cell is never newer than the
// hub it dials, and never older than the oldest protocol the hub still speaks.
describe('helloVersionRefusal', () => {
    const range = { min: 2, max: 3 };

    it('accepts a cell at the hub protocol or at one the hub still speaks', () => {
        expect(helloVersionRefusal([2, 3], range)).toBeNull();
        expect(helloVersionRefusal([1, 2], range)).toBeNull();
    });

    it('refuses a cell newer than the hub, and says to upgrade the hub first', () => {
        const r = helloVersionRefusal([3, 4], range);
        expect(r).toEqual({ code: HELLO_VERSION_REFUSALS.cellTooNew, message: expect.stringContaining('cell speaks protocol v4') });
        expect(r!.message).toContain('accepts cells of protocol v2 to v3');
        expect(r!.message).toContain('upgrade the hub first');
    });

    it('refuses a cell older than the oldest protocol the hub speaks, and says to upgrade the cell', () => {
        const r = helloVersionRefusal([1], range);
        expect(r).toEqual({ code: HELLO_VERSION_REFUSALS.cellTooOld, message: expect.stringContaining('cell speaks protocol v1') });
        expect(r!.message).toContain('upgrade the cell');
    });

    it("by default reads this hub's range: the protocol it speaks and the one before it", () => {
        expect(MIN_CELL_PROTOCOL_VERSION).toBe(Math.max(1, PROTOCOL_VERSION - 1));
        expect(helloVersionRefusal([PROTOCOL_VERSION])).toBeNull();
        expect(helloVersionRefusal([PROTOCOL_VERSION + 1])?.code).toBe('cell_too_new');
    });
});

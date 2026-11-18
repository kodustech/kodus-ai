import { BOOTSTRAP_PATH } from '@libs/runtime/fleet/host-provider';
import { parseHostPool } from '@libs/runtime/fleet/pool';
import { ProviderError } from '@libs/runtime/fleet/provider-error';
import { describeHostProviderConformance } from '@libs/runtime/fleet/testing';

import { BoatHostProvider } from './boat-provider';
import { mapBoatError } from './boat-errors';
import { RECORDED_KEY, RecordedBoat, recordedError } from './testing';

// RECORDED FROM DOCS, NOT FROM THE LIVE API: every response here is written from the shapes on
// docs.boat.dev (API reference read 2026-11-17). The live test (boat-provider.live.spec.ts) is the check.

const cls = parseHostPool({
    kind: 'HostPool',
    name: 'boat-eu-perrun',
    scope: 'kodus',
    provider: 'boat',
    lifecycle: 'perRun',
    hostClass: { kind: 'HostClass', name: 'boat-large-cell', provider: 'boat', boat: { type: 'large', ttlSeconds: 7200, org: 'team_kodus' } },
}).hostClass;

const make = (opts: { pageSize?: number } = {}) => {
    const boat = new RecordedBoat(opts);
    const provider = new BoatHostProvider({ apiUrl: 'https://boat.dev/api/v1', apiKey: RECORDED_KEY, installation: 'it', fetch: boat.fetch });
    return { boat, provider };
};
const request = (hostId = 'host-1') => ({
    hostId,
    clientToken: hostId,
    cls,
    from: 'kodus-env-0a1b2c3d4e-5f6a7b8c9d-0011223344556677',
    bootstrap: { hubUrl: 'https://hub.example:3410', hubCa: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n', token: 'kcf_test-token' },
    tags: { installation: 'it', pool: 'boat-eu-perrun', host: hostId },
});

describeHostProviderConformance('boat (recorded from docs)', () => {
    const { boat, provider } = make({ pageSize: 2 });
    return {
        provider,
        cls,
        installation: 'it',
        failNextCreate: (kind) => boat.failNext('POST /sandboxes', recordedError(kind)),
        addForeignHost: async () => boat.addSandbox({ 'kodus.installation': 'someone-else', 'kodus.host': 'x' }),
    };
});

describe('the boat adapter', () => {
    it('creates a no-env, never-snapshotted, unmonitored host from the template, with the bootstrap file, its labels and an Idempotency-Key', async () => {
        const { boat, provider } = make();
        await provider.create(request());
        const call = boat.calls.find((c) => c.method === 'POST' && c.path === '/sandboxes')!;
        expect(call.headers['idempotency-key']).toBe('host-1');
        expect(call.headers.authorization).toBe(`Bearer ${RECORDED_KEY}`);
        expect(call.body).toEqual({
            type: 'large',
            from: 'kodus-env-0a1b2c3d4e-5f6a7b8c9d-0011223344556677',
            noEnv: true,
            snapshots: false,
            monitoring: false,
            failFast: true,
            ttlSeconds: 7200,
            org: 'team_kodus',
            name: 'kodus-host-1',
            labels: { 'kodus.installation': 'it', 'kodus.pool': 'boat-eu-perrun', 'kodus.host': 'host-1' },
            files: [{ path: BOOTSTRAP_PATH, encoding: 'utf8', content: JSON.stringify({ hubUrl: 'https://hub.example:3410', hubCa: request().bootstrap.hubCa, token: 'kcf_test-token' }) }],
        });
    });

    it("maps boat's sandbox states to the port's", async () => {
        const { boat, provider } = make();
        const h = await provider.create(request());
        expect(h.state).toBe('pending');
        for (const [state, want] of [['ready', 'running'], ['idle', 'running'], ['archived', 'stopped'], ['error', 'failed'], ['cloning', 'pending']] as const) {
            boat.setState(h.providerId, state);
            expect((await provider.get(h.providerId))?.state).toBe(want);
        }
        boat.setState(h.providerId, 'cancelled');
        expect(await provider.get(h.providerId)).toBeNull();
    });

    it('extends a host by setting its TTL, and deletes it with the confirmation header naming it', async () => {
        const { boat, provider } = make();
        const h = await provider.create(request());
        await provider.extend(h.providerId, 7200);
        expect(boat.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ ttlSeconds: 7200 });
        await provider.destroy(h.providerId);
        const del = boat.calls.find((c) => c.method === 'DELETE')!;
        expect(del.path).toBe(`/sandboxes/${h.providerId}`);
        expect(del.headers['x-ascii-confirm-delete']).toBe(h.providerId);
    });

    it("reads the account's room from GET /limits: starts left, the plan's cap, whether the class's size is on the plan", async () => {
        const { boat, provider } = make();
        expect(await provider.quotas(cls)).toEqual({ canStart: true, activeHosts: 3, maxActiveHosts: 100, startsRemaining: { minute: 11, hour: 57, day: 190 }, classAvailable: true });
        boat.limits.machineTypes = [{ type: 'large', available: false, reason: 'not during the free trial; the first payment unlocks it' }];
        expect((await provider.quotas(cls))?.classAvailable).toBe(false);
    });

    it('saves, reads and removes a saved snapshot; a removed one is gone, not an error', async () => {
        const { provider } = make();
        const h = await provider.create(request());
        expect(await provider.images.save({ providerId: h.providerId, name: 'kodus-env-a-b-c' })).toEqual({ name: 'kodus-env-a-b-c', state: 'saving' });
        expect(await provider.images.get('kodus-env-a-b-c')).toEqual({ name: 'kodus-env-a-b-c', state: 'ready' });
        await provider.images.remove('kodus-env-a-b-c');
        await expect(provider.images.remove('kodus-env-a-b-c')).resolves.toBeUndefined();
        expect(await provider.images.get('kodus-env-a-b-c')).toBeNull();
    });

    it('never puts the token or a boat message in an error', async () => {
        const { boat, provider } = make();
        boat.failNext('POST /sandboxes', { status: 400, body: { ok: false, code: 'invalid_files', message: 'files[0] kcf_test-token is bad', error: { code: 'invalid_files', message: 'kcf_test-token', status: 400 } } });
        const e = await provider.create(request()).catch((x) => x);
        expect(e).toBeInstanceOf(ProviderError);
        expect(JSON.stringify({ ...e, message: e.message })).not.toContain('kcf_test-token');
    });
});

describe('boat errors as ProviderError (docs.boat.dev/limits, read 2026-11-17)', () => {
    const at = (status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
        mapBoatError(status, { ok: false, code, message: 'm', error: { code, message: 'm', status, details: extra }, ...extra }, new Headers(headers));

    it.each([
        [429, 'rate_limited', { window: 'hour', retryAfterSeconds: 120 }, {}, { kind: 'throttled', code: 'rate_limited', detail: { retryAfterMs: 120_000, window: 'hour', status: 429 } }],
        [429, 'IP_RATE_LIMIT_EXCEEDED', { retryAfter: 7 }, {}, { kind: 'throttled', code: 'IP_RATE_LIMIT_EXCEEDED', detail: { retryAfterMs: 7_000, status: 429 } }],
        [429, 'limit_reached', {}, { 'retry-after': '30' }, { kind: 'quota_exceeded', code: 'limit_reached', detail: { retryAfterMs: 30_000, status: 429 } }],
        [429, 'trial_compute_limit_reached', {}, { 'retry-after': '3600' }, { kind: 'quota_exceeded', code: 'trial_compute_limit_reached', detail: { retryAfterMs: 3_600_000, status: 429 } }],
        [503, 'no_ready_machine', { retryAfterSeconds: 5 }, {}, { kind: 'capacity_unavailable', code: 'no_ready_machine', detail: { retryAfterMs: 5_000, status: 503 } }],
        [503, 'out_of_capacity', {}, {}, { kind: 'capacity_unavailable', code: 'out_of_capacity', detail: { retryAfterMs: 120_000, status: 503 } }],
        [402, 'billing_required', {}, {}, { kind: 'unauthorized', code: 'billing_required', detail: { status: 402 } }],
        [401, 'unauthorized', {}, {}, { kind: 'unauthorized', code: 'unauthorized', detail: { status: 401 } }],
        [403, 'machine_class_plan_required', {}, {}, { kind: 'invalid_class', code: 'machine_class_plan_required', detail: { status: 403 } }],
        [403, 'trial_machine_class_not_allowed', {}, {}, { kind: 'invalid_class', code: 'trial_machine_class_not_allowed', detail: { status: 403 } }],
        [409, 'idempotency_in_progress', {}, {}, { kind: 'transient', code: 'idempotency_in_progress', detail: { retryAfterMs: 2_000, status: 409 } }],
        [409, 'idempotency_key_reused', {}, {}, { kind: 'invalid_class', code: 'idempotency_key_reused', detail: { status: 409 } }],
        [502, 'gateway_error', {}, {}, { kind: 'transient', code: 'gateway_error', detail: { status: 502 } }],
    ])('%s %s', (status, code, extra, headers, want) => {
        const e = at(status as number, code as string, extra as Record<string, unknown>, headers as Record<string, string>);
        expect({ kind: e.kind, code: e.code, detail: e.detail }).toEqual(want);
    });
});

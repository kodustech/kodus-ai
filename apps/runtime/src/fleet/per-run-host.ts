import { openSecret, sealSecret } from '@libs/runtime/run/sealed-secret';
import type { BootstrapPayload, HostProvider, ProviderHost } from '@libs/runtime/fleet/host-provider';
import { cellBaseOf, type HostPool } from '@libs/runtime/fleet/pool';
import { isProviderError } from '@libs/runtime/fleet/provider-error';

import type { FleetStore, HostFailure } from './fleet-store';

// The perRun lifecycle (docs/runtime/host-providers.md §7.0): one DBOS
// workflow per host, `fleet.perRun:<hostId>`. Create from the environment's
// template, wait for the cell to register, serve the Run while it asks for
// its host or holds a claim on it, then retire the cell and destroy the host.
// Destroy on any failure, and on every way out: teardown runs in a finally,
// retire and destroy are each retried on their own (one failing never skips
// the other), and a teardown that did not finish is tried again after a
// durable sleep until TEARDOWN_BOUND_MS. Deterministic: clocks and I/O only inside a step,
// step names derived from the loop index, so a restart resumes it. The fleet
// token is sealed in the step that mints it (step outputs are stored) and
// opened only inside the create step.

export interface PerRunHostInput {
    hostId: string;
    poolId: string;
    boundKey: string;
    organizationId: string;
    environmentId: string | null;
}

/** runtime-fleet's calls to the hub's internal fleet routes. */
export interface HubFleetPort {
    /** A kcf_ token for the host, or why not (unknown or static pool, host already registered). */
    mint(req: { hostId: string; poolId: string; boundKey: string | null; ttlSeconds: number }): Promise<{ ok: true; token: string } | { ok: false; reason: string }>;
    /** Cordons and revokes the host's cell; idempotent. */
    retire(hostId: string): Promise<void>;
}

/** The environment's template (a boat saved snapshot name): §8.2. */
export interface TemplateResolver {
    /** `cellBase`: the pool's base now; a template built from another base is not returned (its disk holds the old cell). */
    resolve(req: { organizationId: string; environmentId: string | null; poolId: string; provider: string; cellBase?: string }): Promise<string | null>;
}

export interface PerRunTiming {
    /** Between provider reads while the host boots. */
    pollMs: number;
    /** Between checks of the Run's demand and claims while the host serves. */
    serveCheckMs: number;
    /** How often the dead-man TTL is pushed forward while the host lives. */
    extendEveryMs: number;
    /** The most create attempts for retryable provider errors (throttled, no ready machine). */
    createAttempts: number;
}

export const DEFAULT_PER_RUN_TIMING: PerRunTiming = { pollMs: 5_000, serveCheckMs: 15_000, extendEveryMs: 5 * 60_000, createAttempts: 6 };

/** A step that may run again when it throws (DBOS `retriesAllowed`): attempts, first wait, and its growth. */
export interface StepRetry {
    maxAttempts: number;
    intervalSeconds: number;
    backoffRate: number;
}

/**
 * Every step that only reads or writes rows, polls the provider or calls the hub: about 30 s of tries before
 * the step fails, so a database or network blip never costs a Run its host. The token mint and the create
 * keep their own handling (the create retries what the provider says is retryable, with the same client token).
 */
export const FLEET_STEP_RETRY: StepRetry = { maxAttempts: 5, intervalSeconds: 2, backoffRate: 2 };

/**
 * How long a teardown that does not finish keeps trying, between rounds of retried steps. A day: past the
 * longest dead-man TTL a boat host can have (86400 s) and the cell certificate's lifetime, so by then the
 * provider has removed the machine and the certificate no longer opens a session.
 */
export const TEARDOWN_BOUND_MS = 24 * 3_600_000;
const TEARDOWN_FIRST_WAIT_MS = 60_000;
const TEARDOWN_MAX_WAIT_MS = 15 * 60_000;

export interface PerRunHostDeps {
    /** Runs `fn` once as a durable step (its outcome is kept); with `retry`, a throw runs it again first. */
    step<T>(name: string, fn: () => Promise<T>, retry?: StepRetry): Promise<T>;
    /** A durable sleep (DBOS.sleep in the fleet's DBOS app). */
    sleep(ms: number): Promise<void>;
    /** Read only inside a step. */
    now(): number;
    store: FleetStore;
    hub: HubFleetPort;
    providerFor(kind: string): HostProvider | undefined;
    templates: TemplateResolver;
    installation: string;
    bootstrap: Omit<BootstrapPayload, 'token'>;
    sealKey: Buffer;
    timing?: Partial<PerRunTiming>;
}

export type PerRunOutcome = { outcome: 'served' | 'expired' } | { outcome: 'failed'; failure: HostFailure };

class HostFailed extends Error {
    constructor(readonly failure: HostFailure) {
        super(failure);
    }
}

/** Which providers need a template or a cell base to make a Run host (the fake one boots anything). */
const NEEDS_TEMPLATE = new Set(['boat']);

export async function runPerRunHost(input: PerRunHostInput, d: PerRunHostDeps): Promise<PerRunOutcome> {
    const t = { ...DEFAULT_PER_RUN_TIMING, ...d.timing };
    const { hostId, poolId, boundKey } = input;
    const stored = await d.step('pool', () => d.store.pool(poolId), FLEET_STEP_RETRY);
    if (!stored || stored.pool.lifecycle !== 'perRun') {
        await d.step('demand.fail', () => d.store.failDemand(poolId, boundKey, 'pool_gone'), FLEET_STEP_RETRY);
        return { outcome: 'failed', failure: 'pool_gone' };
    }
    const pool = stored.pool;
    const provider = d.providerFor(pool.provider);
    const startedAt = await d.step('clock.start', async () => d.now());
    await d.step('host.insert', () => d.store.insertHost({ hostId, poolId, provider: pool.provider, boundKey, organizationId: input.organizationId, usdPerHour: pool.price?.usdPerHostHour }), FLEET_STEP_RETRY);
    let providerId: string | null = (await d.step('host.read', () => d.store.host(hostId), FLEET_STEP_RETRY))?.providerId ?? null;
    let outcome: PerRunOutcome;
    try {
        try {
            if (!provider) throw new HostFailed('provider_unavailable');
            // The environment's own template, else the class's cell base (the Run then builds its environment cold).
            const template = await d.step(
                'template',
                () => d.templates.resolve({ organizationId: input.organizationId, environmentId: input.environmentId, poolId, provider: pool.provider, cellBase: cellBaseOf(pool.hostClass) ?? '' }),
                FLEET_STEP_RETRY,
            );
            const from = template ?? cellBaseOf(pool.hostClass) ?? null;
            if (!from && NEEDS_TEMPLATE.has(pool.provider)) throw new HostFailed('template_missing');
            if (!providerId) {
                // Known before anything else can fail: a host the provider made is always destroyed (v-core N9).
                providerId = (await create(input, pool, provider, from ?? undefined, startedAt, d, t)).providerId;
                const made = providerId;
                await d.step('host.created', () => d.store.moveHost(hostId, 'provisioning', 'created', { providerId: made }), FLEET_STEP_RETRY);
            }
            await waitRunning(hostId, providerId, provider, d, t);
            await waitRegistered(hostId, pool, startedAt, d, t);
            await d.step('pool.ok', () => d.store.recordPoolOutcome(poolId, { ok: true }), FLEET_STEP_RETRY);
            outcome = await serve(input, pool, provider, providerId, startedAt, d, t);
        } catch (e) {
            const failure: HostFailure = e instanceof HostFailed ? e.failure : 'host_lost';
            outcome = { outcome: 'failed', failure };
            await recordFailure(input, failure, d);
        }
    } finally {
        // Whatever happened above, including a failure record that did not go through.
        await teardown(hostId, providerId, provider, d);
    }
    return outcome;
}

/** Says why the host failed: the Run (host_unavailable), the pool's breaker, the host row. Each is tried; the first error is thrown after all ran. */
async function recordFailure(input: PerRunHostInput, failure: HostFailure, d: PerRunHostDeps) {
    const { hostId, poolId, boundKey } = input;
    const writes: Array<[string, () => Promise<void>]> = [
        ['demand.fail', () => d.store.failDemand(poolId, boundKey, failure)],
        ['pool.failed', () => d.store.recordPoolOutcome(poolId, { ok: false, reason: failure })],
        ['host.failed', () => d.store.moveHost(hostId, 'failed', 'failed', { lastError: failure })],
    ];
    let first: unknown;
    for (const [name, fn] of writes) {
        try {
            await d.step(name, fn, FLEET_STEP_RETRY);
        } catch (e) {
            first ??= e;
        }
    }
    if (first !== undefined) throw first;
}

async function create(input: PerRunHostInput, pool: HostPool, provider: HostProvider, from: string | undefined, startedAt: number, d: PerRunHostDeps, t: PerRunTiming): Promise<ProviderHost> {
    const { hostId, poolId, boundKey } = input;
    const sealed = await d.step('token', async () => {
        const r = await d.hub.mint({ hostId, poolId, boundKey, ttlSeconds: pool.perRun.registrationTimeoutSeconds });
        return r.ok === false ? { ok: false as const, reason: r.reason } : { ok: true as const, sealed: sealSecret(r.token, d.sealKey, hostId) };
    });
    if (!sealed.ok) throw new HostFailed('token_refused');
    for (let attempt = 0; ; attempt++) {
        const r = await d.step(`create:${attempt}`, async () => {
            try {
                const token = openSecret(sealed.sealed, d.sealKey, hostId);
                const host = await provider.create({
                    hostId,
                    clientToken: hostId,
                    cls: pool.hostClass,
                    ...(from ? { from } : {}),
                    bootstrap: { ...d.bootstrap, token },
                    tags: { installation: d.installation, pool: poolId, host: hostId },
                });
                // Recorded in its own retried step (host.created): a database error here would lose the providerId.
                return { ok: true as const, host };
            } catch (e) {
                if (isProviderError(e) && e.retryable) return { ok: false as const, retryAfterMs: e.detail.retryAfterMs ?? t.pollMs, code: e.code };
                if (isProviderError(e)) return { ok: false as const, fatal: e.kind === 'unauthorized' || e.kind === 'invalid_class' || e.kind === 'quota_exceeded' ? ('provider_refused' as const) : ('provider_unavailable' as const), code: e.code };
                throw e;
            }
        });
        if (r.ok) return r.host;
        if ('fatal' in r && r.fatal) throw new HostFailed(r.fatal);
        const now = await d.step(`clock.create:${attempt}`, async () => d.now());
        if (attempt + 1 >= t.createAttempts || now + (r.retryAfterMs ?? 0) > startedAt + pool.perRun.registrationTimeoutSeconds * 1000) throw new HostFailed('provider_unavailable');
        await d.sleep(r.retryAfterMs ?? t.pollMs);
    }
}

async function waitRunning(hostId: string, providerId: string, provider: HostProvider, d: PerRunHostDeps, t: PerRunTiming) {
    for (let i = 0; i < 120; i++) {
        const h = await d.step(`poll:${i}`, () => provider.get(providerId), FLEET_STEP_RETRY);
        if (!h || h.state === 'gone' || h.state === 'failed' || h.state === 'stopped') throw new HostFailed('host_lost');
        if (h.state === 'running') {
            await d.step('host.bootstrapping', () => d.store.moveHost(hostId, 'bootstrapping', 'running'), FLEET_STEP_RETRY);
            return;
        }
        await d.sleep(t.pollMs);
    }
    throw new HostFailed('registration_timeout');
}

async function waitRegistered(hostId: string, pool: HostPool, startedAt: number, d: PerRunHostDeps, t: PerRunTiming) {
    const deadline = startedAt + pool.perRun.registrationTimeoutSeconds * 1000;
    for (let i = 0; ; i++) {
        const seen = await d.step(`registered:${i}`, async () => ({ cell: await d.store.hostCell(hostId), now: d.now() }), FLEET_STEP_RETRY);
        if (seen.cell?.connected) {
            await d.step('host.ready', () => d.store.moveHost(hostId, 'ready', 'registered'), FLEET_STEP_RETRY);
            return;
        }
        if (seen.now >= deadline) throw new HostFailed('registration_timeout');
        await d.sleep(t.pollMs);
    }
}

async function serve(input: PerRunHostInput, pool: HostPool, provider: HostProvider, providerId: string, startedAt: number, d: PerRunHostDeps, t: PerRunTiming): Promise<PerRunOutcome> {
    const until = startedAt + pool.perRun.maxRunMinutes * 60_000;
    const ttl = pool.hostClass.provider === 'boat' ? pool.hostClass.boat.ttlSeconds : 7200;
    let lastExtend = startedAt;
    for (let i = 0; ; i++) {
        const s = await d.step(`serve:${i}`, async () => ({
            asked: await d.store.demandLive(input.poolId, input.boundKey),
            claims: await d.store.liveClaimsOnHost(input.hostId),
            cell: await d.store.hostCell(input.hostId),
            now: d.now(),
        }), FLEET_STEP_RETRY);
        if (!s.asked && s.claims === 0) {
            await d.step('host.served', () => d.store.moveHost(input.hostId, 'terminating', 'served'), FLEET_STEP_RETRY);
            return { outcome: 'served' };
        }
        if (s.now >= until) {
            await d.step('host.expired', () => d.store.moveHost(input.hostId, 'terminating', 'expired'), FLEET_STEP_RETRY);
            return { outcome: 'expired' };
        }
        if (!s.cell) throw new HostFailed('host_lost');
        if (provider.extend && s.now - lastExtend >= t.extendEveryMs) {
            await d.step(`extend:${i}`, () => provider.extend!(providerId, ttl), FLEET_STEP_RETRY);
            lastExtend = s.now;
        }
        await d.sleep(t.serveCheckMs);
    }
}

/**
 * Retires the cell (cordon and revoke on the hub) and destroys the host, each on its own: a hub that does not
 * answer never keeps the machine alive, and a provider that fails never keeps the cell enrolled. What did not
 * go through is tried again after a durable sleep, for TEARDOWN_BOUND_MS; then the host row is marked failed
 * (`teardown_failed`) and the workflow ends in error, so an operator sees it.
 */
async function teardown(hostId: string, providerId: string | null, provider: HostProvider | undefined, d: PerRunHostDeps) {
    let retired = false;
    let destroyed = !(providerId && provider);
    let waited = 0;
    let lastError: unknown;
    for (let round = 0; ; round++) {
        // Round 0 keeps the step names a teardown always had.
        const n = round === 0 ? '' : `:${round}`;
        if (!retired) {
            try {
                await d.step(`retire${n}`, () => d.hub.retire(hostId), FLEET_STEP_RETRY);
                retired = true;
            } catch (e) {
                lastError = e;
            }
        }
        if (!destroyed) {
            try {
                await destroy(providerId!, provider!, n, d);
                destroyed = true;
            } catch (e) {
                lastError = e;
            }
        }
        if (retired && destroyed) {
            await d.step(`host.terminated${n}`, () => d.store.moveHost(hostId, 'terminated', 'destroyed'), FLEET_STEP_RETRY);
            return;
        }
        const wait = Math.min(TEARDOWN_FIRST_WAIT_MS * 2 ** round, TEARDOWN_MAX_WAIT_MS);
        if (waited + wait > TEARDOWN_BOUND_MS) break;
        await d.sleep(wait);
        waited += wait;
    }
    const what = [retired ? null : 'retire', destroyed ? null : 'destroy'].filter(Boolean).join(' and ');
    await d.step('host.teardown_failed', () => d.store.moveHost(hostId, 'failed', 'failed', { lastError: 'teardown_failed' }), FLEET_STEP_RETRY).catch(() => undefined);
    throw new Error(`perRun teardown of ${hostId} did not finish (${what}): ${(lastError as Error | undefined)?.message ?? 'unknown error'}`);
}

/** Asks the provider to destroy the host, then waits up to five minutes for it to be gone; a destroy the provider accepted counts. */
async function destroy(providerId: string, provider: HostProvider, n: string, d: PerRunHostDeps) {
    await d.step(`destroy${n}`, () => provider.destroy(providerId), FLEET_STEP_RETRY);
    for (let i = 0; i < 60; i++) {
        const gone = await d.step(`destroyed${n}:${i}`, async () => (await provider.get(providerId)) === null).catch(() => false);
        if (gone) break;
        await d.sleep(5_000);
    }
}

import type { AcquireOptions, AcquireRequest, Blocked, Claim, EnvironmentRuntime, EnvError, ExecRequest, StepResult } from '@libs/runtime/environment';

import { ClaimLeaseKeeper, type LeaseKeeperOptions } from '../run/lease-keeper';
import type { LeaseHold } from '../run/ports';

/** What the suite engine asks of the environment. */
export type SuiteEnvironment = Pick<EnvironmentRuntime, 'acquire' | 'exec' | 'release'>;

const exhausted = (): Blocked => ({
    status: 'blocked',
    blockers: [{ kind: 'platform', signature: 'suite_tokens_exhausted', message: 'the suite run has no download token left for another claim' }],
});

/**
 * The environment of one suite run (docs/runtime/e2e-suites.md section 4). The cell revokes a repository download token
 * once it fetched with it, and a suite run holds one claim per shard plus the fresh host and the main host, so each
 * claim is acquired by a client built with a token of its own (`make`, the hub environment of one sealed token). A claim
 * acquired again by its idempotency key (a replay) keeps its client and spends no second token; with none left the
 * acquire is blocked, which the engine reads as infra. Commands and releases go through whichever client acquired the claim.
 */
export function suiteEnvironment(make: (sealedRepoToken: string) => EnvironmentRuntime, tokens: readonly string[], renewal?: Pick<LeaseKeeperOptions, 'everyMs' | 'retryMs' | 'timers' | 'onEvent'>): SuiteEnvironment {
    const byKey = new Map<string, EnvironmentRuntime>();
    const byClaim = new Map<string, EnvironmentRuntime>();
    const holds = new Map<string, LeaseHold>();
    let next = 0;
    let any: EnvironmentRuntime | undefined;
    const clientFor = (claimId: string): EnvironmentRuntime | undefined => byClaim.get(claimId) ?? any;
    return {
        async acquire(req: AcquireRequest, opts?: AcquireOptions): Promise<Claim | Blocked> {
            let client = byKey.get(req.idempotencyKey);
            if (!client) {
                if (next >= tokens.length) return exhausted();
                client = make(tokens[next++]);
                byKey.set(req.idempotencyKey, client);
            }
            any ??= client;
            const out = await client.acquire(req, opts);
            if ('claimId' in out) {
                byClaim.set(out.claimId, client);
                // A claim's lease is 45 minutes from its acquire and a suite outlasts it: keep it leased while the engine holds it.
                const renew = client.renew?.bind(client);
                if (renew && !holds.has(out.claimId)) holds.set(out.claimId, new ClaimLeaseKeeper((claimId) => renew(claimId, 'suite'), renewal).keep([out.claimId]));
            }
            return out;
        },
        async exec(claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
            const client = clientFor(claimId);
            if (!client) return { code: 'cell_unavailable', cellId: 'unknown' };
            return client.exec(claimId, req);
        },
        async release(claimId: string): Promise<void> {
            holds.get(claimId)?.stop();
            holds.delete(claimId);
            await clientFor(claimId)?.release(claimId);
        },
    };
}

/**
 * `env` with every exec naming `service` (the recipe's `suite.service`): the commands, polls, reads and kills of a suite
 * all run in that one container. A request that already names a service keeps it. Absent service: `env` itself.
 */
export function execInService<E extends Pick<EnvironmentRuntime, 'exec'>>(env: E, service: string | undefined): Pick<EnvironmentRuntime, 'exec'> {
    if (service === undefined) return env;
    return { exec: (claimId: string, req: ExecRequest) => env.exec(claimId, req.service !== undefined ? req : { ...req, service }) };
}

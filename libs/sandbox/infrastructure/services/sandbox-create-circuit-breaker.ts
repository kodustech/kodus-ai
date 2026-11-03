import { RateLimitError } from 'e2b';

import { createLogger } from '@libs/core/log/logger';

/**
 * Per-process circuit breaker around sandbox creation.
 *
 * When the E2B proxy or the E2B API degrades, every review used to pay the
 * full create budget (clone timeout × attempts + backoffs) before falling
 * back to self-contained mode. The breaker remembers recent infrastructure
 * failures and, once they cross a threshold, makes the next acquires fail
 * immediately so the review proceeds without a sandbox right away.
 *
 * - CLOSED: requests flow; infrastructure failures are recorded in a sliding
 *   window. The breaker opens when the window holds at least
 *   `failureThreshold` failures coming from at least `minDistinctOrgs`
 *   organizations. The floor is on organizations, not repositories: one
 *   tenant whose git host is down (or whose huge repos always time out)
 *   must not turn sandboxes off for every other tenant on the worker.
 * - OPEN: every request is rejected until `openMs` has elapsed.
 * - HALF_OPEN: exactly one probe request is let through. Its success closes
 *   the breaker; its failure re-opens it for another `openMs`. A probe that
 *   has not reported within `probeTimeoutMs` is replaced by a new one, so a
 *   create that never settles cannot keep the breaker HALF_OPEN for good.
 *   Reports from creates admitted before the trip are ignored either way.
 *
 * State is in memory, per worker process: each worker learns the outage on
 * its own after a handful of failures, which is enough to cap the damage
 * without a shared store that could itself be the thing that is degraded.
 */

export type SandboxCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SandboxCircuitBreakerOptions {
    windowMs: number;
    failureThreshold: number;
    minDistinctOrgs: number;
    openMs: number;
    probeTimeoutMs: number;
}

export const DEFAULT_SANDBOX_CIRCUIT_OPTIONS: SandboxCircuitBreakerOptions = {
    windowMs: 5 * 60_000,
    failureThreshold: 5,
    minDistinctOrgs: 3,
    openMs: 2 * 60_000,
    // Above one whole create: the head and base fetches (5 min each) plus
    // setup; a timeout is not retried
    probeTimeoutMs: 15 * 60_000,
};

/**
 * What tryAcquire() granted. Only the attempt holding the HALF_OPEN probe
 * may report on it; a create admitted earlier, while CLOSED, reports late
 * and must not free or fail someone else's probe.
 */
export interface SandboxCircuitPermit {
    probe: boolean;
    /**
     * Which probe this is. A probe replaced after probeTimeoutMs may still
     * report; only the current one's report counts.
     */
    probeId?: number;
}

export interface SandboxCircuitTransition {
    from: SandboxCircuitState;
    to: SandboxCircuitState;
    /** Failures in the window when the breaker opened from CLOSED. */
    failures: number;
    /** Distinct organizations behind those failures. */
    distinctOrgs: number;
    /** How long the breaker stays OPEN (only meaningful when `to` is OPEN). */
    openMs: number;
}

interface FailureRecord {
    at: number;
    orgKey: string;
}

export class SandboxCreateCircuitBreaker {
    private readonly logger = createLogger(SandboxCreateCircuitBreaker.name);
    private state: SandboxCircuitState = 'CLOSED';
    private failures: FailureRecord[] = [];
    private openedAt = 0;
    private probeInFlight = false;
    private probeGrantedAt = 0;
    private probeId = 0;

    constructor(
        private readonly options: SandboxCircuitBreakerOptions = DEFAULT_SANDBOX_CIRCUIT_OPTIONS,
        private readonly now: () => number = Date.now,
        /** Called on every state change, so the owner can log it. */
        private readonly onTransition?: (
            transition: SandboxCircuitTransition,
        ) => void,
    ) {}

    getState(): SandboxCircuitState {
        this.refreshState();
        return this.state;
    }

    /** Milliseconds until an OPEN breaker lets a probe through (0 otherwise). */
    remainingOpenMs(): number {
        if (this.getState() !== 'OPEN') return 0;
        return Math.max(0, this.openedAt + this.options.openMs - this.now());
    }

    /**
     * A permit when a create attempt may run now, null otherwise. In
     * HALF_OPEN the first caller becomes the probe and every other caller is
     * rejected until the probe reports back.
     */
    tryAcquire(): SandboxCircuitPermit | null {
        this.refreshState();
        if (this.state === 'CLOSED') return { probe: false };
        if (this.state === 'OPEN') return null;
        if (
            this.probeInFlight &&
            this.now() - this.probeGrantedAt < this.options.probeTimeoutMs
        ) {
            return null;
        }
        this.probeInFlight = true;
        this.probeGrantedAt = this.now();
        this.probeId += 1;
        return { probe: true, probeId: this.probeId };
    }

    /**
     * A create succeeded. While CLOSED that just clears the window. Once the
     * breaker tripped, only the probe's success proves recovery: a slow
     * create admitted before the trip that lands afterwards says nothing
     * about the outage, and closing on it would end fail-fast early.
     */
    recordSuccess(permit: SandboxCircuitPermit): void {
        this.refreshState();
        if (this.state === 'OPEN') return;
        if (this.state === 'HALF_OPEN' && !this.isCurrentProbe(permit)) return;
        this.probeInFlight = false;
        this.failures = [];
        this.transition('CLOSED', 0, 0);
    }

    /**
     * Record an infrastructure failure. Repository-specific failures (bad
     * credentials, deleted branch) must not be recorded: they say nothing
     * about the health of the sandbox infrastructure.
     */
    recordFailure(orgKey: string, permit: SandboxCircuitPermit): void {
        const now = this.now();
        this.refreshState();

        // Creates that passed tryAcquire() before the breaker opened report
        // their failures afterwards. They belong to the outage that already
        // opened it: re-arming would stretch the OPEN window past openMs.
        if (this.state === 'OPEN') return;

        if (this.state === 'HALF_OPEN') {
            // Only the current probe's outcome decides; a late failure from a
            // create admitted before the trip, or from a replaced probe, is
            // old news.
            if (!this.isCurrentProbe(permit)) return;
            this.probeInFlight = false;
            this.open(now, 1, 1);
            return;
        }

        this.failures.push({ at: now, orgKey });
        this.pruneWindow(now);

        const distinctOrgs = new Set(this.failures.map((f) => f.orgKey)).size;
        if (
            this.failures.length >= this.options.failureThreshold &&
            distinctOrgs >= this.options.minDistinctOrgs
        ) {
            this.open(now, this.failures.length, distinctOrgs);
        }
    }

    /**
     * A probe that ended without telling us anything about the
     * infrastructure (e.g. a repository-specific failure) must free the probe
     * slot, or the breaker would stay HALF_OPEN forever. Only the holder of
     * the current probe may free it: a replaced probe freeing the slot would
     * let a second probe run next to the live one.
     */
    releaseProbe(permit: SandboxCircuitPermit): void {
        if (this.isCurrentProbe(permit)) this.probeInFlight = false;
    }

    private isCurrentProbe(permit: SandboxCircuitPermit): boolean {
        return permit.probe && permit.probeId === this.probeId;
    }

    private open(now: number, failures: number, distinctOrgs: number): void {
        this.openedAt = now;
        this.failures = [];
        this.transition('OPEN', failures, distinctOrgs);
    }

    private refreshState(): void {
        if (
            this.state === 'OPEN' &&
            this.now() - this.openedAt >= this.options.openMs
        ) {
            this.probeInFlight = false;
            this.transition('HALF_OPEN', 0, 0);
        }
    }

    private transition(
        to: SandboxCircuitState,
        failures: number,
        distinctOrgs: number,
    ): void {
        const from = this.state;
        this.state = to;
        if (from === to) return;
        try {
            this.onTransition?.({
                from,
                to,
                failures,
                distinctOrgs,
                openMs: this.options.openMs,
            });
        } catch (error) {
            // The state change already happened; a broken sink must not fail
            // sandbox creation, but the lost transition is reported here. The
            // logger never throws (it filters by level and catches its own
            // failures), so `error` is the last stop and stays visible at
            // API_LOG_LEVEL=error.
            this.logger.error({
                message: `SandboxCreateCircuitBreaker: could not report the ${from} -> ${to} transition`,
                context: SandboxCreateCircuitBreaker.name,
                error,
                metadata: {
                    from,
                    to,
                    failures,
                    distinctOrgs,
                    openMs: this.options.openMs,
                },
            });
        }
    }

    private pruneWindow(now: number): void {
        const cutoff = now - this.options.windowMs;
        this.failures = this.failures.filter((f) => f.at >= cutoff);
    }
}

/**
 * Git and platform errors that depend on the repository or its credentials,
 * not on the sandbox infrastructure. Retrying them or counting them toward
 * the breaker would be wrong: the next attempt fails the same way and a
 * healthy proxy would get blamed for a revoked token.
 */
const REPOSITORY_SPECIFIC_FAILURE =
    /authentication failed|could not read username|repository not found|repository '[^']*' not found|could not be found or you don't have permission|either does not exist or you do not have access|requires a username|couldn't find remote ref|not our ref|invalid username or password|http basic: access denied|the requested url returned error: (401|403|404)|terminal prompts disabled|does not appear to be a git repository|permission denied \(publickey\)/i;

export function isRepositorySpecificSandboxFailure(err: unknown): boolean {
    const text = describeError(err);
    return REPOSITORY_SPECIFIC_FAILURE.test(text);
}

/**
 * E2B refusing a create because the plan has no room (its concurrent-sandbox
 * limit, or a rate limit): capacity, not a failure. The caller waits and
 * tries again; it is neither retried as a failure nor counted by the breaker.
 * Only the SDK's own error counts: a git host's "rate limit exceeded" during
 * the clone, or another RateLimitError by name, is an ordinary failure.
 */
export function isSandboxCapacityFailure(err: unknown): boolean {
    return err instanceof RateLimitError;
}

/**
 * A timeout means the network path (proxy, E2B, git host) was slow enough to
 * eat the whole budget; an immediate retry would spend the same budget again.
 */
export function isTimeoutSandboxFailure(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const name = (err as { name?: unknown }).name;
    if (name === 'TimeoutError') return true;
    return /\btimed? ?out\b|deadline exceeded/i.test(describeError(err));
}

function describeError(err: unknown): string {
    if (!err) return '';
    if (typeof err === 'string') return err;
    if (typeof err !== 'object') return String(err);
    const e = err as { message?: unknown; stderr?: unknown; stdout?: unknown };
    return [e.message, e.stderr, e.stdout]
        .filter((part) => typeof part === 'string')
        .join('\n');
}

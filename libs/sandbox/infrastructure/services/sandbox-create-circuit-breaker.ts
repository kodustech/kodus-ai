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
 *   `failureThreshold` failures coming from at least `minDistinctRepos`
 *   repositories. The distinct-repo floor keeps one huge repository that
 *   always times out from turning sandboxes off for everyone else.
 * - OPEN: every request is rejected until `openMs` has elapsed.
 * - HALF_OPEN: exactly one probe request is let through. Success closes the
 *   breaker; failure re-opens it for another `openMs`.
 *
 * State is in memory, per worker process: each worker learns the outage on
 * its own after a handful of failures, which is enough to cap the damage
 * without a shared store that could itself be the thing that is degraded.
 */

export type SandboxCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface SandboxCircuitBreakerOptions {
    windowMs: number;
    failureThreshold: number;
    minDistinctRepos: number;
    openMs: number;
}

export const DEFAULT_SANDBOX_CIRCUIT_OPTIONS: SandboxCircuitBreakerOptions = {
    windowMs: 5 * 60_000,
    failureThreshold: 5,
    minDistinctRepos: 3,
    openMs: 2 * 60_000,
};

interface FailureRecord {
    at: number;
    repoKey: string;
}

export class SandboxCreateCircuitBreaker {
    private state: SandboxCircuitState = 'CLOSED';
    private failures: FailureRecord[] = [];
    private openedAt = 0;
    private probeInFlight = false;

    constructor(
        private readonly options: SandboxCircuitBreakerOptions = DEFAULT_SANDBOX_CIRCUIT_OPTIONS,
        private readonly now: () => number = Date.now,
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
     * Whether a create attempt may run now. In HALF_OPEN the first caller
     * becomes the probe and every other caller is rejected until the probe
     * reports back.
     */
    tryAcquire(): boolean {
        this.refreshState();
        if (this.state === 'CLOSED') return true;
        if (this.state === 'OPEN') return false;
        if (this.probeInFlight) return false;
        this.probeInFlight = true;
        return true;
    }

    recordSuccess(): void {
        this.probeInFlight = false;
        this.state = 'CLOSED';
        this.failures = [];
    }

    /**
     * Record an infrastructure failure. Repository-specific failures (bad
     * credentials, deleted branch) must not be recorded: they say nothing
     * about the health of the sandbox infrastructure.
     */
    recordFailure(repoKey: string): void {
        const now = this.now();

        if (this.state === 'HALF_OPEN') {
            this.probeInFlight = false;
            this.open(now);
            return;
        }

        this.failures.push({ at: now, repoKey });
        this.pruneWindow(now);

        const distinctRepos = new Set(this.failures.map((f) => f.repoKey)).size;
        if (
            this.failures.length >= this.options.failureThreshold &&
            distinctRepos >= this.options.minDistinctRepos
        ) {
            this.open(now);
        }
    }

    /**
     * A probe that ended without telling us anything about the
     * infrastructure (e.g. a repository-specific failure) must free the probe
     * slot, or the breaker would stay HALF_OPEN forever.
     */
    releaseProbe(): void {
        this.probeInFlight = false;
    }

    private open(now: number): void {
        this.state = 'OPEN';
        this.openedAt = now;
        this.failures = [];
    }

    private refreshState(): void {
        if (
            this.state === 'OPEN' &&
            this.now() - this.openedAt >= this.options.openMs
        ) {
            this.state = 'HALF_OPEN';
            this.probeInFlight = false;
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
    /authentication failed|could not read username|repository not found|couldn't find remote ref|not our ref|invalid username or password|http basic: access denied|the requested url returned error: (401|403|404)|terminal prompts disabled|does not appear to be a git repository|permission denied \(publickey\)/i;

export function isRepositorySpecificSandboxFailure(err: unknown): boolean {
    const text = describeError(err);
    return REPOSITORY_SPECIFIC_FAILURE.test(text);
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

import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';

import { CacheService } from '@libs/core/cache/cache.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';
import { IRateLimitGateService } from '@libs/core/workflow/domain/contracts/rate-limit-gate.service.contract';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';

/**
 * GitHub rate-limit gate. Each processor calls `check()` BEFORE marking
 * the job PROCESSING; if the installation's primary bucket is below the
 * configured threshold, this throws `RateLimitError(resetAt)` so the
 * consumer's error handler can republish the message with a delay aligned
 * to the bucket reset, instead of burning a 9-min (webhook) or 1h45-min
 * (code-review) router timeout watching octokit sleep on retry-after.
 *
 * Design notes:
 *
 *   - Threshold of 200 leaves enough headroom for a worker that already
 *     dispatched a few `Promise.all` bursts to land inside the same
 *     window without flipping into the red. 100 was too tight under
 *     concurrent jobs; 500 wastes too much real budget pausing early.
 *
 *   - Adaptive cache TTL: 30s when bucket healthy, 5s when remaining is
 *     close to threshold. The shorter window near the edge keeps us
 *     from running blind right when accuracy matters most.
 *
 *   - Graceful fail: if `/rate_limit` itself fails (network glitch,
 *     installation token rotation in flight, etc.), we LOG and let the
 *     job proceed. A broken gate must not block all processing — the
 *     downstream octokit calls will still throw rate-limit errors if
 *     things are really bad, just without the proactive short-circuit.
 *
 *   - `/rate_limit` does not consume quota (GitHub docs). Safe to call
 *     once per job.
 */
const THRESHOLD_REMAINING = 200;
const TTL_HEALTHY_MS = 30 * 1000;
const TTL_NEAR_EDGE_MS = 5 * 1000;
const EDGE_PROXIMITY_FACTOR = 3; // "near edge" = remaining < threshold × 3

/**
 * Stored shape — note that `resetAt` is a unix-ms NUMBER, not a Date.
 * CacheService backs onto cache-manager which JSON-serializes values, so
 * a Date instance would come back as a string on the next read and break
 * downstream `getTime()` calls. We hydrate to Date only when constructing
 * the RateLimitError that we throw.
 */
interface CachedRateLimit {
    remaining: number;
    resetAtMs: number;
    cachedAt: number;
    ttlMs: number;
}

@Injectable()
export class GitHubRateLimitGateService implements IRateLimitGateService {
    private readonly logger = createLogger(GitHubRateLimitGateService.name);

    constructor(
        private readonly githubService: GithubService,
        private readonly cacheService: CacheService,
    ) {}

    async check(
        organizationAndTeamData: OrganizationAndTeamData,
        platformType: PlatformType,
    ): Promise<void> {
        // Only GitHub is implemented today. Other platforms (GitLab,
        // Bitbucket, Azure, Forgejo) have their own rate-limit semantics
        // and are out of scope for this gate — they pass through.
        if (platformType !== PlatformType.GITHUB) return;

        const cacheKey = this.makeCacheKey(organizationAndTeamData);
        const cached =
            await this.cacheService.getFromCache<CachedRateLimit>(cacheKey);

        let snapshot = cached;
        if (!snapshot || this.isStale(snapshot)) {
            snapshot = await this.refreshSnapshot(
                organizationAndTeamData,
                cacheKey,
            );
            if (!snapshot) {
                // Refresh failed and there's no usable cache — graceful
                // fail: let the job proceed and rely on octokit's
                // throttle plugin to handle whatever happens.
                return;
            }
        }

        if (snapshot.remaining < THRESHOLD_REMAINING) {
            const resetAt = new Date(snapshot.resetAtMs);
            this.logIfFresh(organizationAndTeamData, snapshot, resetAt);
            throw new RateLimitError({
                resetAt,
                remaining: snapshot.remaining,
                context: organizationAndTeamData,
            });
        }
    }

    /**
     * Suppress repeat warn logs for the same org within the cache TTL
     * window. In a real incident the gate fires on every job arrival
     * (potentially dozens/min/worker × 15 workers); without dedup, the
     * logs drown out everything else and the rate-limit signal becomes
     * impossible to find. We re-log only when the underlying snapshot
     * was refreshed (cachedAt advanced).
     */
    private lastLoggedAt = new Map<string, number>();
    private logIfFresh(
        organizationAndTeamData: OrganizationAndTeamData,
        snapshot: CachedRateLimit,
        resetAt: Date,
    ): void {
        const key = this.makeCacheKey(organizationAndTeamData);
        const previous = this.lastLoggedAt.get(key);
        if (previous === snapshot.cachedAt) return;
        this.lastLoggedAt.set(key, snapshot.cachedAt);
        this.logger.warn({
            message: `Rate-limit gate triggered: remaining=${snapshot.remaining}, threshold=${THRESHOLD_REMAINING}`,
            context: GitHubRateLimitGateService.name,
            metadata: {
                ...organizationAndTeamData,
                remaining: snapshot.remaining,
                threshold: THRESHOLD_REMAINING,
                resetAt,
            },
        });
    }

    private async refreshSnapshot(
        organizationAndTeamData: OrganizationAndTeamData,
        cacheKey: string,
    ): Promise<CachedRateLimit | null> {
        try {
            const octokit =
                await this.githubService.getAuthenticatedOctokit(
                    organizationAndTeamData,
                );
            const response = (await octokit.rest.rateLimit.get()) as any;
            const core = response?.data?.resources?.core;

            // Defensive: GitHub has historically responded with malformed
            // payloads under load (no `resources.core`, partial fields).
            // `remaining` and `reset` must both be finite numbers; NaN
            // would slip past `typeof === 'number'` and poison the
            // computed `resetAt`/delay downstream.
            if (
                !core ||
                !Number.isFinite(core.remaining) ||
                !Number.isFinite(core.reset)
            ) {
                this.logger.warn({
                    message:
                        'Rate-limit gate received malformed /rate_limit payload — letting job proceed',
                    context: GitHubRateLimitGateService.name,
                    metadata: {
                        ...organizationAndTeamData,
                        rawCore: core,
                    },
                });
                return null;
            }

            // GitHub `reset` is unix seconds — store as unix-ms so the
            // cache round-trip (JSON.stringify / JSON.parse) preserves
            // it as a number rather than turning a Date into a string.
            const resetAtMs = core.reset * 1000;
            const ttlMs = this.computeTtl(core.remaining);
            const snapshot: CachedRateLimit = {
                remaining: core.remaining,
                resetAtMs,
                cachedAt: Date.now(),
                ttlMs,
            };
            await this.cacheService.addToCache(cacheKey, snapshot, ttlMs);
            return snapshot;
        } catch (error) {
            this.logger.warn({
                message:
                    'Rate-limit gate could not refresh snapshot — letting job proceed',
                context: GitHubRateLimitGateService.name,
                error: error instanceof Error ? error : undefined,
                metadata: { ...organizationAndTeamData },
            });
            return null;
        }
    }

    private isStale(snapshot: CachedRateLimit): boolean {
        return Date.now() - snapshot.cachedAt >= snapshot.ttlMs;
    }

    private computeTtl(remaining: number): number {
        return remaining < THRESHOLD_REMAINING * EDGE_PROXIMITY_FACTOR
            ? TTL_NEAR_EDGE_MS
            : TTL_HEALTHY_MS;
    }

    private makeCacheKey(o: OrganizationAndTeamData): string {
        return `rl:github:${o.organizationId}:${o.teamId ?? 'no-team'}`;
    }
}

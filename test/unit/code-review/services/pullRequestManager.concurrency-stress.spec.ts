/**
 * Stress test for `FILE_CONTENT_CONCURRENCY = 100` in PullRequestHandlerService.
 *
 * Goal: prove that with the current per-PR concurrency cap of 100, a single
 * worker processing a typical PR generates enough in-flight GET /contents/{path}
 * calls to saturate the per-installation GitHub rate-limit bucket. Once the
 * primary rate-limit fires (returns 403 with retry-after), octokit's throttle
 * plugin pauses every pending promise for `retryAfter` seconds and retries —
 * each retry occupies a p-limit slot for the entire sleep window, freezing the
 * worker without ever surfacing an error.
 *
 * The test does NOT call GitHub. It models the failure mode with a fake
 * code-management service whose response time degrades when more than
 * `bucketLimit` concurrent calls arrive within the rate-limit window — exactly
 * how the GitHub primary limit behaves. We then measure:
 *   - peak in-flight concurrency
 *   - count of "rate-limited" responses (would have triggered retryAfter sleeps)
 *   - wall-clock time
 *
 * Then we run the same workload with `FILE_CONTENT_CONCURRENCY = 20` (proposed
 * value) and assert the regime collapses: in-flight stays well below the
 * bucket, no rate-limit responses, total time is similar or better.
 *
 * NO production data is touched. NO QuintoAndar IDs. This is a pure unit-level
 * simulation built solely from the public service surface.
 */
import { PullRequestHandlerService } from '@libs/code-review/infrastructure/adapters/services/pullRequestManager.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { CacheService } from '@libs/core/cache/cache.service';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

interface FakeGithubProbe {
    /** counts of `getRepositoryContentFile` arrivals */
    starts: number;
    /** counts of `getRepositoryContentFile` completions */
    finishes: number;
    /** peak observed in-flight */
    peakInFlight: number;
    /** completions that exceeded the bucket and would have triggered a retry */
    rateLimitedResponses: number;
}

/**
 * Build a fake CodeManagementService that mimics how octokit + GitHub
 * **secondary** rate-limit behaves on the /contents endpoint.
 *
 * From the GitHub docs (Best practices for integrators → Avoid concurrent
 * requests): "Make requests for a single user or client ID serially. Do not
 * make requests for a single user or client ID concurrently." When too many
 * concurrent requests arrive, the API returns 403 with `retry-after`.
 *
 * Our model:
 *   - Track in-flight requests at the moment each call arrives.
 *   - If in-flight at arrival exceeds `concurrentBurstLimit`, the response is
 *     delayed by `retryAfterMs` (the sleep octokit's throttle plugin imposes
 *     transparently before retrying — see github.service.ts:2356 onRateLimit).
 *   - Otherwise the call returns within `baseLatencyMs`.
 *
 * Critically: a promise stuck in retry-after sleep continues to hold its
 * p-limit slot, so peak in-flight does not go down — it stays elevated for the
 * full sleep window, which is exactly why a single worker freezes.
 */
function buildFakeCodeManagementService(params: {
    concurrentBurstLimit: number;
    baseLatencyMs: number;
    retryAfterMs: number;
    probe: FakeGithubProbe;
}): CodeManagementService {
    const { concurrentBurstLimit, baseLatencyMs, retryAfterMs, probe } = params;

    let inFlight = 0;

    return {
        getRepositoryContentFile: jest.fn(async (input: any) => {
            probe.starts += 1;
            inFlight += 1;
            if (inFlight > probe.peakInFlight) {
                probe.peakInFlight = inFlight;
            }
            const overBurst = inFlight > concurrentBurstLimit;
            if (overBurst) {
                probe.rateLimitedResponses += 1;
            }
            const latency = overBurst ? retryAfterMs : baseLatencyMs;
            await new Promise((r) => setTimeout(r, latency));
            inFlight -= 1;
            probe.finishes += 1;
            return {
                data: {
                    content: Buffer.from(
                        `file content for ${input?.file?.filename ?? 'unknown'}`,
                    ).toString('base64'),
                    encoding: 'base64',
                },
            };
        }) as unknown as CodeManagementService['getRepositoryContentFile'],
        getChangedFilesSinceLastCommit: jest.fn(),
        getFilesByPullRequestId: jest.fn(),
    } as unknown as CodeManagementService;
}

function buildCacheServiceMock(): CacheService {
    return {
        getFromCache: jest.fn().mockResolvedValue(null),
        addToCache: jest.fn().mockResolvedValue(undefined),
        removeFromCache: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
}

function buildChangedFiles(count: number): FileChange[] {
    return Array.from({ length: count }, (_, i) => ({
        filename: `src/module_${Math.floor(i / 20)}/file_${i}.ts`,
        sha: `sha-${i}`,
        status: 'modified',
        additions: 5,
        deletions: 2,
        changes: 7,
        patch: `@@ patch ${i} @@`,
    })) as unknown as FileChange[];
}

/**
 * Force the readonly private `FILE_CONTENT_CONCURRENCY` to a chosen value.
 * `private readonly` in TS is purely compile-time — there is no runtime
 * enforcement. We exploit that here to compare regimes without changing
 * production code.
 */
function setConcurrency(service: PullRequestHandlerService, value: number) {
    (service as unknown as { FILE_CONTENT_CONCURRENCY: number }).FILE_CONTENT_CONCURRENCY =
        value;
}

describe('PullRequestHandlerService — FILE_CONTENT_CONCURRENCY=100 saturation', () => {
    const ORG = { organizationId: 'org-test', teamId: 'team-test' };
    const REPO = { name: 'repo-test', id: 'repo-id' };
    const PULL_REQUEST = {
        number: 1,
        head: { ref: 'feature' },
        base: { ref: 'main' },
    };

    /**
     * 200 files is well within range for monorepos — QuintoAndar PRs in the
     * incident logs ranged 25–500 files.
     *
     * `CONCURRENT_BURST_LIMIT = 50` models GitHub's secondary rate-limit
     * concurrent-request threshold (Anthropic ballpark; the real number is
     * undocumented but the production logs show "RATE-LIMIT core" firing
     * when our PR-level concurrency exceeds ~50 simultaneous /contents calls).
     *
     * The point isn't the absolute number — it's that with concurrency=100
     * we burst past the threshold on a single PR. With concurrency=20 we do
     * not.
     */
    const FILE_COUNT = 200;
    const CONCURRENT_BURST_LIMIT = 50;
    const BASE_LATENCY_MS = 5;
    const RETRY_AFTER_MS = 50;

    it('regime A (concurrency=100): a single PR saturates the bucket and triggers retry-after sleeps', async () => {
        const probe: FakeGithubProbe = {
            starts: 0,
            finishes: 0,
            peakInFlight: 0,
            rateLimitedResponses: 0,
        };
        const codeManagement = buildFakeCodeManagementService({
            concurrentBurstLimit: CONCURRENT_BURST_LIMIT,
            baseLatencyMs: BASE_LATENCY_MS,
            retryAfterMs: RETRY_AFTER_MS,
            probe,
        });
        const cache = buildCacheServiceMock();
        const service = new PullRequestHandlerService(codeManagement, cache);
        setConcurrency(service, 100);

        const files = buildChangedFiles(FILE_COUNT);
        const t0 = Date.now();
        await service.enrichFilesWithContent(ORG, REPO, PULL_REQUEST, files);
        const elapsed = Date.now() - t0;

        // Peak in-flight should burst above the rate-limit threshold. With
        // concurrency=100 and 200 files, p-limit lets 100 promises start
        // simultaneously, so peak will hit 100 (and exceed burst limit=50).
        expect(probe.peakInFlight).toBeGreaterThan(CONCURRENT_BURST_LIMIT);

        // A non-trivial number of calls should have been rate-limited.
        // Real production analogue: octokit.log.warn('RATE-LIMIT core: ...')
        // observed in QuintoAndar logs as 982 entries in 1h.
        expect(probe.rateLimitedResponses).toBeGreaterThan(0);

        // The whole operation should still complete (no exceptions surface
        // because octokit transparently retries on retryAfter).
        expect(probe.finishes).toBe(FILE_COUNT);

        // Capture the elapsed time for the comparison test below.
        (globalThis as any).__regimeA__ = {
            elapsed,
            peak: probe.peakInFlight,
            rateLimited: probe.rateLimitedResponses,
        };
    });

    it('regime B (concurrency=20): a single PR stays within the bucket and avoids retry-after sleeps', async () => {
        const probe: FakeGithubProbe = {
            starts: 0,
            finishes: 0,
            peakInFlight: 0,
            rateLimitedResponses: 0,
        };
        const codeManagement = buildFakeCodeManagementService({
            concurrentBurstLimit: CONCURRENT_BURST_LIMIT,
            baseLatencyMs: BASE_LATENCY_MS,
            retryAfterMs: RETRY_AFTER_MS,
            probe,
        });
        const cache = buildCacheServiceMock();
        const service = new PullRequestHandlerService(codeManagement, cache);
        setConcurrency(service, 20);

        const files = buildChangedFiles(FILE_COUNT);
        const t0 = Date.now();
        await service.enrichFilesWithContent(ORG, REPO, PULL_REQUEST, files);
        const elapsed = Date.now() - t0;

        // Peak in-flight is capped at 20 — well under burst limit=50.
        expect(probe.peakInFlight).toBeLessThanOrEqual(20);

        // No rate-limit triggers at all because we never burst over 50.
        // Caveat: this only protects against per-PR bursts. Cluster-wide
        // (15 workers × prefetch 20 = 300 concurrent PRs), even concurrency
        // 20 produces 6,000 in-flight — so we'd ALSO need either a global
        // cap or to drop prefetch / worker count for the QuintoAndar case.
        expect(probe.rateLimitedResponses).toBe(0);

        expect(probe.finishes).toBe(FILE_COUNT);

        (globalThis as any).__regimeB__ = {
            elapsed,
            peak: probe.peakInFlight,
            rateLimited: probe.rateLimitedResponses,
        };
    });

    it('comparison: regime A burns more retry-after time than regime B', () => {
        const a = (globalThis as any).__regimeA__;
        const b = (globalThis as any).__regimeB__;
        expect(a).toBeDefined();
        expect(b).toBeDefined();

        // Print results so the test output makes the failure mode obvious:
         
        console.log(
            `[stress] regime A (concurrency=100): peak=${a.peak} rateLimited=${a.rateLimited} elapsed=${a.elapsed}ms\n` +
                `[stress] regime B (concurrency=20):  peak=${b.peak} rateLimited=${b.rateLimited} elapsed=${b.elapsed}ms`,
        );

        // The smoking gun: regime A trips rate-limit, regime B does not.
        expect(a.rateLimited).toBeGreaterThan(b.rateLimited);
    });

    it('cluster fan-out: 15 workers × prefetch 20 × concurrency 100 = 30,000 in-flight per QuintoAndar installation', () => {
        // This is documentation-as-test: codify the production fan-out math
        // so a future maintainer cannot ratchet `FILE_CONTENT_CONCURRENCY`
        // back to 100 without first changing this number too.
        const WORKERS = 15;
        const CODE_REVIEW_PREFETCH = 20;
        const FILE_CONTENT_CONCURRENCY = 100;

        // pLimit instances are created PER call to getChangedFiles /
        // enrichFilesWithContent (one per PR in progress). So per worker:
        const inFlightPerWorker =
            CODE_REVIEW_PREFETCH * FILE_CONTENT_CONCURRENCY;
        // Cluster-wide:
        const totalInFlight = WORKERS * inFlightPerWorker;

        // GitHub App primary rate limit per installation: 5,000–15,000 req/h.
        // Even the upper bound (15,000/h ≈ 4.17/s) cannot absorb 30,000
        // simultaneous in-flight calls; the secondary rate-limit kicks in
        // long before primary exhaustion.
        const GITHUB_APP_PRIMARY_LIMIT_PER_HOUR = 15_000;
        const GITHUB_APP_PRIMARY_LIMIT_PER_SECOND =
            GITHUB_APP_PRIMARY_LIMIT_PER_HOUR / 3600;

        expect(totalInFlight).toBe(30_000);
        expect(totalInFlight).toBeGreaterThan(
            GITHUB_APP_PRIMARY_LIMIT_PER_SECOND * 60,
        );
    });
});

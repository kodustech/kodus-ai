/**
 * Covers the design hypotheses we wanted the gate to satisfy:
 *
 *   H1 — /rate_limit transport failure: graceful fail (let job proceed).
 *   H2 — Token invalid/expired (401): same as H1 — gate doesn't classify
 *        the error itself; downstream code will fail PERMANENT if needed.
 *   H3 — Installation removed (404): same as H1.
 *   H4 — Pre-check OK but bucket saturates later: gate's job is best
 *        effort; race conditions are expected, octokit handles the
 *        downstream sleep.
 *   H5 — Cache adaptive TTL: short when remaining is close to threshold,
 *        long when bucket is healthy.
 *   H6 — Two callers in the same window read the same cached snapshot
 *        (cache works).
 *   H7 — Non-GitHub platforms pass through (no-op).
 */
import { GitHubRateLimitGateService } from '@libs/platform/infrastructure/adapters/services/github/github-rate-limit-gate.service';
import { CacheService } from '@libs/core/cache/cache.service';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { RateLimitError } from '@libs/core/workflow/domain/errors/rate-limit.error';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const ORG = { organizationId: 'org-1', teamId: 'team-1' };

function makeOctokitWithRateLimit(remaining: number, resetSeconds: number) {
    return {
        rest: {
            rateLimit: {
                get: jest.fn().mockResolvedValue({
                    data: {
                        resources: {
                            core: { remaining, reset: resetSeconds },
                        },
                    },
                }),
            },
        },
    };
}

function makeCacheStore() {
    const store = new Map<string, unknown>();
    return {
        store,
        cache: {
            getFromCache: jest.fn(async (key: string) => store.get(key) ?? null),
            addToCache: jest.fn(async (key: string, value: unknown) => {
                store.set(key, value);
            }),
            removeFromCache: jest.fn(async (key: string) => {
                store.delete(key);
            }),
        } as unknown as CacheService,
    };
}

describe('GitHubRateLimitGateService', () => {
    beforeEach(() => jest.clearAllMocks());

    it('throws RateLimitError with resetAt when bucket is below threshold', async () => {
        const reset = Math.floor(Date.now() / 1000) + 47 * 60; // 47 min ahead
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockResolvedValue(makeOctokitWithRateLimit(50, reset)),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(gate.check(ORG, PlatformType.GITHUB)).rejects.toThrow(
            RateLimitError,
        );

        // Capture the thrown error to assert its shape
        try {
            await gate.check(ORG, PlatformType.GITHUB);
        } catch (e) {
            expect(e).toBeInstanceOf(RateLimitError);
            expect((e as RateLimitError).resetAt).toBeInstanceOf(Date);
            expect((e as RateLimitError).remaining).toBe(50);
        }
    });

    it('passes silently when bucket is above threshold', async () => {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockResolvedValue(makeOctokitWithRateLimit(4500, reset)),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITHUB),
        ).resolves.toBeUndefined();
    });

    // H7
    it('passes through for non-GitHub platforms without consulting the API', async () => {
        const githubService = {
            getAuthenticatedOctokit: jest.fn(),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITLAB),
        ).resolves.toBeUndefined();
        await expect(
            gate.check(ORG, PlatformType.BITBUCKET),
        ).resolves.toBeUndefined();
        expect(githubService.getAuthenticatedOctokit).not.toHaveBeenCalled();
    });

    // H1
    it('graceful-fails when /rate_limit itself throws — job should proceed', async () => {
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockRejectedValue(new Error('network down')),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITHUB),
        ).resolves.toBeUndefined();
    });

    // H2 / H3 — same observable behavior: gate doesn't try to classify
    it('graceful-fails on 401 / 404 from getAuthenticatedOctokit', async () => {
        const githubService = {
            getAuthenticatedOctokit: jest.fn().mockRejectedValue({
                status: 401,
                message: 'token expired',
            }),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITHUB),
        ).resolves.toBeUndefined();
    });

    // H1 again — broken rateLimit.get() response shape
    it('graceful-fails when /rate_limit returns malformed payload', async () => {
        const githubService = {
            getAuthenticatedOctokit: jest.fn().mockResolvedValue({
                rest: {
                    rateLimit: {
                        get: jest.fn().mockResolvedValue({ data: {} }),
                    },
                },
            }),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITHUB),
        ).resolves.toBeUndefined();
    });

    // H6
    it('uses cached snapshot on the second call within TTL (single API hit)', async () => {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        const rateLimitGet = jest
            .fn()
            .mockResolvedValue({
                data: { resources: { core: { remaining: 4500, reset } } },
            });
        const githubService = {
            getAuthenticatedOctokit: jest.fn().mockResolvedValue({
                rest: { rateLimit: { get: rateLimitGet } },
            }),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await gate.check(ORG, PlatformType.GITHUB);
        await gate.check(ORG, PlatformType.GITHUB);
        await gate.check(ORG, PlatformType.GITHUB);

        expect(rateLimitGet).toHaveBeenCalledTimes(1);
    });

    // H5
    it('uses adaptive TTL: short cache (5s) when remaining is near the edge', async () => {
        // remaining = 500 puts us inside `threshold × 3 = 600`, so TTL=5s.
        const reset = Math.floor(Date.now() / 1000) + 3600;
        const { store, cache } = makeCacheStore();
        const githubService = {
            getAuthenticatedOctokit: jest.fn().mockResolvedValue({
                rest: {
                    rateLimit: {
                        get: jest.fn().mockResolvedValue({
                            data: {
                                resources: { core: { remaining: 500, reset } },
                            },
                        }),
                    },
                },
            }),
        } as unknown as GithubService;
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await gate.check(ORG, PlatformType.GITHUB);

        const entry = Array.from(store.values())[0] as {
            ttlMs: number;
            remaining: number;
        };
        expect(entry.ttlMs).toBeLessThanOrEqual(5_000);
        expect(entry.remaining).toBe(500);
    });

    it('uses long cache TTL (30s) when remaining is healthy', async () => {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        const { store, cache } = makeCacheStore();
        const githubService = {
            getAuthenticatedOctokit: jest.fn().mockResolvedValue({
                rest: {
                    rateLimit: {
                        get: jest.fn().mockResolvedValue({
                            data: {
                                resources: {
                                    core: { remaining: 4500, reset },
                                },
                            },
                        }),
                    },
                },
            }),
        } as unknown as GithubService;
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await gate.check(ORG, PlatformType.GITHUB);

        const entry = Array.from(store.values())[0] as {
            ttlMs: number;
            remaining: number;
        };
        expect(entry.ttlMs).toBeGreaterThanOrEqual(30_000);
    });

    it('attaches organization context to the thrown RateLimitError', async () => {
        const reset = Math.floor(Date.now() / 1000) + 60;
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockResolvedValue(makeOctokitWithRateLimit(10, reset)),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        try {
            await gate.check(ORG, PlatformType.GITHUB);
            fail('expected RateLimitError');
        } catch (e) {
            expect(e).toBeInstanceOf(RateLimitError);
            expect((e as RateLimitError).context).toEqual(ORG);
        }
    });

    // Boundary tests around the configured threshold (200).
    it('boundary: passes at remaining = 200 exactly (threshold is strict <)', async () => {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockResolvedValue(makeOctokitWithRateLimit(200, reset)),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITHUB),
        ).resolves.toBeUndefined();
    });

    it('boundary: blocks at remaining = 199 (one below threshold)', async () => {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockResolvedValue(makeOctokitWithRateLimit(199, reset)),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(gate.check(ORG, PlatformType.GITHUB)).rejects.toThrow(
            RateLimitError,
        );
    });

    // NaN/Infinity guard — H4 from the design hypotheses.
    it('graceful-fails when /rate_limit response has non-finite remaining', async () => {
        const githubService = {
            getAuthenticatedOctokit: jest.fn().mockResolvedValue({
                rest: {
                    rateLimit: {
                        get: jest.fn().mockResolvedValue({
                            data: {
                                resources: {
                                    core: {
                                        remaining: NaN,
                                        reset: 1234567890,
                                    },
                                },
                            },
                        }),
                    },
                },
            }),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITHUB),
        ).resolves.toBeUndefined();
    });

    it('graceful-fails when /rate_limit response has non-finite reset', async () => {
        const githubService = {
            getAuthenticatedOctokit: jest.fn().mockResolvedValue({
                rest: {
                    rateLimit: {
                        get: jest.fn().mockResolvedValue({
                            data: {
                                resources: {
                                    core: { remaining: 5000, reset: 'oops' },
                                },
                            },
                        }),
                    },
                },
            }),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);

        await expect(
            gate.check(ORG, PlatformType.GITHUB),
        ).resolves.toBeUndefined();
    });

    // Cache round-trip — the gate must store resetAt as a NUMBER so
    // JSON serialization preserves it. Reading back a stale snapshot
    // should still produce a usable Date.
    it('cache round-trip: resetAt is stored as a number, hydrated back to Date when throwing', async () => {
        const reset = Math.floor(Date.now() / 1000) + 1800;
        const { store, cache } = makeCacheStore();
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockResolvedValue(makeOctokitWithRateLimit(50, reset)),
        } as unknown as GithubService;
        const gate = new GitHubRateLimitGateService(githubService, cache);

        try {
            await gate.check(ORG, PlatformType.GITHUB);
            fail('expected RateLimitError');
        } catch (e) {
            const err = e as RateLimitError;
            expect(err.resetAt).toBeInstanceOf(Date);
            expect(err.resetAt.getTime()).toBe(reset * 1000);
        }

        // Simulate a real cache backend round-trip: stringify+parse the
        // stored snapshot and re-read. The resetAt field must survive as
        // a number (not a string).
        const entry = JSON.parse(
            JSON.stringify(Array.from(store.values())[0]),
        );
        expect(typeof entry.resetAtMs).toBe('number');
        expect(entry.resetAtMs).toBe(reset * 1000);
    });

    // Log dedup — under saturation we can see hundreds of gate hits per
    // minute. The warn should be emitted at most once per cached snapshot.
    it('log dedup: same cached snapshot triggers a single warn even across many block hits', async () => {
        const reset = Math.floor(Date.now() / 1000) + 3600;
        const githubService = {
            getAuthenticatedOctokit: jest
                .fn()
                .mockResolvedValue(makeOctokitWithRateLimit(50, reset)),
        } as unknown as GithubService;
        const { cache } = makeCacheStore();
        const gate = new GitHubRateLimitGateService(githubService, cache);
        const warnSpy = jest.spyOn(
            (gate as any).logger as { warn: jest.Mock },
            'warn',
        );

        // Three consecutive blocks against the same cached snapshot.
        for (let i = 0; i < 3; i++) {
            await gate.check(ORG, PlatformType.GITHUB).catch(() => undefined);
        }

        // The block message ("Rate-limit gate triggered") should fire
        // only once. Other warn calls (e.g. graceful-fail logging) would
        // not happen here because the API call succeeded.
        const blockLogs = warnSpy.mock.calls.filter((c) =>
            String((c[0] as any)?.message ?? '').includes(
                'Rate-limit gate triggered',
            ),
        );
        expect(blockLogs.length).toBe(1);
    });
});

import {
    BACKFILL_LOCK_CHUNK_SIZE,
    KodyLearningCronProvider,
} from './kodyLearning.cron';

/**
 * Covers the per-repo window partition added for issue #1506: a repo that has
 * never produced past-review rules gets the one-time 3-month backfill (guarded
 * by a per-repo lock), every other enabled repo gets the weekly (1-week) delta.
 */
function build(opts: {
    repoIds: string[];
    seeded: (repoId: string) => boolean;
    // Seeded status seen on the under-lock re-check (2nd call onwards).
    // Defaults to `seeded` — set it to model a repo seeded by a concurrent
    // config-save between the pre-lock check and acquiring its lock.
    seededAfterLock?: (repoId: string) => boolean;
    lockAcquired?: (repoId: string) => boolean;
    acquireThrows?: (repoId: string) => boolean;
}) {
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({
            configValue: {
                configs: {},
                repositories: opts.repoIds.map((id) => ({
                    id,
                    isSelected: true,
                    configs: {},
                })),
            },
        }),
    } as any;

    const generateKodyRulesUseCase = {
        execute: jest.fn().mockResolvedValue(undefined),
    } as any;

    let seededCallCount = 0;
    const generateInitialKodyRulesUseCase = {
        hasPastReviewRulesForRepos: jest.fn(
            (_org: string, repoIds: string[]) => {
                const predicate =
                    seededCallCount++ === 0
                        ? opts.seeded
                        : (opts.seededAfterLock ?? opts.seeded);
                return Promise.resolve(new Set(repoIds.filter(predicate)));
            },
        ),
    } as any;

    const releasedLocks: string[] = [];
    const distributedLockService = {
        acquire: jest.fn((key: string) => {
            const repoId = key.split(':').pop() as string;
            if (opts.acquireThrows?.(repoId)) {
                return Promise.reject(new Error(`acquire failed for ${repoId}`));
            }
            const acquired = opts.lockAcquired ? opts.lockAcquired(repoId) : true;
            return Promise.resolve(
                acquired
                    ? {
                          release: jest.fn(() => {
                              releasedLocks.push(repoId);
                              return Promise.resolve(undefined);
                          }),
                      }
                    : null,
            );
        }),
    } as any;

    const cron = new KodyLearningCronProvider(
        {} as any,
        parametersService,
        generateKodyRulesUseCase,
        generateInitialKodyRulesUseCase,
        distributedLockService,
    );

    return {
        cron,
        generateKodyRulesUseCase,
        generateInitialKodyRulesUseCase,
        distributedLockService,
        releasedLocks,
    };
}

const run = (cron: KodyLearningCronProvider) =>
    (cron as any).generateKodyRules({
        organizationId: 'org-1',
        teamId: 'team-1',
    });

describe('KodyLearningCronProvider — per-repo backfill window', () => {
    it('uses a 3-month window for repos with no past-review rules yet', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['r1'],
            seeded: () => false,
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['r1'] },
            'org-1',
        );
    });

    it('uses the 1-week window once a repo already has past-review rules', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['r1'],
            seeded: () => true,
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', weeks: 1, repositoriesIds: ['r1'] },
            'org-1',
        );
    });

    it('checks the whole team with a single query, not one per repo', async () => {
        const { cron, generateInitialKodyRulesUseCase } = build({
            repoIds: ['a', 'b', 'c'],
            seeded: () => true,
        });

        await run(cron);

        expect(
            generateInitialKodyRulesUseCase.hasPastReviewRulesForRepos,
        ).toHaveBeenCalledTimes(1);
        expect(
            generateInitialKodyRulesUseCase.hasPastReviewRulesForRepos,
        ).toHaveBeenCalledWith('org-1', ['a', 'b', 'c']);
    });

    it('splits a mixed set into one 3-month batch and one 1-week batch', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['fresh', 'seeded'],
            seeded: (id) => id === 'seeded',
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['fresh'] },
            'org-1',
        );
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', weeks: 1, repositoriesIds: ['seeded'] },
            'org-1',
        );
    });

    it('locks each backfilled repo and releases it after generation', async () => {
        const { cron, distributedLockService, releasedLocks } = build({
            repoIds: ['fresh'],
            seeded: () => false,
        });

        await run(cron);

        expect(distributedLockService.acquire).toHaveBeenCalledWith(
            'KODY_RULES:INITIAL_GEN:org-1:fresh',
            expect.objectContaining({ ttl: expect.any(Number) }),
        );
        expect(releasedLocks).toEqual(['fresh']);
    });

    it('skips a backfill repo whose lock is already held elsewhere', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['fresh', 'contended'],
            seeded: () => false,
            lockAcquired: (id) => id !== 'contended',
        });

        await run(cron);

        // Only the repo whose lock we acquired gets a 3-month run.
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['fresh'] },
            'org-1',
        );
    });

    it('re-checks under the lock and skips a repo seeded since the pre-lock check', async () => {
        // 'raced' looks unseeded pre-lock but a concurrent config-save seeds it
        // before the cron acquires its lock — it must NOT be backfilled again.
        const { cron, generateKodyRulesUseCase, releasedLocks } = build({
            repoIds: ['fresh', 'raced'],
            seeded: () => false,
            seededAfterLock: (id) => id === 'raced',
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['fresh'] },
            'org-1',
        );
        // Both locks were still acquired and released even though 'raced' was skipped.
        expect(releasedLocks.sort()).toEqual(['fresh', 'raced']);
    });

    it('does not run a 3-month backfill when every repo was seeded since the pre-lock check', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['raced'],
            seeded: () => false,
            seededAfterLock: () => true,
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).not.toHaveBeenCalled();
    });

    it('releases already-held locks when acquiring one repo throws', async () => {
        const { cron, generateKodyRulesUseCase, releasedLocks } = build({
            repoIds: ['a', 'b', 'c'],
            seeded: () => false,
            acquireThrows: (id) => id === 'b',
        });

        await run(cron);

        // 'b' failed to lock and is skipped; 'a' and 'c' proceed and release.
        expect(releasedLocks.sort()).toEqual(['a', 'c']);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['a', 'c'] },
            'org-1',
        );
    });

    it('falls back to the weekly window when the past-review check fails', async () => {
        const { cron, generateKodyRulesUseCase, generateInitialKodyRulesUseCase } =
            build({ repoIds: ['r1'], seeded: () => true });
        generateInitialKodyRulesUseCase.hasPastReviewRulesForRepos.mockRejectedValue(
            new Error('mongo down'),
        );

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', weeks: 1, repositoriesIds: ['r1'] },
            'org-1',
        );
    });
});

/**
 * Regression test for the incident fixed by
 * "fix(api): stop the Kody Learning cron from draining the DB pool"
 * (2026-08-14): every held advisory lock pins one pooled connection for its
 * entire lifetime, and the cron used to hold one per repo for the WHOLE
 * org's backfill at once. An org with more repos than the API's DB pool had
 * slots drained the same pool that serves HTTP traffic — sign-in hung 60s
 * and returned 401, nightly, for ~6h, for weeks before diagnosis.
 *
 * The fix (chunking) shipped with no test pinning the actual bound, so a
 * future refactor could silently widen or remove the chunk and reintroduce
 * the exact same production incident with nothing catching it.
 */
describe('KodyLearningCronProvider — backfill lock concurrency bound (pool exhaustion regression)', () => {
    it(`never holds more than BACKFILL_LOCK_CHUNK_SIZE (${BACKFILL_LOCK_CHUNK_SIZE}) backfill locks at once, across a repo count that spans multiple chunks`, async () => {
        const repoIds = Array.from({ length: 2 * BACKFILL_LOCK_CHUNK_SIZE + 1 }, (_, i) => `repo-${i}`);

        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    configs: {},
                    repositories: repoIds.map((id) => ({
                        id,
                        isSelected: true,
                        configs: {},
                    })),
                },
            }),
        } as any;

        const generateKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        } as any;

        // Nothing is seeded — every repo needs the 3-month backfill, so the
        // full repo count goes through the chunked-locking path.
        const generateInitialKodyRulesUseCase = {
            hasPastReviewRulesForRepos: jest
                .fn()
                .mockResolvedValue(new Set<string>()),
        } as any;

        let held = 0;
        let peakHeld = 0;
        const distributedLockService = {
            acquire: jest.fn(() => {
                held++;
                peakHeld = Math.max(peakHeld, held);
                return Promise.resolve({
                    release: jest.fn(() => {
                        held--;
                        return Promise.resolve(undefined);
                    }),
                });
            }),
        } as any;

        const cron = new KodyLearningCronProvider(
            {} as any,
            parametersService,
            generateKodyRulesUseCase,
            generateInitialKodyRulesUseCase,
            distributedLockService,
        );

        await (cron as any).generateKodyRules({
            organizationId: 'org-1',
            teamId: 'team-1',
        });

        expect(peakHeld).toBeLessThanOrEqual(BACKFILL_LOCK_CHUNK_SIZE);
        // Not just "under the cap" — actually reaches it, proving chunking
        // is real and not accidentally locking one-at-a-time (which would
        // also pass a bare <= assertion but defeat the batched-generate
        // call's purpose) or all-at-once (which the incident was).
        expect(peakHeld).toBe(BACKFILL_LOCK_CHUNK_SIZE);
        // 21 repos / chunk size 5 = 5 full chunks + 1 remainder = 6 batched
        // generate calls total.
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(
            Math.ceil(repoIds.length / BACKFILL_LOCK_CHUNK_SIZE),
        );
        // Every lock taken must eventually be released — the finally-block
        // guarantee the incident's fix also depends on.
        expect(held).toBe(0);
    });
});

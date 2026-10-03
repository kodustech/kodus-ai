import {
    MIN_DEGRADED_RUNS,
    recentReviewsCheck,
    ReviewRun,
    ReviewsDeps,
} from '../checks/reviews.checks';
import { DoctorContext, DoctorResult, DoctorTeam } from '../doctor.types';

/**
 * #2066: whether the reviews of the last days ran in full, from what each run
 * recorded. One transient loss must not flip the install to DEGRADED; a cause
 * becomes ! at 10% of runs and at least 3.
 */

const team = (over: Partial<DoctorTeam> = {}): DoctorTeam => ({
    organizationId: 'org-1',
    organizationName: 'acme',
    organizationActive: true,
    teamId: 'team-1',
    teamName: 'core',
    teamStatus: 'active',
    platform: 'GITLAB',
    integrationActive: true,
    repositories: [{ id: '1', name: 'api' }],
    codeReviewAutomationActive: true,
    ...over,
});

const ctx = (over: Partial<DoctorContext> = {}): DoctorContext => ({
    teams: [team()],
    codeReviewAutomationSeeded: true,
    licensed: true,
    env: { API_CRON_SYNC_CODE_REVIEW_REACTIONS: '0 0 * * *' },
    ...over,
});

const full = (): ReviewRun => ({
    status: 'success',
    warningKinds: [],
    agentCutShort: false,
});
const runs = (n: number, run: () => ReviewRun = full) =>
    Array.from({ length: n }, run);

const deps = (over: Partial<ReviewsDeps> & { list?: ReviewRun[] } = {}) => ({
    runs: jest.fn(async () => over.list ?? runs(10)),
    suggestions: jest.fn(
        over.suggestions ??
            (async () => ({
                sent: 20,
                deliveryFailed: 0,
                heldBack: 5,
                implemented: 4,
            })),
    ),
    feedback: jest.fn(
        over.feedback ?? (async () => ({ thumbsUp: 3, thumbsDown: 1 })),
    ),
});

const line = (results: DoctorResult[], check: string) =>
    results.find((r) => r.check === check);
const problems = (results: DoctorResult[]) =>
    results.filter((r) => r.status === 'fail' || r.status === 'warn');

describe('recent reviews (#2066)', () => {
    it('reports reviews that ran in full, with no ! or ✘', async () => {
        const results = await recentReviewsCheck(deps()).run(ctx());

        expect(problems(results)).toEqual([]);
        expect(line(results, 'reviews.full')).toMatchObject({
            status: 'ok',
            title: '10 review(s) in the last 7 days ran in full.',
        });
    });

    it('fails when every review of the window failed', async () => {
        const failed = (): ReviewRun => ({
            ...full(),
            status: 'error',
            errorMessage:
                'Code review failed: The configured API key appears invalid',
        });
        const results = await recentReviewsCheck(
            deps({ list: runs(4, failed) }),
        ).run(ctx());

        expect(line(results, 'reviews.failed')).toMatchObject({
            status: 'fail',
            title: 'Every review in the last 7 days failed (4).',
        });
        expect(line(results, 'reviews.failed')?.fix).toContain(
            'The configured API key appears invalid',
        );
    });

    it('does not fail the install on fewer than 3 failed reviews', async () => {
        const failed = (): ReviewRun => ({ ...full(), status: 'error' });
        const results = await recentReviewsCheck(
            deps({ list: runs(2, failed) }),
        ).run(ctx());

        expect(line(results, 'reviews.failed')?.status).toBe('info');
    });

    it('a cause hitting 10% of runs and at least 3 is degraded', async () => {
        const lost = (): ReviewRun => ({
            ...full(),
            warningKinds: ['SANDBOX_UNAVAILABLE'],
        });
        const results = await recentReviewsCheck(
            deps({ list: [...runs(17), ...runs(3, lost)] }),
        ).run(ctx());

        expect(line(results, 'reviews.sandbox')).toMatchObject({
            status: 'warn',
            title: '3 of 20 reviews ran without the repository checked out.',
            scope: 'acme/core',
        });
        expect(line(results, 'reviews.full')).toBeUndefined();
    });

    it('one transient loss is advisory, not degraded', async () => {
        const lost = (): ReviewRun => ({
            ...full(),
            warningKinds: ['SANDBOX_UNAVAILABLE'],
        });
        const results = await recentReviewsCheck(
            deps({ list: [...runs(199), lost()] }),
        ).run(ctx());

        expect(line(results, 'reviews.sandbox')?.status).toBe('info');
        expect(problems(results)).toEqual([]);
    });

    it(`fewer than ${MIN_DEGRADED_RUNS} runs with a cause stay advisory, whatever the share`, async () => {
        const lost = (): ReviewRun => ({
            ...full(),
            warningKinds: ['PROVIDER_FALLBACK'],
        });
        const results = await recentReviewsCheck(
            deps({ list: [...runs(2), ...runs(2, lost)] }),
        ).run(ctx());

        expect(line(results, 'reviews.fallback')?.status).toBe('info');
    });

    it('reports the context-window counter-measures as one line', async () => {
        const cut = (): ReviewRun => ({
            ...full(),
            warningKinds: ['PROMPT_COMPACTED', 'DIFF_TRUNCATED'],
        });
        const results = await recentReviewsCheck(
            deps({ list: runs(5, cut) }),
        ).run(ctx());

        expect(
            results.filter((r) => r.check === 'reviews.context_window'),
        ).toHaveLength(1);
        expect(line(results, 'reviews.context_window')?.title).toBe(
            "5 of 5 reviews were cut down to fit the model's context window.",
        );
    });

    it('counts reviews where an agent stopped early', async () => {
        const cut = (): ReviewRun => ({ ...full(), agentCutShort: true });
        const results = await recentReviewsCheck(
            deps({ list: [...runs(6), ...runs(4, cut)] }),
        ).run(ctx());

        expect(line(results, 'reviews.cut_short')?.status).toBe('warn');
    });

    it('says when nothing was reviewed, and why when it was all skipped', async () => {
        const skipped = (): ReviewRun => ({ ...full(), status: 'skipped' });

        const none = await recentReviewsCheck(deps({ list: [] })).run(ctx());
        const allSkipped = await recentReviewsCheck(
            deps({ list: runs(3, skipped) }),
        ).run(ctx());

        expect(line(none, 'reviews.none')?.title).toBe(
            'No pull request was reviewed in the last 7 days.',
        );
        expect(line(allSkipped, 'reviews.none')?.title).toBe(
            'No pull request was reviewed in the last 7 days (3 skipped by your settings).',
        );
    });

    it('only looks at teams that review', async () => {
        const d = deps();
        await recentReviewsCheck(d).run(
            ctx({
                teams: [
                    team({
                        organizationId: 'empty',
                        teamId: 'empty-team',
                        platform: undefined,
                        integrationActive: false,
                        repositories: [],
                    }),
                    team(),
                ],
            }),
        );

        expect(d.runs).toHaveBeenCalledTimes(1);
        expect(d.suggestions).toHaveBeenCalledWith('org-1');
        expect(d.suggestions).not.toHaveBeenCalledWith('empty');
    });

    it('findings that could not be posted are degraded at 10% and at least 3', async () => {
        const results = await recentReviewsCheck(
            deps({
                suggestions: async () => ({
                    sent: 27,
                    deliveryFailed: 3,
                    heldBack: 0,
                    implemented: 0,
                }),
            }),
        ).run(ctx());

        expect(line(results, 'suggestions.delivery')).toMatchObject({
            status: 'warn',
            title: '3 of 30 findings in the last 7 days could not be posted on the pull request.',
        });
    });

    it('feedback is a count only, and says when reactions are not collected', async () => {
        const collected = await recentReviewsCheck(deps()).run(ctx());
        const notCollected = await recentReviewsCheck(deps()).run(
            ctx({ env: {} }),
        );

        expect(line(collected, 'feedback.reactions')).toMatchObject({
            status: 'info',
            title: "Last 7 days: 3 👍 and 1 👎 on Kody's comments.",
        });
        expect(line(notCollected, 'feedback.reactions')).toMatchObject({
            status: 'info',
            title: "👍/👎 on Kody's comments are not collected.",
        });
    });
});

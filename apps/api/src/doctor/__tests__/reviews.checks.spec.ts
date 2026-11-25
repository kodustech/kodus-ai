import {
    MIN_DEGRADED_RUNS,
    recentReviewsCheck,
    recentSuggestionsCheck,
    ReviewRun,
    SuggestionsDeps,
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

const deps = (
    over: Partial<SuggestionsDeps> & { list?: ReviewRun[] } = {},
) => ({
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
            title: 'No pull request got a review in the last 7 days: all 4 attempts failed.',
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

    it('a review that finished with issues is not reported as ran in full', async () => {
        const partial = (): ReviewRun => ({
            ...full(),
            status: 'partial_error',
        });
        const results = await recentReviewsCheck(
            deps({ list: [...runs(7), ...runs(3, partial)] }),
        ).run(ctx());

        expect(line(results, 'reviews.partial')).toMatchObject({
            status: 'warn',
            title: '3 of 10 reviews finished with issues: a step around the review failed.',
        });
        expect(line(results, 'reviews.full')).toBeUndefined();
    });

    it('counts reviews where an agent stopped early', async () => {
        const cut = (): ReviewRun => ({ ...full(), agentCutShort: true });
        const results = await recentReviewsCheck(
            deps({ list: [...runs(6), ...runs(4, cut)] }),
        ).run(ctx());

        expect(line(results, 'reviews.cut_short')?.status).toBe('warn');
    });

    it('says when nothing was reviewed, and why when it was all skipped', async () => {
        const skipped = (): ReviewRun => ({
            ...full(),
            status: 'skipped',
            errorMessage:
                "Draft PR Skipped — Enable 'Running on Draft Pull Requests' in settings or mark as Ready",
        });

        const none = await recentReviewsCheck(deps({ list: [] })).run(ctx());
        const allSkipped = await recentReviewsCheck(
            deps({ list: runs(3, skipped) }),
        ).run(ctx());

        expect(line(none, 'reviews.none')?.title).toBe(
            'No pull request was reviewed in the last 7 days.',
        );
        expect(line(allSkipped, 'reviews.none')?.status).toBe('info');
        expect(line(allSkipped, 'reviews.none')?.fix).toBe(
            'Every pull request of the window was skipped: see the "skipped by your settings" line.',
        );
        expect(line(allSkipped, 'reviews.skipped')).toMatchObject({
            status: 'skip',
            title: '3 pull request(s) in the last 7 days were skipped by your settings (3 draft).',
        });
        expect(problems(allSkipped)).toEqual([]);
    });

    describe('skips that are not settings', () => {
        const skippedFor = (message: string) => (): ReviewRun => ({
            ...full(),
            status: 'skipped',
            errorMessage: message,
        });

        it('a Git rate limit on every pull request is a failure, not "your settings"', async () => {
            const results = await recentReviewsCheck(
                deps({
                    list: runs(
                        4,
                        skippedFor(
                            'Provider Rate Limited — Re-run the review once the provider rate-limit window refills',
                        ),
                    ),
                }),
            ).run(ctx());

            expect(line(results, 'reviews.failed')).toMatchObject({
                status: 'fail',
                title: 'No pull request got a review in the last 7 days: all 4 attempts failed.',
            });
            expect(line(results, 'reviews.failed')?.fix).toContain(
                'rate-limited',
            );
            expect(line(results, 'reviews.skipped')).toBeUndefined();
        });

        it('broken configs among real reviews degrade, with their own fix', async () => {
            const results = await recentReviewsCheck(
                deps({
                    list: [
                        ...runs(10),
                        ...runs(
                            3,
                            skippedFor(
                                'Unable to load or resolve the review configuration.',
                            ),
                        ),
                    ],
                }),
            ).run(ctx());

            expect(line(results, 'reviews.not_run')).toMatchObject({
                status: 'warn',
                title: '3 of 13 pull requests in the last 7 days were not reviewed (3 the review configuration could not be read).',
            });
            expect(line(results, 'reviews.not_run')?.fix).toContain(
                'kodus-config.yml',
            );
        });

        it('an @kody -v request refused for custom agents is not a missed review', async () => {
            const results = await recentReviewsCheck(
                deps({
                    list: runs(
                        4,
                        skippedFor(
                            'Custom agents are in beta and BETA_FEATURES is off on this install.',
                        ),
                    ),
                }),
            ).run(ctx());

            expect(problems(results)).toEqual([]);
            expect(line(results, 'reviews.failed')).toBeUndefined();
            expect(line(results, 'reviews.not_run')).toBeUndefined();
            expect(line(results, 'reviews.command_skipped')).toMatchObject({
                status: 'info',
                title: '4 `@kody -v` request(s) in the last 7 days did not run (4 custom agents need BETA_FEATURES=true); the regular reviews were not affected.',
            });
        });

        it('a window skipped only for seats points at the seat line', async () => {
            const results = await recentReviewsCheck(
                deps({
                    list: runs(
                        1,
                        skippedFor('User Not Licensed — Assign seat to user'),
                    ),
                }),
            ).run(ctx());
            expect(line(results, 'reviews.none')?.fix).toBe(
                'Every pull request of the window was skipped: see the seat line.',
            );
        });

        it('seat skips are left to license.seats, and unclear ones are not called settings', async () => {
            const results = await recentReviewsCheck(
                deps({
                    list: [
                        ...runs(5),
                        ...runs(
                            2,
                            skippedFor(
                                'User Not Licensed — Assign seat to user',
                            ),
                        ),
                        ...runs(2, skippedFor('No Files Changed')),
                        ...runs(1, skippedFor('Something new happened')),
                    ],
                }),
            ).run(ctx());

            expect(line(results, 'reviews.not_run')).toBeUndefined();
            expect(line(results, 'reviews.skipped')).toBeUndefined();
            expect(line(results, 'reviews.skipped_other')).toMatchObject({
                status: 'info',
                title: '3 pull request(s) in the last 7 days were skipped (2 no changed files, 1 Something new happened).',
            });
            expect(line(results, 'reviews.full')?.status).toBe('ok');
        });
    });

    describe('losses', () => {
        it('maps every recorded loss; verification losses degrade', async () => {
            const lost = (): ReviewRun => ({
                ...full(),
                warningKinds: ['VERIFY_UNAVAILABLE'],
            });
            const results = await recentReviewsCheck(
                deps({ list: [...runs(7), ...runs(3, lost)] }),
            ).run(ctx());

            expect(line(results, 'reviews.verify')).toMatchObject({
                status: 'warn',
                title: '3 of 10 reviews discarded findings because their verification failed.',
            });
            expect(line(results, 'reviews.full')).toBeUndefined();
        });

        it('a kind no line explains is still a loss, never "ran in full"', async () => {
            const lost = (): ReviewRun => ({
                ...full(),
                warningKinds: ['SOMETHING_NEW'],
            });
            const results = await recentReviewsCheck(
                deps({ list: [...runs(4), ...runs(1, lost)] }),
            ).run(ctx());

            expect(line(results, 'reviews.other_losses')).toMatchObject({
                status: 'info',
                title: '1 of 5 reviews recorded other losses (SOMETHING_NEW).',
            });
            expect(line(results, 'reviews.full')).toBeUndefined();
        });

        it('quality notes the admin cannot act on never degrade, and by-design kinds are no loss', async () => {
            const downgraded = (): ReviewRun => ({
                ...full(),
                warningKinds: ['BAD_FIX_DOWNGRADED'],
            });
            const changedSkill = (): ReviewRun => ({
                ...full(),
                warningKinds: ['SKILL_CHANGED_IN_PR'],
            });
            const results = await recentReviewsCheck(
                deps({ list: runs(10, downgraded) }),
            ).run(ctx());
            const benign = await recentReviewsCheck(
                deps({ list: runs(5, changedSkill) }),
            ).run(ctx());

            expect(line(results, 'reviews.fix_downgraded')?.status).toBe(
                'info',
            );
            expect(problems(results)).toEqual([]);
            expect(line(benign, 'reviews.full')?.status).toBe('ok');
        });
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

        const s = deps();
        await recentSuggestionsCheck(s).run(
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
        expect(s.suggestions).toHaveBeenCalledWith('org-1');
        expect(s.suggestions).not.toHaveBeenCalledWith('empty');
    });

    it('findings that could not be posted are degraded at 10% and at least 3', async () => {
        const results = await recentSuggestionsCheck(
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
        const collected = await recentSuggestionsCheck(deps()).run(ctx());
        const notCollected = await recentSuggestionsCheck(deps()).run(
            ctx({ env: {} }),
        );

        // The cron stores each comment's running total, not the reactions of
        // the window, and the title says so.
        expect(line(collected, 'feedback.reactions')).toMatchObject({
            status: 'info',
            title: "Kody's comments whose reactions were synced in the last 7 days have 3 👍 and 1 👎 in total.",
        });
        expect(line(notCollected, 'feedback.reactions')).toMatchObject({
            status: 'info',
            title: "👍/👎 on Kody's comments are not collected.",
        });
    });
});

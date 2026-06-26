import { CockpitReportsService } from './cockpit-reports.service';

/**
 * Unit tests for the report data composition. The three cockpit services are
 * mocked; we assert the mapping/gating logic that the templates depend on.
 */
describe('CockpitReportsService', () => {
    let review: any;
    let codeHealth: any;
    let productivity: any;
    let kodyRules: any;
    let service: CockpitReportsService;

    const ORG = 'org-1';
    const START = '2026-06-01';
    const END = '2026-06-15';

    beforeEach(() => {
        review = {
            getReviewOperationalMetrics: jest.fn(),
            getImplementationRateBySeverity: jest.fn(),
            getReviewQualityByRuleGroup: jest.fn(),
            getImplementationRateWeekly: jest.fn(),
            getRepositoriesHealth: jest.fn(),
            getImplementationRateByCategory: jest.fn().mockResolvedValue([]),
            getNegativeFeedbackByCategory: jest.fn().mockResolvedValue([]),
            getKodyRulesUsage: jest.fn().mockResolvedValue([]),
        };
        codeHealth = { getImplementationRate: jest.fn() };
        productivity = { getLeadTimeHighlight: jest.fn() };
        kodyRules = {
            findByOrganizationId: jest.fn().mockResolvedValue({ rules: [] }),
        };
        service = new CockpitReportsService(
            review,
            codeHealth,
            productivity,
            kodyRules,
        );
    });

    function opsMetrics(processedReviews: number) {
        return {
            currentPeriod: { processedReviews },
            previousPeriod: { processedReviews: 0 },
            comparison: {
                processedReviews: { trend: 'improved', percentageChange: 10 },
            },
        };
    }

    describe('buildRepoSection', () => {
        it('returns null when the repo had no reviews in the window', async () => {
            review.getReviewOperationalMetrics.mockResolvedValue(opsMetrics(0));

            const section = await service.buildRepoSection(
                ORG,
                'acme/api',
                START,
                END,
            );

            expect(section).toBeNull();
            // Short-circuits before hitting the heavier queries.
            expect(codeHealth.getImplementationRate).not.toHaveBeenCalled();
        });

        it('maps the critical-implemented hero and gates feedback by volume', async () => {
            review.getReviewOperationalMetrics.mockResolvedValue(
                opsMetrics(58),
            );
            codeHealth.getImplementationRate
                .mockResolvedValueOnce({
                    suggestionsSent: 187,
                    suggestionsImplemented: 86,
                    implementationRate: 0.46,
                })
                .mockResolvedValueOnce({
                    suggestionsSent: 164,
                    suggestionsImplemented: 69,
                    implementationRate: 0.42,
                });
            review.getImplementationRateBySeverity.mockResolvedValue([
                { severity: 'critical', sent: 18, implemented: 14 },
                { severity: 'high', sent: 40, implemented: 20 },
            ]);
            // Total votes 1+1+2+1 = 5 < MIN_FEEDBACK_VOTES(10) → not enough.
            review.getReviewQualityByRuleGroup.mockResolvedValue([
                {
                    group: 'kody_rules',
                    sent: 40,
                    implemented: 14,
                    rate: 0.35,
                    thumbsUp: 1,
                    thumbsDown: 1,
                },
                {
                    group: 'general',
                    sent: 147,
                    implemented: 72,
                    rate: 0.49,
                    thumbsUp: 2,
                    thumbsDown: 1,
                },
            ]);
            review.getImplementationRateWeekly.mockResolvedValue([
                { weekStart: '2026-06-01', sent: 90, implemented: 54 },
            ]);

            const section = await service.buildRepoSection(
                ORG,
                'acme/api',
                START,
                END,
            );

            expect(section).not.toBeNull();
            expect(section!.criticalImplemented).toBe(14);
            expect(section!.criticalSent).toBe(18);
            expect(section!.implementationRate).toBe(0.46);
            // 0.46 - 0.42 = +4pp, improving.
            expect(section!.implementationRatePpChange).toBe(4);
            expect(section!.implementationRateTrend).toBe('improved');

            expect(section!.feedback.totalVotes).toBe(5);
            expect(section!.feedback.hasEnoughVotes).toBe(false);
            expect(section!.feedback.kodyRules.negativeRate).toBeCloseTo(0.5);
            expect(section!.feedback.general.negativeRate).toBeCloseTo(0.33);
        });

        it('flags hasEnoughVotes once total feedback clears the floor', async () => {
            review.getReviewOperationalMetrics.mockResolvedValue(
                opsMetrics(58),
            );
            codeHealth.getImplementationRate.mockResolvedValue({
                suggestionsSent: 100,
                suggestionsImplemented: 50,
                implementationRate: 0.5,
            });
            review.getImplementationRateBySeverity.mockResolvedValue([]);
            review.getReviewQualityByRuleGroup.mockResolvedValue([
                {
                    group: 'general',
                    sent: 100,
                    implemented: 50,
                    rate: 0.5,
                    thumbsUp: 8,
                    thumbsDown: 4,
                },
            ]);
            review.getImplementationRateWeekly.mockResolvedValue([]);

            const section = await service.buildRepoSection(
                ORG,
                'acme/api',
                START,
                END,
            );

            expect(section!.criticalImplemented).toBe(0);
            expect(section!.feedback.totalVotes).toBe(12);
            expect(section!.feedback.hasEnoughVotes).toBe(true);
            expect(section!.feedback.kodyRules.negativeRate).toBeNull();
        });
    });

        it('builds category rows (excluding kody_rules) and rule health worst-first', async () => {
            review.getReviewOperationalMetrics.mockResolvedValue(
                opsMetrics(58),
            );
            codeHealth.getImplementationRate.mockResolvedValue({
                suggestionsSent: 100,
                suggestionsImplemented: 50,
                implementationRate: 0.5,
            });
            review.getImplementationRateBySeverity.mockResolvedValue([]);
            review.getReviewQualityByRuleGroup.mockResolvedValue([]);
            review.getImplementationRateWeekly.mockResolvedValue([]);
            review.getImplementationRateByCategory.mockResolvedValue([
                { category: 'bug', sent: 30, implemented: 18, rate: 0.6 },
                { category: 'kody_rules', sent: 10, implemented: 2, rate: 0.2 },
                {
                    category: 'performance',
                    sent: 12,
                    implemented: 3,
                    rate: 0.25,
                },
            ]);
            review.getNegativeFeedbackByCategory.mockResolvedValue([
                { category: 'performance', thumbsUp: 1, thumbsDown: 5 },
            ]);
            review.getKodyRulesUsage.mockResolvedValue([
                {
                    ruleId: 'r-noisy',
                    triggers: 10,
                    implemented: 1,
                    rate: 0.1,
                    thumbsUp: 0,
                    thumbsDown: 4,
                    lastTriggeredAt: null,
                },
                {
                    ruleId: 'r-healthy',
                    triggers: 8,
                    implemented: 6,
                    rate: 0.75,
                    thumbsUp: 2,
                    thumbsDown: 0,
                    lastTriggeredAt: null,
                },
                {
                    ruleId: 'r-deleted',
                    triggers: 3,
                    implemented: 0,
                    rate: 0,
                    thumbsUp: 0,
                    thumbsDown: 0,
                    lastTriggeredAt: null,
                },
            ]);
            kodyRules.findByOrganizationId.mockResolvedValue({
                rules: [
                    { uuid: 'r-noisy', title: 'Noisy rule', status: 'active' },
                    {
                        uuid: 'r-healthy',
                        title: 'Healthy rule',
                        status: 'active',
                    },
                ],
            });

            const section = await service.buildRepoSection(
                ORG,
                'acme/api',
                START,
                END,
            );

            // kody_rules category excluded; sorted by volume.
            expect(section!.categories.map((c) => c.category)).toEqual([
                'bug',
                'performance',
            ]);
            expect(section!.categories[1].thumbsDown).toBe(5);
            // Only attention-worthy rules surface: deleted rule dropped,
            // healthy rule filtered out, noisy one kept.
            expect(section!.rules.map((r) => r.title)).toEqual(['Noisy rule']);
            expect(section!.rules[0].state).toBe('noisy');
        });

    describe('buildRepoSections', () => {
        it('drops repos with no activity', async () => {
            review.getReviewOperationalMetrics
                .mockResolvedValueOnce(opsMetrics(0))
                .mockResolvedValueOnce(opsMetrics(10));
            codeHealth.getImplementationRate.mockResolvedValue({
                suggestionsSent: 10,
                suggestionsImplemented: 5,
                implementationRate: 0.5,
            });
            review.getImplementationRateBySeverity.mockResolvedValue([]);
            review.getReviewQualityByRuleGroup.mockResolvedValue([]);
            review.getImplementationRateWeekly.mockResolvedValue([]);

            const sections = await service.buildRepoSections(
                ORG,
                ['acme/quiet', 'acme/active'],
                START,
                END,
            );

            expect(sections).toHaveLength(1);
            expect(sections[0].repository).toBe('acme/active');
        });
    });

    describe('buildOrgReport', () => {
        beforeEach(() => {
            review.getReviewOperationalMetrics.mockResolvedValue(
                opsMetrics(412),
            );
            codeHealth.getImplementationRate.mockResolvedValue({
                suggestionsSent: 1000,
                suggestionsImplemented: 460,
                implementationRate: 0.46,
            });
            review.getImplementationRateBySeverity.mockResolvedValue([
                { severity: 'critical', sent: 60, implemented: 47 },
            ]);
            productivity.getLeadTimeHighlight.mockResolvedValue({
                currentPeriod: { leadTimeP75Hours: 33.6 },
                comparison: { trend: 'improved', percentageChange: -8 },
            });
        });

        it('bails before the heavy fan-out for an org with no activity', async () => {
            review.getReviewOperationalMetrics.mockResolvedValue(
                opsMetrics(0),
            );

            const report = await service.buildOrgReport(
                ORG,
                'Acme',
                START,
                END,
            );

            expect(report.reviews).toBe(0);
            expect(report.repoRanking).toEqual([]);
            expect(report.rulesNeedingAttention).toEqual([]);
            // Did not pay for the ~12-query warehouse fan-out.
            expect(codeHealth.getImplementationRate).not.toHaveBeenCalled();
            expect(review.getRepositoriesHealth).not.toHaveBeenCalled();
            expect(review.getKodyRulesUsage).not.toHaveBeenCalled();
        });

        it('ranks only repos with >=10 reviews, by implementation rate', async () => {
            review.getRepositoriesHealth.mockResolvedValue([
                {
                    repository: 'acme/small',
                    prsReviewed: 8,
                    implementationRate: 0.9,
                },
                {
                    repository: 'acme/auth',
                    prsReviewed: 12,
                    implementationRate: 0.6,
                },
                {
                    repository: 'acme/legacy',
                    prsReviewed: 20,
                    implementationRate: 0.5,
                },
            ]);

            const report = await service.buildOrgReport(
                ORG,
                'Acme',
                START,
                END,
            );

            expect(report.criticalImplemented).toBe(47);
            expect(report.prCycleTimeHours).toBe(33.6);
            expect(report.repoRanking.map((r) => r.repository)).toEqual([
                'acme/auth',
                'acme/legacy',
            ]);
            expect(report.repoRanking[0].rank).toBe(1);
            // 'acme/small' (8 reviews) is excluded despite the best rate.
            expect(
                report.repoRanking.find((r) => r.repository === 'acme/small'),
            ).toBeUndefined();
        });

        it('surfaces the biggest implementation-rate growth as a highlight', async () => {
            // Ranking call + highlights(current) share the current window;
            // highlights(previous) uses the earlier window. Distinguish by date.
            review.getRepositoriesHealth.mockImplementation((q: any) =>
                Promise.resolve(
                    q.startDate === START
                        ? [
                              {
                                  repository: 'acme/auth',
                                  prsReviewed: 30,
                                  implementationRate: 0.68,
                              },
                          ]
                        : [
                              {
                                  repository: 'acme/auth',
                                  prsReviewed: 25,
                                  implementationRate: 0.54,
                              },
                          ],
                ),
            );

            const report = await service.buildOrgReport(
                ORG,
                'Acme',
                START,
                END,
            );

            expect(report.highlights).toHaveLength(1);
            expect(report.highlights[0].repository).toBe('acme/auth');
            expect(report.highlights[0].detail).toContain('+14pp');
        });
    });
});

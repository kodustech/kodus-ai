// @ts-nocheck
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { GetEnrichedPullRequestsUseCase } from './get-enriched-pull-requests.use-case';

/**
 * Suggestion counting has two paths that MUST agree: the Mongo aggregation
 * (findSuggestionCountsByNumbersAndRepositoryIds, covered by
 * test/integration/platformData/pullRequests-aggregation.integration.spec.ts)
 * and this in-memory fallback. The integration side needs a live Mongo, so
 * these unit cases are the ones that run on every machine and every CI job —
 * they pin the fallback's half of the contract, `firstSentSuggestion`
 * included.
 */
describe('GetEnrichedPullRequestsUseCase.extractSuggestionsCount', () => {
    // extractSuggestionsCount touches no injected dependency, so skip the
    // 7-token constructor rather than mocking services this has nothing to do
    // with.
    const useCase = Object.create(
        GetEnrichedPullRequestsUseCase.prototype,
    ) as GetEnrichedPullRequestsUseCase;

    const extract = (pullRequest: unknown) =>
        (useCase as any).extractSuggestionsCount(pullRequest);

    const file = (path: string, suggestions: unknown[]) => ({
        path,
        suggestions,
    });

    describe('firstSentSuggestion (PR-list deep-link target)', () => {
        it('prefers an unresolved critical over a low that comes first', () => {
            const counts = extract({
                files: [
                    file('src/a.ts', [
                        { id: 'low', deliveryStatus: DeliveryStatus.SENT, severity: 'low' },
                    ]),
                    file('src/b.ts', [
                        { id: 'crit', deliveryStatus: DeliveryStatus.SENT, severity: 'critical' },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion).toEqual({
                id: 'crit',
                filePath: 'src/b.ts',
            });
        });

        it('prefers any open finding over an applied one, however severe', () => {
            // Landing someone on a critical they already fixed is worse than
            // landing them on the low still waiting for them.
            const counts = extract({
                files: [
                    file('src/a.ts', [
                        {
                            id: 'crit-done',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'critical',
                            implementationStatus: 'implemented',
                        },
                        {
                            id: 'low-open',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'low',
                        },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion?.id).toBe('low-open');
        });

        it('falls back to the most severe finding when everything is applied', () => {
            const counts = extract({
                files: [
                    file('src/a.ts', [
                        {
                            id: 'low-done',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'low',
                            implementationStatus: 'implemented',
                        },
                        {
                            id: 'high-done',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'high',
                            implementationStatus: 'implemented',
                        },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion?.id).toBe('high-done');
        });

        it('keeps document order when the rank ties', () => {
            const counts = extract({
                files: [
                    file('src/a.ts', [
                        { id: 'first', deliveryStatus: DeliveryStatus.SENT, severity: 'high' },
                        { id: 'second', deliveryStatus: DeliveryStatus.SENT, severity: 'high' },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion?.id).toBe('first');
        });

        it('picks the earliest DELIVERED suggestion even when a filtered one comes first', () => {
            // The regression this guards: a PR whose first suggestion was
            // filtered out used to yield no deep-link target at all, so the
            // count click fell back to the top of the diff.
            const counts = extract({
                files: [
                    file('src/file0.ts', [
                        { id: 's0', deliveryStatus: DeliveryStatus.NOT_SENT },
                        { id: 's1', deliveryStatus: DeliveryStatus.SENT },
                        { id: 's2', deliveryStatus: DeliveryStatus.SENT },
                    ]),
                    file('src/file1.ts', [
                        { id: 's3', deliveryStatus: DeliveryStatus.SENT },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion).toEqual({
                id: 's1',
                filePath: 'src/file0.ts',
            });
        });

        it('carries the file path of the file the suggestion belongs to', () => {
            const counts = extract({
                files: [
                    file('src/first.ts', [
                        { id: 's0', deliveryStatus: DeliveryStatus.NOT_SENT },
                    ]),
                    file('src/second.ts', [
                        { id: 's1', deliveryStatus: DeliveryStatus.SENT },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion).toEqual({
                id: 's1',
                filePath: 'src/second.ts',
            });
        });

        it('skips legacy suggestions with no id — a deep link needs one', () => {
            const counts = extract({
                files: [
                    file('src/file0.ts', [
                        { deliveryStatus: DeliveryStatus.SENT },
                        { id: '', deliveryStatus: DeliveryStatus.SENT },
                        { id: 's2', deliveryStatus: DeliveryStatus.SENT },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion).toEqual({
                id: 's2',
                filePath: 'src/file0.ts',
            });
        });

        it('is null when nothing was delivered', () => {
            const counts = extract({
                files: [
                    file('src/file0.ts', [
                        { id: 's0', deliveryStatus: DeliveryStatus.NOT_SENT },
                        { id: 's1', deliveryStatus: DeliveryStatus.FAILED },
                        { id: 's2', deliveryStatus: DeliveryStatus.REPLACED },
                    ]),
                ],
            });

            expect(counts.firstSentSuggestion).toBeNull();
        });

        it('is null for a PR with no files at all', () => {
            expect(extract({ files: [] }).firstSentSuggestion).toBeNull();
            expect(extract({}).firstSentSuggestion).toBeNull();
        });

        it('passes the aggregation-precomputed target straight through', () => {
            const counts = extract({
                suggestionsCount: {
                    sent: 3,
                    filtered: 1,
                    firstSentSuggestion: {
                        id: 'from-aggregation',
                        filePath: 'src/agg.ts',
                    },
                },
            });

            expect(counts.firstSentSuggestion).toEqual({
                id: 'from-aggregation',
                filePath: 'src/agg.ts',
            });
        });

        it('is null when precomputed counts predate the deep-link field', () => {
            const counts = extract({
                suggestionsCount: { sent: 3, filtered: 1 },
            });

            expect(counts.firstSentSuggestion).toBeNull();
        });
    });

    describe('counting parity', () => {
        it('buckets every delivery status and does not let the deep-link scan skew totals', () => {
            const counts = extract({
                files: [
                    file('src/a.ts', [
                        {
                            id: 's0',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'HIGH',
                            label: 'Security',
                        },
                        { id: 's1', deliveryStatus: DeliveryStatus.NOT_SENT },
                        { id: 's2', deliveryStatus: DeliveryStatus.FAILED },
                        {
                            id: 's3',
                            deliveryStatus:
                                DeliveryStatus.FAILED_LINES_MISMATCH,
                        },
                        { id: 's4', deliveryStatus: DeliveryStatus.REPLACED },
                    ]),
                    file('src/b.ts', [
                        {
                            id: 's5',
                            deliveryStatus: DeliveryStatus.SENT,
                            severity: 'low',
                            implementationStatus: 'implemented',
                        },
                    ]),
                ],
            });

            expect(counts.sent).toBe(2);
            expect(counts.filtered).toBe(1);
            expect(counts.failed).toBe(2);
            expect(counts.replaced).toBe(1);
            // Severity is normalized, so 'HIGH' and 'low' land in the same
            // buckets the aggregation's $toLower produces.
            expect(counts.bySeverity).toEqual({
                critical: 0,
                high: 1,
                medium: 0,
                low: 1,
            });
            // s5 is implemented, so only s0 still needs attention.
            expect(counts.unresolved).toBe(1);
            expect(counts.unresolvedBySeverity.high).toBe(1);
            expect(counts.categories).toEqual(['security']);
        });
    });
});

/**
 * SuggestionService — pure prioritization & filtering logic.
 *
 * This 2k-line service had no spec, yet it owns the deterministic core that
 * decides which suggestions a reviewer ever sees and in what order: the rank
 * score, the priority sort, the review-option filter, and the discard bookkeeping
 * that stamps dropped suggestions so they are audited rather than lost. None of
 * it touches the LLM or a platform client. A regression here silently reorders
 * or drops real findings. Built with inert deps and driven directly.
 */

import { SuggestionService } from './suggestion.service';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import {
    ClusteringType,
    GroupingModeSuggestions,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

const svc = () =>
    new SuggestionService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
    ) as any;

describe('SuggestionService — pure logic', () => {
    describe('normalizeLabel', () => {
        it('lowercases and turns whitespace runs into single underscores', () => {
            expect(svc().normalizeLabel('Potential   Error')).toBe(
                'potential_error',
            );
        });
        it('returns an empty string for a nullish label', () => {
            expect(svc().normalizeLabel(null)).toBe('');
            expect(svc().normalizeLabel(undefined)).toBe('');
        });
    });

    describe('filterSuggestionProperties', () => {
        it('projects only the five fields the implemented-analysis needs', () => {
            const out = svc().filterSuggestionProperties([
                {
                    id: 's1',
                    relevantFile: 'a.ts',
                    language: 'ts',
                    improvedCode: 'b',
                    existingCode: 'a',
                    severity: 'high', // must be dropped
                    suggestionContent: 'noise', // must be dropped
                },
            ]);
            expect(out).toEqual([
                {
                    id: 's1',
                    relevantFile: 'a.ts',
                    language: 'ts',
                    improvedCode: 'b',
                    existingCode: 'a',
                },
            ]);
        });
    });

    describe('filterCodeSuggestionsByReviewOptions', () => {
        it('keeps only suggestions whose normalized label is enabled (=== true) in config', () => {
            const config = { security: true, code_style: false };
            const out = svc().filterCodeSuggestionsByReviewOptions(config, {
                codeSuggestions: [
                    { id: '1', label: 'Security' }, // enabled (normalized)
                    { id: '2', label: 'Code Style' }, // disabled
                    { id: '3', label: 'Maintainability' }, // absent → not true
                ],
            });
            expect(out.codeSuggestions.map((s: any) => s.id)).toEqual(['1']);
        });
    });

    describe('getDiscardedSuggestions', () => {
        it('returns all-minus-filtered, requires an id, and stamps NOT_SENT + reason', () => {
            const out = svc().getDiscardedSuggestions(
                [{ id: '1' }, { id: '2' }, { noId: true }],
                [{ id: '2' }],
                PriorityStatus.DISCARDED_BY_QUANTITY,
            );
            expect(out).toEqual([
                {
                    id: '1',
                    deliveryStatus: DeliveryStatus.NOT_SENT,
                    priorityStatus: PriorityStatus.DISCARDED_BY_QUANTITY,
                },
            ]);
        });

        it('getDiscardedByQuantity delegates with the DISCARDED_BY_QUANTITY reason', () => {
            const out = svc().getDiscardedByQuantity(
                [{ id: '1' }, { id: '2' }],
                [{ id: '1' }],
            );
            expect(out).toHaveLength(1);
            expect(out[0].id).toBe('2');
            expect(out[0].priorityStatus).toBe(
                PriorityStatus.DISCARDED_BY_QUANTITY,
            );
        });
    });

    describe('calculateSuggestionRankScore', () => {
        it('adds the category weight and the severity modifier', async () => {
            // security(50) + high(30) = 80
            await expect(
                svc().calculateSuggestionRankScore({
                    label: 'security',
                    severity: SeverityLevel.HIGH,
                }),
            ).resolves.toBe(80);
        });

        it('treats an unknown label or severity as a zero contribution', async () => {
            // unknown label(0) + critical(50) = 50
            await expect(
                svc().calculateSuggestionRankScore({
                    label: 'not_a_category',
                    severity: SeverityLevel.CRITICAL,
                }),
            ).resolves.toBe(50);
            // kody_rules(100) + unknown severity(0) = 100
            await expect(
                svc().calculateSuggestionRankScore({
                    label: 'kody_rules',
                    severity: 'weird' as any,
                }),
            ).resolves.toBe(100);
        });
    });

    describe('sortSuggestionsByPriority', () => {
        it('sorts by rankScore descending, breaking ties by category priority', () => {
            const out = svc().sortSuggestionsByPriority({} as any, 1, [
                { id: 'a', rankScore: 10, label: 'code_style' }, // tie, cat 9
                { id: 'b', rankScore: 20, label: 'maintainability' }, // highest score
                { id: 'c', rankScore: 10, label: 'security' }, // tie, cat 3 → before a
            ]);
            expect(out.map((s: any) => s.id)).toEqual(['b', 'c', 'a']);
        });

        it('sends an unknown category to the back of a tie', () => {
            const out = svc().sortSuggestionsByPriority({} as any, 1, [
                { id: 'x', rankScore: 5, label: 'mystery' }, // cat 999
                { id: 'y', rankScore: 5, label: 'kody_rules' }, // cat 1
            ]);
            expect(out.map((s: any) => s.id)).toEqual(['y', 'x']);
        });
    });

    describe('sortSuggestionsByFilePathAndSeverity', () => {
        const parent = (over: any) => ({
            clusteringInformation: { type: ClusteringType.PARENT },
            ...over,
        });
        const child = (over: any) => ({
            clusteringInformation: { type: ClusteringType.RELATED },
            ...over,
        });

        it('places parents first (severity desc) then non-parents (file asc, severity desc) in FULL mode', () => {
            const out = svc().sortSuggestionsByFilePathAndSeverity(
                [
                    child({
                        id: 'c-b-low',
                        relevantFile: 'b.ts',
                        severity: SeverityLevel.LOW,
                    }),
                    parent({ id: 'p-med', severity: SeverityLevel.MEDIUM }),
                    child({
                        id: 'c-a-high',
                        relevantFile: 'a.ts',
                        severity: SeverityLevel.HIGH,
                    }),
                    parent({ id: 'p-crit', severity: SeverityLevel.CRITICAL }),
                ],
                GroupingModeSuggestions.FULL,
            );
            // parents by severity desc: crit, med — then non-parents by file asc: a before b
            expect(out.map((s: any) => s.id)).toEqual([
                'p-crit',
                'p-med',
                'c-a-high',
                'c-b-low',
            ]);
        });
    });
});
